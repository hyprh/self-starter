// End to end with the real Codex CLI and a stand-in model, so that turns run
// without an account. A user talks to Codex in a thread (through `codex
// app-server`, the protocol the Codex app speaks) and has two triggers set up
// on a training log: one answers in that conversation, one in a thread of its
// own. The first run finishes while Codex is open, and Codex picks the fire up
// in the open thread. The user closes Codex in the middle of that turn, which
// leaves the conversation paused as Stop does; the second run finishes, and
// Self-Starter wakes both threads to handle their fires. Each fire must end
// with Codex calling trigger_report from the right thread.
// The plugin is installed the way the README says, with this checkout as the
// marketplace, and its first start installs the runtime from a tarball of this
// checkout. It uses its own Self-Starter and Codex folders and no background
// service: npm run build && node dist/test/e2e/agent.js

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon } from "../../src/client/client.js";
import { cliCommand, findCodex, loadConfig, saveConfig } from "../../src/engine/config.js";
import { AppServerSession, type RpcMessage } from "../../src/engine/app-server.js";
import { CodexCli } from "../../src/engine/codex.js";
import type { FireView } from "../../src/engine/service.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { callPluginTool, cli, createTrigger, installFromMarketplace, packRuntime, show, waitFor } from "./harness.js";

type Json = Record<string, any>;

const scratch = mkdtempSync(join(tmpdir(), "self-starter-agent-"));
const project = join(scratch, "project");
const log = join(project, "train.log");
process.env.SELF_STARTER_HOME = join(scratch, "home");
process.env.CODEX_HOME = join(scratch, "codex");
mkdirSync(project, { recursive: true });
mkdirSync(process.env.CODEX_HOME, { recursive: true });
writeFileSync(log, "epoch 1/3 loss 0.91\n");
const paths = resolvePaths();
const selfStarter = (args: string[]) => cli(process.env, args);
const codexBin = findCodex();
if (!codexBin) throw new Error("codex was not found; install the Codex CLI (npm install -g @openai/codex)");

const PROBE_EVENTS = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const text = await Deno.readTextFile(input.params.log).catch(() => "");
const finished = text.split("\\n").filter((line) => line.startsWith("Finished"));
console.log(JSON.stringify({ events: finished.map((line) => ({ key: line, summary: line })), summary: finished.length + " finished" }));
`;
const PROBE_STATE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const text = await Deno.readTextFile(input.params.log).catch(() => "");
const line = text.split("\\n").find((candidate) => candidate.startsWith(input.params.finished));
console.log(JSON.stringify({ fire: Boolean(line), summary: line ?? "still training" }));
`;
const interval = { min: "10s", default: "10s" };
const ORIGIN = {
  id: "training-runs",
  name: "Training runs",
  intent: "Whenever a training run finishes, summarize it here",
  probe: { params: { log }, interval },
  mode: "event",
  action: { type: "agent", prompt: "Summarize the finished run in one line." },
  // A trigger that can fire again gets a thread of its own unless it asks for the user's.
  target: { kind: "origin" },
};
const DEDICATED = {
  id: "second-run",
  name: "Second run",
  intent: "When the second run finishes, compare it with the first in a thread of its own",
  probe: { params: { log, finished: "Finished run 2" }, interval },
  mode: "state",
  action: { type: "agent", prompt: "Compare the two runs in one line." },
  target: { kind: "dedicated", cwd: project },
  policy: { max_fires: 1 },
};

/**
 * A stand-in for the model behind Codex, speaking the Responses API. It answers
 * a fire by calling trigger_report, and anything else with a short line. Its
 * last word on a fire takes a moment, so that a user who closes Codex as soon
 * as the report is in closes it in the middle of the turn.
 */
function standInModel(): Promise<Server> {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST") return response.end('{"object":"list","data":[]}');
    const { input = [], tools = [] } = JSON.parse(body || "{}") as { input?: Json[]; tools?: Json[] };
    // This turn's input: everything after the model's last answer. Codex can add its own user
    // messages after the fire (such as the environment of a thread resumed in another folder).
    const lastAnswer = input.map((item) => item.type === "message" && item.role === "assistant").lastIndexOf(true);
    const turn = input.slice(lastAnswer + 1);
    const said = turn
      .filter((item) => item.type === "message" && item.role === "user")
      .flatMap((item) => item.content ?? [])
      .map((part: Json) => part.text ?? "")
      .join("\n");
    const fireId = [...said.matchAll(/fire_id="(fire_[a-z0-9]+)"/g)].at(-1)?.[1];
    const reported = fireId !== undefined && input.some((item) => item.type === "function_call" && String(item.arguments).includes(fireId));
    if (fireId && reported) await new Promise((resolve) => setTimeout(resolve, 3000));
    const namespace = tools.find((tool) => tool.type === "namespace" && (tool.tools ?? []).some((f: Json) => f.name === "trigger_report"));

    const output: Json =
      fireId && !reported && namespace
        ? { type: "function_call", call_id: `call_${fireId}`, name: "trigger_report", namespace: namespace.name, arguments: JSON.stringify({ fire_id: fireId, summary: `Codex handled ${fireId}`, notify: true }) }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text: reported ? "Reported." : fireId ? `No trigger_report tool for ${fireId}.` : said.includes("This thread belongs to the trigger") ? "Ready." : "Hello." }] };
    const events = [
      { type: "response.created", response: { id: "resp" } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "resp", usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** The Codex app: an app server, here with no window. */
function openCodex(): Promise<AppServerSession> {
  const { command, prefix } = cliCommand(codexBin!);
  return AppServerSession.open(command, prefix, { cwd: project });
}

const turnCompleted = (threadId: string) => (message: RpcMessage) => message.method === "turn/completed" && message.params?.threadId === threadId;

async function lastFire(triggerId: string): Promise<FireView | undefined> {
  const fires = await callDaemon<FireView[]>(paths.socket, "fire.history", { triggerId, limit: 1 }, { via: "cli" });
  return fires[0];
}

/** Waits for the trigger's fire number `n` to be reported, and checks it was handled in `threadId`. */
async function reported(triggerId: string, n: number, threadId: string): Promise<FireView> {
  const fire = await waitFor(
    `fire #${n} of ${triggerId} to be reported`,
    async () => {
      const last = await lastFire(triggerId);
      return last && last.fireNumber === n && last.receipt ? last : undefined;
    },
    { timeoutMs: 180_000, explain: async () => `${await selfStarter(["show", triggerId])}\n\n${await selfStarter(["logs", "-n", "40"])}` },
  );
  if (fire.receipt?.summary !== `Codex handled ${fire.fireId}`) throw new Error(`fire ${fire.fireId} has the receipt ${JSON.stringify(fire.receipt)}`);
  if (fire.target?.threadId !== threadId) throw new Error(`fire ${fire.fireId} went to ${fire.target?.threadId}, not ${threadId}`);
  console.log(`✓ ${triggerId} #${n}: Codex reported from thread ${threadId}: ${fire.receipt.summary}`);
  return fire;
}

/** The status of each turn in a thread that handled the fire, as the Codex app lists them. */
async function turnsAbout(codex: AppServerSession, threadId: string, fireId: string): Promise<string[]> {
  const page = await codex.request("thread/turns/list", { threadId, limit: 10, itemsView: "full" });
  const turns: Json[] = page.data ?? [];
  return turns.filter((turn) => JSON.stringify(turn.items).includes(fireId)).map((turn) => String(turn.status));
}

async function main(): Promise<void> {
  const model = await standInModel();
  const { port } = model.address() as AddressInfo;
  writeFileSync(
    join(process.env.CODEX_HOME!, "config.toml"),
    `model = "stand-in"\nmodel_provider = "stand-in"\n\n[model_providers.stand-in]\nname = "Stand-in"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
  );
  let codex: AppServerSession | undefined;
  try {
    // No background service on the machine that runs the test: the daemon runs as a detached process.
    saveConfig(paths, { ...loadConfig(paths), service: false });
    process.env.SELF_STARTER_RUNTIME = packRuntime(scratch);
    show("codex plugin marketplace add, codex plugin add", installFromMarketplace(process.env));
    const status = JSON.parse(await callPluginTool(process.env, "service_status")) as { version: string; deno: string };
    console.log(`✓ the plugin's first start installed its runtime and started Self-Starter ${status.version} (deno: ${status.deno})`);

    // The user talks to Codex, and asks for the two triggers.
    codex = await openCodex();
    const threadId: string = (await codex.request("thread/start", { cwd: project })).thread.id;
    const userTurn = codex.listen(turnCompleted(threadId));
    await codex.request("turn/start", { threadId, input: [{ type: "text", text: "Watch train.log for me.", text_elements: [] }] });
    if (!(await userTurn.next(60_000))) throw new Error("the user's turn did not complete");
    show("(Codex, in the user's thread) trigger_draft, trigger_activate", await createTrigger(process.env, ORIGIN, PROBE_EVENTS, threadId));
    show("(Codex, in the user's thread) trigger_draft, trigger_activate", await createTrigger(process.env, DEDICATED, PROBE_STATE, threadId));
    const ownThread = await waitFor(
      "the dedicated thread",
      async () => (await callDaemon<{ threadId?: string | null }>(paths.socket, "trigger.get", { triggerId: DEDICATED.id }, { via: "cli" })).threadId ?? undefined,
      { timeoutMs: 60_000 },
    );
    console.log(`✓ the dedicated thread exists: ${ownThread}`);

    // The first run finishes while Codex is open: the open thread picks the fire up.
    appendFileSync(log, "Finished run 1 in 3h12m, loss 0.41\n");
    console.log(`\n$ echo "Finished run 1 ..." >> train.log   (Codex open)`);
    const first = await reported(ORIGIN.id, 1, threadId);

    // The user closes Codex while that turn is finishing, which leaves the thread paused, as Stop does.
    codex.close();
    const outside = new CodexCli(codexBin!);
    await waitFor("Codex to close", async () => ((await outside.inspectThread(threadId, "")).paused ? true : undefined), { timeoutMs: 20_000 });
    console.log("✓ closing Codex in the middle of the turn left the thread paused");
    appendFileSync(log, "epoch 1/3 loss 0.88\nFinished run 2 in 2h58m, loss 0.39\n");
    console.log(`\n$ echo "Finished run 2 ..." >> train.log   (Codex closed)`);
    const second = await reported(ORIGIN.id, 2, threadId);
    const own = await reported(DEDICATED.id, 1, ownThread);

    // Opening Codex again shows the answers in the threads, once their turns have ended.
    codex = await openCodex();
    for (const [thread, fire] of [[threadId, second], [ownThread, own]] as const) {
      await waitFor(
        `the turn that handled ${fire.fireId} to end`,
        async () => ((await turnsAbout(codex!, thread, fire.fireId)).includes("completed") ? true : undefined),
        { timeoutMs: 60_000, explain: async () => `thread ${thread} lists: ${(await turnsAbout(codex!, thread, fire.fireId)).join(", ") || "no such turn"}` },
      );
    }
    console.log("✓ opening Codex again shows both answers in their threads");
    const history = await selfStarter(["history"]);
    show("self-starter history", history);
    for (const [fire, where] of [[first, "your thread, open in Codex"], [second, "your thread, opened in the background"], [own, "its own thread, opened in the background"]] as const) {
      if (!history.includes(`${fire.receipt?.summary}  (${where})`)) throw new Error(`history does not say that ${fire.fireId} was answered in ${where}`);
    }
    console.log("✓ the history says where each answer happened");
  } finally {
    codex?.close();
    model.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  console.error(`\nself-starter logs:\n${await selfStarter(["logs", "-n", "60"]).catch((e: Error) => e.message)}`);
  process.exitCode = 1;
} finally {
  // The plugin and everything else live in the scratch folders; only the daemon runs outside them.
  await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
}
