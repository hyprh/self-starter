// End to end with the real Claude Code CLI and a stand-in model, so that turns
// run without an account. A user talks to Claude in an interactive session (in
// tmux), answers its permission prompts, and has three triggers set up on flag
// files: two answer in that session, one in a session of its own. The first flag
// appears while Claude is busy with something else the user asked: the fire
// waits for that turn to end, then arrives in the session as a message from
// another session, posted by the plugin's MCP server. The user quits; the other
// two flags appear, and Self-Starter resumes the sessions headless (`claude -p
// --resume`). Each fire must end with Claude calling trigger_report from the
// right session, without a permission prompt, and the fire's turn must not be
// able to create triggers.
// The plugin is installed the way the README says, with this checkout as the
// marketplace, and its first start installs the runtime from a tarball of this
// checkout, under Claude Code's usual 30-second wait. It uses its own
// Self-Starter and Claude Code folders and no background service. Needs claude
// and tmux: npm run build && node dist/test/e2e/cc-agent.js

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon } from "../../src/client/client.js";
import { saveConfig, loadConfig, which } from "../../src/engine/config.js";
import { resolvePaths } from "../../src/engine/paths.js";
import type { FireView } from "../../src/engine/service.js";
import { findClaude, relaySocket } from "../../src/engine/sessions.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { cli, packRuntime, show, waitFor } from "./harness.js";

type Json = Record<string, any>;

const claudeBin = findClaude();
if (!claudeBin) throw new Error("claude was not found; install Claude Code (npm install -g @anthropic-ai/claude-code)");
if (!which("tmux")) throw new Error("tmux was not found; the interactive session runs in it");

const scratch = mkdtempSync(join(tmpdir(), "ss-cc-"));
// By its real path, which Claude Code trusts folders by (the temporary folder of macOS is behind a symlink).
const project = join(realpathSync(scratch), "project");
const userHome = join(scratch, "user");
const configDir = join(scratch, "claude");
const flags = { open: join(project, "flag-open"), closed: join(project, "flag-closed"), own: join(project, "flag-own") };
for (const dir of [project, userHome, configDir]) mkdirSync(dir, { recursive: true });
process.env.SELF_STARTER_HOME = join(scratch, "self-starter");
const paths = resolvePaths();
const selfStarter = (args: string[]) => cli(process.env, args);
const tmuxServer = `ss-e2e-${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", tmuxServer, ...args], { encoding: "utf8" });

const PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const text = await Deno.readTextFile(input.params.flag).catch(() => undefined);
console.log(JSON.stringify({ fire: text !== undefined, summary: text === undefined ? "no flag yet" : "flag: " + text.trim() }));
`;
const watch = (id: string, flag: string, kind: "origin" | "dedicated") => ({
  id,
  name: `Flag ${id}`,
  intent: `Tell me when ${flag} appears`,
  probe: { params: { flag }, interval: { min: "10s", default: "10s" } },
  mode: "state",
  policy: { max_fires: 1 },
  action: { type: "agent", prompt: "Say what the flag file says.", sandbox: "read-only" },
  target: { kind, cwd: project },
});
const WATCHES: Record<string, Json> = {
  open: watch("flag-open", flags.open, "origin"),
  closed: watch("flag-closed", flags.closed, "origin"),
  own: watch("flag-own", flags.own, "dedicated"),
};

// ---- the stand-in model: the Messages API, streamed, playing a small script ----

/** What the stand-in did, by session and when: fires it reported, refusals it got, trigger sessions it confirmed, a slow turn. */
const seen: Array<{ kind: "report" | "refused" | "seed" | "slow-start" | "slow-done"; session: string; detail: string; at: number }> = [];
const note = (kind: (typeof seen)[number]["kind"], session: string, detail = "") => seen.push({ kind, session, detail, at: Date.now() });
type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Json };
/** How long the user's slow request keeps Claude busy. */
const SLOW_TURN_MS = 25_000;
let toolUses = 0;
const offeredTools = new Set<string>();

const contentOf = (message: Json | undefined): Json[] =>
  typeof message?.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message?.content) ? message.content : [];
const textOf = (blocks: Json[]): string =>
  blocks.map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? textOf(contentOf(block)) : "")).join("\n");

function respond(request: Json, session: string): Block[] | { blocks: Block[]; delayMs: number } {
  const tools: string[] = (request.tools ?? []).map((tool: Json) => tool.name);
  for (const name of tools) offeredTools.add(name);
  const tool = (name: string) => tools.find((candidate) => candidate.endsWith(`__${name}`));
  if (!tool("trigger_report")) return [{ type: "text", text: "OK" }]; // a side request, such as a title
  const messages: Json[] = request.messages ?? [];
  const at = messages.map((message) => message.role).lastIndexOf("user");
  const last = contentOf(messages[at]);
  const results = last.filter((block) => block.type === "tool_result");
  if (results.length > 0) {
    const called = contentOf(messages[at - 1]).find((block) => block.type === "tool_use")?.name ?? "";
    const output = textOf(results);
    if (called.endsWith("__trigger_draft")) {
      const draftId = /Draft (\S+) saved/.exec(output)?.[1];
      if (draftId) return [{ type: "tool_use", name: tool("trigger_activate")!, input: { draft_id: draftId } }];
      note("refused", session, output.split("\n")[0]!);
      return [{ type: "text", text: `Not allowed here: ${output.split("\n")[0]}` }];
    }
    // After reporting, the turn tries to create a trigger, as data in a fire could make it do; the engine refuses.
    if (called.endsWith("__trigger_report")) return [{ type: "tool_use", name: tool("trigger_draft")!, input: { definition: watch("injected", "/nowhere", "origin"), code: PROBE } }];
    return [{ type: "text", text: output.split("\n")[0] ?? "OK" }];
  }
  const said = textOf(last);
  const fireId = /fire_id="(fire_[a-z0-9]+)"/.exec(said)?.[1];
  if (fireId && said.includes("[self-starter]")) {
    note("report", session, fireId);
    return [{ type: "tool_use", name: tool("trigger_report")!, input: { fire_id: fireId, summary: `handled in session ${session}`, notify: false } }];
  }
  if (said.includes("belongs to the trigger")) {
    note("seed", session, /\(([a-z0-9-]+)\)\./.exec(said)?.[1] ?? "");
    return [{ type: "text", text: "Ready." }];
  }
  if (said.includes("think for a while")) {
    note("slow-start", session);
    return { blocks: [{ type: "text", text: "Done thinking." }], delayMs: SLOW_TURN_MS };
  }
  const asked = /set up the (\w+) watch/.exec(said)?.[1];
  if (asked && WATCHES[asked]) return [{ type: "tool_use", name: tool("trigger_draft")!, input: { definition: WATCHES[asked], code: PROBE } }];
  return [{ type: "text", text: "OK" }];
}

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

const model = createServer((request, response) => {
  void body(request).then(async (text) => {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
      return;
    }
    const parsed = JSON.parse(text) as Json;
    const session = String(request.headers["x-claude-code-session-id"] ?? "");
    const reply = respond(parsed, session);
    const [blocks, delayMs] = Array.isArray(reply) ? [reply, 0] : [reply.blocks, reply.delayMs];
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (delayMs > 0) note("slow-done", session);
    const usage = { input_tokens: 1, output_tokens: 1 };
    const send = (type: string, data: Json) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    send("message_start", { message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, usage } });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      } else {
        send("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${++toolUses}`, name: block.name, input: {} } });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      send("content_block_stop", { index });
    });
    const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
    send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage });
    send("message_stop", {});
    response.end();
  });
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;

// ---- an isolated Claude Code: its own home and config, the stand-in model, no telemetry ----

// An ephemeral credential for the loopback stand-in; never a provider API key.
const KEY = randomUUID();
writeFileSync(
  join(configDir, ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    hasSeenAutoDefaultNudge: true,
    officialMarketplaceAutoInstallAttempted: true,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
);
// Manual mode, with no rules: the user answers the permission prompts (in auto mode a classifier model
// would review each tool call, which the stand-in does not play).
writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));

// TMPDIR too: where the test, the daemon and the MCP server look for sockets whose paths are too long.
const passed = Object.entries(process.env).filter(([name]) => /PROXY|CA_CERT|CAFILE|SSL_CERT|EXTRA_CA|^TMPDIR$/i.test(name));
const environment: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: userHome,
  CLAUDE_CONFIG_DIR: configDir,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  ANTHROPIC_BASE_URL: modelUrl,
  ANTHROPIC_API_KEY: KEY,
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // The stand-in calls MCP tools directly rather than playing tool discovery.
  ENABLE_TOOL_SEARCH: "false",
  SELF_STARTER_HOME: paths.home,
  ...Object.fromEntries(passed.map(([name, value]) => [name, value ?? ""])),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
/** claude in that environment; also what the daemon runs for headless turns. */
const wrapper = join(scratch, "claude.sh");
const writeWrapper = (extra: Record<string, string>) =>
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec env -i ${Object.entries({ ...environment, ...extra }).map(([name, value]) => `${name}=${quote(value)}`).join(" ")} ${quote(claudeBin)} "$@"\n`,
    { mode: 0o755 },
  );
const claude = (args: string[]) => {
  const out = spawnSync(wrapper, args, { cwd: project, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`claude ${args.join(" ")} failed: ${out.error?.message ?? `${out.stdout}${out.stderr}`}`);
  return out.stdout.trim();
};

/** One fire, as the history shows it. */
async function fireOf(triggerId: string): Promise<FireView | undefined> {
  const fires = await callDaemon<FireView[]>(paths.socket, "fire.history", { triggerId }).catch(() => []);
  return fires.find((fire) => fire.status === "done" && fire.receipt?.source === "tool");
}
const explain = async () => {
  const history = await selfStarter(["history"]).catch((error: Error) => error.message);
  const logs = join(paths.logs, "daemon.log");
  return `${history}\nstand-in saw: ${JSON.stringify(seen)}\ntools offered: ${JSON.stringify([...offeredTools])}\n${existsSync(logs) ? readFileSync(logs, "utf8").split("\n").slice(-25).join("\n") : ""}`;
};
const screen = () => tmux("capture-pane", "-t", "user", "-p");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The user, answering Claude Code's permission prompts with Yes; what each prompt was for. */
const prompts: string[] = [];
let answering = true;
async function answerPrompts(): Promise<void> {
  while (answering) {
    const shown = spawnSync("tmux", ["-L", tmuxServer, "capture-pane", "-t", "user", "-p"], { encoding: "utf8" }).stdout ?? "";
    if (shown.includes("Do you want to proceed?")) {
      prompts.push(/self_starter — (.+?) \(MCP\)/.exec(shown)?.[1] ?? shown);
      spawnSync("tmux", ["-L", tmuxServer, "send-keys", "-t", "user", "Enter"]);
      await sleep(1500);
    }
    await sleep(250);
  }
}

try {
  writeWrapper({ SELF_STARTER_RUNTIME: packRuntime(scratch) });
  mkdirSync(paths.home, { recursive: true });
  // No background service here: the daemon starts the way it does without one.
  saveConfig(paths, { ...loadConfig(paths), service: false, claudeBin: wrapper });

  show(`claude plugin install self-starter --marketplace ${PACKAGE_ROOT}`, claude(["plugin", "install", "self-starter", "--marketplace", PACKAGE_ROOT]));

  console.log("\n1. In an interactive session, the user has three triggers set up.");
  tmux("new-session", "-d", "-s", "user", "-x", "200", "-y", "50", "-c", project, wrapper);
  await waitFor("the session's prompt", async () => (/^❯\s*$/m.test(screen()) ? true : undefined), { timeoutMs: 60_000, explain: async () => screen() });
  const user = answerPrompts();
  // The plugin's MCP server listens for fires once its first start has installed the runtime, on the relay socket
  // of the process that shows the session (in the temporary folder when the path would be too long, as on macOS).
  const relayListening = () =>
    existsSync(paths.inboxes) && readdirSync(paths.inboxes).some((name) => name.endsWith(".json") && existsSync(relaySocket(paths, name.slice(0, -".json".length))));
  await waitFor("the plugin's MCP server", async () => (relayListening() ? true : undefined), {
    timeoutMs: 300_000,
    everyMs: 2000,
    explain: async () => `${screen()}\n${existsSync(join(paths.logs, "install.log")) ? readFileSync(join(paths.logs, "install.log"), "utf8") : "no install log"}`,
  });
  const active = async (id: string) => ((await callDaemon<Json>(paths.socket, "trigger.get", { triggerId: id }).catch(() => undefined))?.lifecycle === "active" ? true : undefined);
  for (const name of ["open", "closed", "own"]) {
    const id = WATCHES[name]!.id as string;
    // Asked again if the tools were not there yet: Claude Code connects to the server a moment after it starts.
    for (let attempt = 1; !(await active(id)); attempt++) {
      tmux("send-keys", "-t", "user", "-l", `please set up the ${name} watch`);
      tmux("send-keys", "-t", "user", "Enter");
      try {
        await waitFor(`trigger ${id}`, () => active(id), { timeoutMs: 30_000, everyMs: 1000 });
      } catch (error) {
        if (attempt === 3) throw new Error(`${(error as Error).message}\n${screen()}\n${await explain()}`);
      }
    }
  }
  show("self-starter list", await selfStarter(["list"]));
  const own = await waitFor("the trigger's own session", async () => seen.find((entry) => entry.kind === "seed" && entry.detail === "flag-own")?.session, { timeoutMs: 120_000, explain });

  console.log("\n2. Claude is busy with something the user asked when the first flag appears: the fire waits for that turn, then comes in.");
  tmux("send-keys", "-t", "user", "-l", "please think for a while");
  tmux("send-keys", "-t", "user", "Enter");
  await waitFor("the slow turn", async () => seen.find((entry) => entry.kind === "slow-start"), { timeoutMs: 30_000 });
  writeFileSync(flags.open, "build finished\n");
  const open = await waitFor("the fire of flag-open", () => fireOf("flag-open"), { timeoutMs: 120_000, everyMs: 2000, explain: async () => `${screen()}\n${await explain()}` });
  const session = /handled in session (\S+)/.exec(open.receipt!.summary)?.[1];
  if (!session || open.target?.via !== "inbox" || open.wokenAt) throw new Error(`flag-open was not handled in the open session: ${JSON.stringify(open)}`);
  if (!readFileSync(join(paths.logs, "daemon.log"), "utf8").includes(`relayed into session ${session}`)) throw new Error("the fire did not go through the plugin's relay");
  const slowDone = seen.find((entry) => entry.kind === "slow-done")!.at;
  const reported = seen.find((entry) => entry.kind === "report" && entry.detail === open.fireId)!.at;
  if (!(Date.parse(open.firedAt) < slowDone && slowDone < reported)) {
    throw new Error(`the fire did not wait for the user's turn: fired ${open.firedAt}, turn over ${new Date(slowDone).toISOString()}, handled ${new Date(reported).toISOString()}`);
  }

  console.log("\n3. The user quits. The other two flags appear: Self-Starter resumes the sessions headless.");
  tmux("send-keys", "-t", "user", "-l", "/exit");
  tmux("send-keys", "-t", "user", "Enter");
  await waitFor("the session to end", async () => (spawnSync("tmux", ["-L", tmuxServer, "has-session", "-t", "user"]).status !== 0 ? true : undefined), { timeoutMs: 30_000 });
  const registry = () =>
    [paths.inboxes, paths.sessions].map((dir) => readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => `${name}: ${readFileSync(join(dir, name), "utf8").trim()}`).join("\n")).join("\n");
  await waitFor("its process to leave the registry", async () => (readdirSync(paths.inboxes).some((name) => name.endsWith(".json")) ? undefined : true), {
    timeoutMs: 15_000,
    explain: async () => registry(),
  });
  writeFileSync(flags.closed, "tests passed\n");
  writeFileSync(flags.own, "deploy done\n");
  const closed = await waitFor("the fire of flag-closed", () => fireOf("flag-closed"), { timeoutMs: 180_000, everyMs: 2000, explain });
  const dedicated = await waitFor("the fire of flag-own", () => fireOf("flag-own"), { timeoutMs: 180_000, everyMs: 2000, explain });
  if (closed.target?.via !== "headless" || !closed.wokenAt || !closed.receipt!.summary.endsWith(session)) throw new Error(`flag-closed was not handled in the user's session: ${JSON.stringify(closed)}`);
  if (dedicated.target?.via !== "headless" || !dedicated.receipt!.summary.endsWith(own) || dedicated.target.threadId !== `cc:${own}`) {
    throw new Error(`flag-own was not handled in its own session: ${JSON.stringify(dedicated)}`);
  }

  console.log("\n4. No fire's turn could create a trigger.");
  for (const fire of [open, closed, dedicated]) {
    const handler = /handled in session (\S+)/.exec(fire.receipt!.summary)![1];
    const refused = seen.find((entry) => entry.kind === "refused" && entry.session === handler && entry.detail.includes("Cannot create a trigger now"));
    if (!refused) throw new Error(`the turn of ${fire.fireId} was not refused a new trigger: ${JSON.stringify(seen)}`);
  }
  if (existsSync(join(paths.triggers, "injected"))) throw new Error("a fire's turn created a trigger");
  answering = false;
  await user;
  // Asked about creating and turning on triggers (Claude Code shortens the tools' titles); never about reporting a fire.
  const kinds = new Set(prompts.map((title) => (title.startsWith("Draft a") ? "draft" : title.startsWith("Activate a") ? "activate" : title)));
  if (kinds.size !== 2 || !kinds.has("draft") || !kinds.has("activate")) throw new Error(`unexpected permission prompts: ${JSON.stringify(prompts)}`);
  console.log(`\nThe user was asked ${prompts.length} time(s), only to draft and to turn on triggers.`);
  show("self-starter history", await selfStarter(["history"]));
  console.log("\nAll good: fires reached the open session through its inbox, and closed sessions headless, each reported from the right session.");
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).stack ?? String(error)}`);
  const message = ((error as Error).message ?? String(error)).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.error(`::error::${message}`);
  process.exitCode = 1;
} finally {
  answering = false;
  spawnSync("tmux", ["-L", tmuxServer, "kill-server"]);
  await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
  model.close();
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.error(`could not remove ${scratch}: ${(error as Error).message}`); // Claude Code may still be shutting down
  }
}
