// End to end with a real mail server. The email channel is set up through the
// CLI, as a user does, then a trigger made through the MCP server, as Codex
// makes one, fires and sends its result by email. Everything goes to a
// throwaway Ethereal mailbox (https://ethereal.email), which is read back over
// IMAP to check what arrived. It needs the network, so `npm test` leaves it out;
// the Email workflow runs it: npm run build && node dist/test/e2e/email.js

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import nodemailer, { type TestAccount, type TestAccountService } from "nodemailer";

type Json = Record<string, any>;

const CLI = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "self-starter-email-"));
const env = { ...process.env, SELF_STARTER_HOME: home };

const TRIGGER = "email-e2e";
const DEFINITION = {
  id: TRIGGER,
  name: "Email check",
  intent: "Email me the result of the end-to-end check",
  probe: { params: { runner: hostname() } },
  mode: "state",
  action: { type: "notify" },
  notify: { channels: ["email"] },
  policy: { max_fires: 1 },
};
const PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
console.log(JSON.stringify({ fire: true, summary: "the probe ran on " + input.params.runner }));
`;

/** What the mailbox should receive, by the start of each subject. */
const EXPECTED = {
  "the test email of `channel email`": "[Self-Starter] Test email:",
  "`channel test email`": "[Self-Starter] Self-Starter test:",
  "the trigger's fire": `[Self-Starter] ${DEFINITION.name}: the probe ran on`,
};

/** Runs the CLI as a user would in a terminal, with `input` typed at its prompt. */
function cli(args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`self-starter ${args.join(" ")} exited with ${code}: ${output.trim()}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Talks to `self-starter mcp` over stdio, the way Codex does, from a user's turn in one thread. */
class Mcp {
  private readonly child = spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
  private readonly waiting = new Map<number, { resolve: (message: Json) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readonly meta = {
    threadId: "email-e2e-thread",
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "email-e2e-thread", turn_id: "turn-1", turn_trigger: "user" }),
  };

  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Json;
      if (typeof message.id !== "number") return;
      this.waiting.get(message.id)?.resolve(message);
      this.waiting.delete(message.id);
    });
    this.child.on("close", (code) => {
      for (const { reject } of this.waiting.values()) reject(new Error(`self-starter mcp exited with ${code}`));
      this.waiting.clear();
    });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async tool(name: string, args: Json): Promise<string> {
    const { result, error } = await this.request("tools/call", { name, arguments: args, _meta: this.meta });
    const text: string = result?.content?.[0]?.text ?? error?.message ?? "no answer";
    if (error || result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  }

  close(): void {
    this.child.stdin.end();
  }
}

const firstLine = (text: string) => text.split("\n")[0]!;
const quote = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;

/** Just enough IMAP to read every message in a mailbox. */
class Imap {
  private received = "";
  private waiter: { pattern: RegExp; resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  private tags = 0;

  private constructor(private readonly socket: TLSSocket) {
    // latin1 keeps one character per byte, so the {size} of a literal counts characters.
    socket.on("data", (chunk: Buffer) => {
      this.received += chunk.toString("latin1");
      this.settle();
    });
    socket.on("error", (error) => this.settle(error));
  }

  static async open({ host, port }: TestAccountService): Promise<Imap> {
    const imap = new Imap(connect({ host, port }));
    await once(imap.socket, "secureConnect");
    await imap.until(/^\* OK/m);
    return imap;
  }

  /** Hands what was received to the waiting call once it matches, or the error. */
  private settle(error?: Error): void {
    const waiter = this.waiter;
    if (!waiter || (!error && !waiter.pattern.test(this.received))) return;
    this.waiter = undefined;
    if (error) return waiter.reject(error);
    waiter.resolve(this.received);
    this.received = "";
  }

  private until(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(new Error("the IMAP server stopped answering")), timeoutMs);
      const stop = <T>(settle: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        settle(value);
      };
      this.waiter = { pattern, resolve: stop(resolve), reject: stop(reject) };
      this.settle();
    });
  }

  async command(command: string): Promise<string> {
    const tag = `a${++this.tags}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const response = await this.until(new RegExp(`^${tag} (?:OK|NO|BAD)`, "m"));
    // Only the verb goes into the error: LOGIN carries the password.
    if (!new RegExp(`^${tag} OK`, "m").test(response)) throw new Error(`IMAP ${command.split(" ")[0]} failed: ${response.trim().split("\r\n").pop()}`);
    return response;
  }

  /** The raw messages in all folders. */
  async messages(): Promise<string[]> {
    const listed = await this.command('LIST "" "*"');
    const folders = [...listed.matchAll(/^\* LIST \(([^)]*)\) \S+ (.+)$/gm)].filter(([, flags]) => !/\\Noselect/i.test(flags!)).map(([, , name]) => name!.trim());
    const messages: string[] = [];
    for (const folder of folders) {
      if (/^\* 0 EXISTS/m.test(await this.command(`EXAMINE ${folder}`))) continue;
      const fetched = await this.command("FETCH 1:* (BODY.PEEK[])");
      for (const match of fetched.matchAll(/BODY\[\] \{(\d+)\}\r\n/g)) {
        const start = match.index + match[0].length;
        messages.push(Buffer.from(fetched.slice(start, start + Number(match[1])), "latin1").toString("utf8"));
      }
    }
    return messages;
  }

  close(): void {
    this.socket.end();
  }
}

async function readMailbox(account: TestAccount): Promise<string[]> {
  const imap = await Imap.open(account.imap);
  try {
    await imap.command(`LOGIN ${quote(account.user)} ${quote(account.pass)}`);
    return await imap.messages();
  } finally {
    imap.close();
  }
}

function subjectOf(message: string): string {
  const head = (message.split("\r\n\r\n")[0] ?? "").replace(/\r\n[ \t]+/g, " ");
  return /^Subject: (.*)$/im.exec(head)?.[1]?.trim() ?? "(no subject)";
}

function textOf(message: string): string {
  const [head = "", ...rest] = message.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  if (!/^Content-Transfer-Encoding: quoted-printable/im.test(head)) return body.trim();
  const bytes = body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8").trim();
}

/** Reads the mailbox until a message has come for each expected subject. */
async function waitForMail(account: TestAccount, timeoutMs = 120_000): Promise<Map<string, string>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await readMailbox(account);
    const found = new Map<string, string>();
    for (const [what, prefix] of Object.entries(EXPECTED)) {
      const message = messages.find((candidate) => subjectOf(candidate).startsWith(prefix));
      if (message) found.set(what, message);
    }
    if (found.size === Object.keys(EXPECTED).length) return found;
    if (Date.now() > deadline) {
      const missing = Object.keys(EXPECTED).filter((what) => !found.has(what));
      const subjects = messages.map(subjectOf).map((subject) => `  ${subject}`).join("\n") || "  (none)";
      const show = await cli(["show", TRIGGER]).catch((error: Error) => error.message);
      const logs = await cli(["logs", "-n", "30"]).catch((error: Error) => error.message);
      throw new Error(`no email for ${missing.join(", ")}. The mailbox has:\n${subjects}\n\n${show}\n\nDaemon log:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main(): Promise<void> {
  const account = await nodemailer.createTestAccount();
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${account.pass}`);
  console.log(`Mailbox: ${account.user}\n`);

  const { host, port, secure } = account.smtp;
  console.log(`$ self-starter channel email ${account.user} --host ${host} --port ${port}${secure ? "" : " --starttls"}`);
  console.log(await cli(["channel", "email", account.user, "--host", host, "--port", String(port), ...(secure ? [] : ["--starttls"])], `${account.pass}\n`));
  console.log("\n$ self-starter channel test email");
  console.log(await cli(["channel", "test", "email"]));

  console.log("\nCodex, through MCP: trigger_draft, then trigger_activate");
  const mcp = new Mcp();
  try {
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "email-e2e", version: "1" } });
    const draft = await mcp.tool("trigger_draft", { definition: DEFINITION, code: PROBE });
    const draftId = /Draft (\S+) saved/.exec(draft)?.[1];
    if (!draftId) throw new Error(`trigger_draft returned no draft id: ${draft}`);
    const activated = await mcp.tool("trigger_activate", { draft_id: draftId });
    console.log(`${firstLine(draft)}\n${firstLine(activated)}`);
  } finally {
    mcp.close();
  }

  const found = await waitForMail(account);
  console.log("\nThe mailbox received:");
  for (const [what, message] of found) console.log(`  ${what}: ${subjectOf(message)}`);
  console.log(`\nThe fire's email:\n${textOf(found.get("the trigger's fire")!)}`);
  console.log(`\n$ self-starter history ${TRIGGER}\n${await cli(["history", TRIGGER])}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await cli(["service", "stop"]).catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
}
