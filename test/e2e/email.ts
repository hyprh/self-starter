// End to end with a real mail server. The email channel is set up through the
// CLI, as a user does, then a trigger made through the MCP server, as Codex
// makes one, fires and sends its result by email. Everything goes to a
// throwaway Ethereal mailbox (https://ethereal.email), which is read back over
// IMAP to check what arrived. It needs the network, so `npm test` leaves it out;
// the Email workflow runs it: npm run build && node dist/test/e2e/email.js

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import nodemailer, { type TestAccount, type TestAccountService } from "nodemailer";
import { cli, createTrigger, show, waitFor } from "./harness.js";

const env = { ...process.env, SELF_STARTER_HOME: mkdtempSync(join(tmpdir(), "self-starter-email-")) };
const selfStarter = (args: string[], input?: string) => cli(env, args, input);

const DEFINITION = {
  id: "email-check",
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

/** The message for each expected subject, once all have arrived. */
async function expectedMail(account: TestAccount): Promise<Map<string, string> | undefined> {
  const messages = await readMailbox(account);
  const found = new Map<string, string>();
  for (const [what, prefix] of Object.entries(EXPECTED)) {
    const message = messages.find((candidate) => subjectOf(candidate).startsWith(prefix));
    if (message) found.set(what, message);
  }
  return found.size === Object.keys(EXPECTED).length ? found : undefined;
}

async function main(): Promise<void> {
  const account = await nodemailer.createTestAccount();
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${account.pass}`);
  console.log(`Mailbox: ${account.user}`);

  const { host, port, secure } = account.smtp;
  const setup = ["channel", "email", account.user, "--host", host, "--port", String(port), ...(secure ? [] : ["--starttls"])];
  show(`self-starter ${setup.join(" ")}`, await selfStarter(setup, `${account.pass}\n`));
  show("self-starter channel test email", await selfStarter(["channel", "test", "email"]));
  show("(Codex, through MCP) trigger_draft, trigger_activate", await createTrigger(env, DEFINITION, PROBE));

  const found = await waitFor("the emails", () => expectedMail(account), {
    timeoutMs: 120_000,
    everyMs: 5000,
    explain: async () => {
      const subjects = (await readMailbox(account)).map((message) => `  ${subjectOf(message)}`).join("\n") || "  (none)";
      const state = await selfStarter(["show", DEFINITION.id]).catch((error: Error) => error.message);
      const logs = await selfStarter(["logs", "-n", "30"]).catch((error: Error) => error.message);
      return `The mailbox has:\n${subjects}\n\n${state}\n\nDaemon log:\n${logs}`;
    },
  });
  console.log("\nThe mailbox received:");
  for (const [what, message] of found) console.log(`  ${what}: ${subjectOf(message)}`);
  console.log(`\nThe fire's email:\n${textOf(found.get("the trigger's fire")!)}`);
  show(`self-starter history ${DEFINITION.id}`, await selfStarter(["history", DEFINITION.id]));
}

try {
  await main();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await selfStarter(["service", "stop"]).catch(() => undefined);
  rmSync(env.SELF_STARTER_HOME, { recursive: true, force: true });
}
