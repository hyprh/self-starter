// Real OpenCode, an installed native plugin, and a local OpenAI-compatible
// model. No account or paid API is used. Run after npm run build:
// OPENCODE_BIN=/absolute/path/to/opencode node dist/test/e2e/opencode-agent.js
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOpenCodePlugin, openCodePluginPath } from "../../src/cli/install.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { cliCommand, DEFAULT_CONFIG, saveConfig } from "../../src/engine/config.js";
import { findOpenCode, OpenCodeCli } from "../../src/engine/opencode.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { waitFor } from "./harness.js";

type Json = Record<string, any>;
const bin = findOpenCode();
if (!bin) throw new Error("Set OPENCODE_BIN to an installed OpenCode CLI (tested with 1.19.3).");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ss-opencode-e2e-")));
const project = join(scratch, "project");
const user = join(scratch, "user");
const config = join(scratch, "config");
const customConfig = join(scratch, "custom-config");
const paths = resolvePaths(join(scratch, "self-starter"));
for (const dir of [project, user, config, customConfig]) mkdirSync(dir);
const eventsFile = join(project, "events.json");
writeFileSync(eventsFile, "[]\n");
const protectedFile = join(project, "protected.txt");
const protectedContent = "The read-only background turn must leave this file unchanged.\n";
writeFileSync(protectedFile, protectedContent);
const instructionsFile = join(project, "inline-instructions.md");
const instructionsMarker = "SELF_STARTER_JSONC_INSTRUCTIONS_APPLIED";
writeFileSync(instructionsFile, instructionsMarker);
const heartbeatFile = join(project, "heartbeat");
const toolPidFile = join(project, "heartbeat.pid");
const heartbeatScript = join(project, "heartbeat.mjs");
writeFileSync(heartbeatScript, `import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(toolPidFile)}, String(process.pid));
setInterval(() => appendFileSync(${JSON.stringify(heartbeatFile)}, 'x'), 50);
`);
const response = "SELF_STARTER_OPENCODE_SMOKE_OK";
const triggerId = "opencode-local-event";
const observations: Array<{ name: string; output: string }> = [];
const modelErrors: string[] = [];
let calls = 0;
let requests = 0;
let readOnlyRequests = 0;

const definition = {
  id: triggerId, name: "OpenCode local events", intent: "Report each local completion event",
  mode: "event", probe: { params: { file: eventsFile }, interval: { min: "10s", default: "1m" } },
  policy: { max_fires: 4 },
  action: { type: "agent", prompt: "Report this completion, then exercise the post-report mutation guard.", sandbox: "read-only" },
  target: { kind: "dedicated", cwd: project }, notify: { when: "never" },
};
const probe = `
  const input = JSON.parse(await new Response(Deno.stdin.readable).text());
  const events = JSON.parse(await Deno.readTextFile(input.params.file));
  console.log(JSON.stringify({ events, summary: events.length + " local completion events" }));
`;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: Json) => part.text ?? "").join("\n");
  return JSON.stringify(content ?? "");
}

// The model chooses actual tools advertised by OpenCode. An absent or broken
// plugin therefore fails the assertions instead of being hidden by a fake CLI.
const model = createServer(async (request, result) => {
  try {
    if (request.method !== "POST") {
      result.writeHead(200, { "content-type": "application/json" });
      result.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as Json;
    appendFileSync(join(scratch, "model-requests.jsonl"), JSON.stringify(input) + "\n");
    if (++requests > 60) throw new Error("The stand-in model exceeded its request budget");
    const messages: Json[] = input.messages ?? [];
    const last = messages.at(-1);
    const previous = messages.flatMap((message) => message.tool_calls ?? [])
      .find((call: Json) => call.id === last?.tool_call_id);
    const previousName: string | undefined = previous?.function?.name;
    const previousOutput = contentText(last?.content);
    if (last?.role === "tool" && previousName) observations.push({ name: previousName, output: previousOutput });
    const text = contentText([...messages].reverse().find((message) => message.role === "user")?.content);
    if (input.tools?.length) {
      assert.ok(messages.some((message) => contentText(message.content).includes(instructionsMarker)),
        "the real CLI and background runner both preserve the inline JSONC instructions");
    }
    const fireId = /fire_id="(fire_[a-z0-9]+)"/.exec(text)?.[1];
    let name: string | undefined;
    let args: Json = {};
    if (input.tools?.length && text.includes("SELF_STARTER_TIMEOUT")) {
      if (last?.role !== "tool") {
        name = "bash";
        const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        args = { command: `${quote(process.execPath)} ${quote(heartbeatScript)}`, description: "Write heartbeats until the action deadline", timeout: 120_000 };
      }
    } else if (input.tools?.length && fireId) {
      const advertised = new Set(input.tools.map((entry: Json) => entry.function?.name));
      assert.ok(advertised.has("read"), "the read-only fire can use the real OpenCode read tool");
      for (const forbidden of ["edit", "write", "apply_patch", "bash", "task"]) {
        assert.ok(!advertised.has(forbidden), `read-only permissions must remove ${forbidden} from the model's tools`);
      }
      readOnlyRequests++;
      if (last?.role !== "tool") {
        name = "read";
        args = { filePath: protectedFile };
      } else if (previousName === "read") {
        name = "trigger_report";
        args = { fire_id: fireId, summary: `OpenCode handled ${fireId}`, notify: false };
      } else if (previousName === "trigger_report") {
        // This tool is called in a later assistant step, after the receipt has
        // cleared threadBusy. The native turn provenance must still block it.
        name = "trigger_pause";
        args = { trigger_id: triggerId };
      }
    } else if (input.tools?.length && text.includes("SELF_STARTER_USER_SETUP")) {
      if (last?.role !== "tool") name = "service_status";
      else if (previousName === "service_status") {
        name = "trigger_draft";
        args = { definition, code: probe };
      } else if (previousName === "trigger_draft") {
        const draftId = /Draft (\S+) saved/.exec(previousOutput)?.[1];
        if (!draftId) throw new Error(`Native trigger_draft failed: ${previousOutput}`);
        name = "trigger_activate";
        args = { draft_id: draftId };
      }
    } else if (input.tools?.length && text.includes("SELF_STARTER_USER_RESUME") && last?.role !== "tool") {
      name = "service_status";
    }
    if (name && !input.tools.some((entry: Json) => entry.function?.name === name)) {
      throw new Error(`The installed native plugin did not advertise ${name}`);
    }
    const toolCalls = name ? [{ id: `call_${++calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] : undefined;
    const message = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: response };
    const base = { id: `chatcmpl-local-${requests}`, created: 1, model: "local-smoke" };
    result.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
    if (input.stream) {
      const delta = toolCalls ? { role: "assistant", tool_calls: toolCalls.map((call) => ({ index: 0, ...call })) } : message;
      for (const [part, finish] of [[delta, null], [{}, toolCalls ? "tool_calls" : "stop"]]) {
        result.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
      }
      result.end("data: [DONE]\n\n");
    } else {
      result.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    modelErrors.push(message);
    result.writeHead(500, { "content-type": "application/json" });
    result.end(JSON.stringify({ error: { message } }));
  }
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

// Remove inherited host settings and credentials before installing or starting
// anything. All OpenCode config, auth, cache, and databases live in scratch.
for (const name of Object.keys(process.env)) {
  if (/^(OPENCODE_|SELF_STARTER_|OPENAI_|ANTHROPIC_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  HOME: user, SELF_STARTER_HOME: paths.home, OPENCODE_BIN: bin,
  // spawn({ cwd }) retains the parent's PWD. Both CLI entry points must bind
  // the requested project explicitly instead of creating a session here.
  PWD: user,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(scratch, "data"),
  XDG_STATE_HOME: join(scratch, "state"), XDG_CACHE_HOME: join(scratch, "cache"),
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  npm_config_cache: join(scratch, "npm-cache"),
  OPENCODE_CONFIG_DIR: customConfig,
  OPENCODE_CONFIG_CONTENT: `{
    // OpenCode accepts JSONC here, including the trailing comma.
    "instructions": [${JSON.stringify(instructionsFile)}],
  }`,
});
const configDir = join(config, "opencode");
mkdirSync(configDir);
// The global directory only contains our managed loader. Losing the user's
// additional directory therefore removes the only model/provider configuration.
writeFileSync(join(customConfig, "opencode.json"), JSON.stringify({
  model: "local/local-smoke", small_model: "local/local-smoke", enabled_providers: ["local"],
  provider: { local: {
    npm: "@ai-sdk/openai-compatible", name: "Local smoke test",
    options: { baseURL: origin, apiKey: randomUUID() },
    models: { "local-smoke": { name: "Local smoke", tool_call: true, limit: { context: 100000, output: 4096 } } },
  } },
}));

const command = cliCommand(bin);
async function opencode(message: string, sessionId?: string): Promise<Json[]> {
  const args = ["run", "--format", "json", "--dir", project, ...(sessionId ? ["--session", sessionId] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.prefix, ...args], { cwd: project, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    child.stdin.end(message);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      appendFileSync(join(scratch, "host-cli.log"), JSON.stringify({ args, code, stdout, stderr }) + "\n");
      if (code !== 0) return reject(new Error(`opencode run exited ${code}: ${stderr || stdout}`));
      try { resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json)); }
      catch { reject(new Error(`OpenCode did not return JSONL: ${stdout}\n${stderr}`)); }
    });
  });
}

saveConfig(paths, { ...DEFAULT_CONFIG, service: false, opencodeBin: bin, agentRunTimeoutMinutes: 0.75 });
installOpenCodePlugin(paths);
assert.ok(existsSync(openCodePluginPath()), "the installer creates the globally discovered .js loader");
const daemon = await startDaemon({ paths });
let passed = false;
let timedRun: ReturnType<OpenCodeCli["run"]> | undefined;
try {
  const first = await opencode("SELF_STARTER_USER_SETUP: use service_status, draft the local event trigger, and activate its draft.");
  const sessionId: string = first[0]?.sessionID;
  assert.match(sessionId, /^ses_[A-Za-z0-9]+$/);
  assert.equal([...first].reverse().find((event) => event.type === "text")?.part.text, response);
  assert.equal(observations.filter((entry) => entry.name === "trigger_draft").length, 1);
  assert.equal(observations.filter((entry) => entry.name === "trigger_activate").length, 1);
  const created = daemon.store.loadTrigger(triggerId).definition;
  assert.equal(created.meta.origin_thread_id, `oc:${sessionId}`, "the plugin binds the real host session ID");
  assert.equal(created.target.cwd, project, "the plugin binds the real host working directory");
  const resumed = await opencode("SELF_STARTER_USER_RESUME: call service_status once, then confirm.", sessionId);
  assert.ok(resumed.every((event) => event.sessionID === sessionId), "the real CLI resumes the existing session");
  assert.equal(observations.filter((entry) => entry.name === "service_status").length, 2);
  const dedicated = await waitFor("OpenCode's dedicated result session", async () =>
    daemon.store.loadTrigger(triggerId).definition.target.thread_id ?? undefined,
  { timeoutMs: 60_000, explain: async () => readFileSync(join(paths.logs, "daemon.log"), "utf8") });
  assert.match(dedicated, /^oc:ses_[A-Za-z0-9]+$/);
  assert.notEqual(dedicated, `oc:${sessionId}`);
  let resultSession = dedicated;

  await daemon.engine.runNow(triggerId);
  for (const n of [1, 2, 3, 4]) {
    if (n === 3) {
      const deleted = spawnSync(command.command, [...command.prefix, "session", "delete", dedicated.slice(3)], {
        cwd: project, env: process.env, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(deleted.status, 0, `the native CLI deletes the result session: ${deleted.stderr || deleted.stdout}`);
    }
    writeFileSync(eventsFile, JSON.stringify(Array.from({ length: n }, (_, i) => ({ key: `finished-${i + 1}`, summary: `Local task ${i + 1} finished` }))));
    const fired = await daemon.engine.runNow(triggerId);
    assert.ok(fired?.fireId, `custom completion event ${n} produces a fire`);
    const fireId = fired.fireId;
    const completed = await waitFor(`OpenCode receipt ${n}`, async () => {
      const fire = daemon.fires.get(fireId);
      return fire?.receipt ? fire : undefined;
    }, { timeoutMs: 60_000, explain: async () => JSON.stringify({ observations, modelErrors }) + "\n" + readFileSync(join(paths.logs, "daemon.log"), "utf8") });
    assert.equal(completed.receipt?.source, "tool");
    assert.equal(completed.receipt?.summary, `OpenCode handled ${fireId}`);
    if (n === 3) {
      assert.notEqual(completed.target?.threadId, dedicated, "a deleted session is replaced before retrying the same fire");
      assert.match(completed.target?.threadId ?? "", /^oc:ses_[A-Za-z0-9]+$/);
      assert.equal(completed.failures, 1, "native resume validation produces one bounded retry");
      resultSession = completed.target!.threadId!;
      assert.equal(daemon.store.loadTrigger(triggerId).definition.target.thread_id, resultSession);
    } else assert.equal(completed.target?.threadId, resultSession, "successive fires resume the same dedicated session");
    assert.equal(completed.target?.via, "headless");
    await waitFor("the post-report guard and background CLI exit", async () =>
      observations.filter((entry) => entry.name === "trigger_pause").length >= n && daemon.executor.status().activeAgentRuns === 0 ? true : undefined,
    { timeoutMs: 60_000, explain: async () => JSON.stringify({ observations, modelErrors }) + "\n" + readFileSync(join(paths.logs, "daemon.log"), "utf8") });
  }
  const reports = observations.filter((entry) => entry.name === "trigger_report");
  assert.equal(reports.length, 4);
  for (const report of reports) assert.match(report.output, /Receipt recorded/);
  const guards = observations.filter((entry) => entry.name === "trigger_pause");
  assert.equal(guards.length, 4);
  for (const guard of guards) assert.match(guard.output, /Cannot pause a trigger now: this turn was started by Self-Starter/);
  const reads = observations.filter((entry) => entry.name === "read");
  assert.equal(reads.length, 4, "each fire executes the real read tool before reporting");
  for (const read of reads) assert.ok(read.output.includes(protectedContent.trim()), read.output);
  assert.ok(readOnlyRequests >= 16, "read-only permissions stay in force through each complete background turn");
  assert.equal(readFileSync(protectedFile, "utf8"), protectedContent);
  daemon.engine.stop();
  daemon.executor.close();
  timedRun = new OpenCodeCli(bin, paths.sessions, configDir).run({
    cwd: project, sessionId: resultSession.slice(3), message: "SELF_STARTER_TIMEOUT: run the heartbeat command until the deadline.",
    sandbox: "danger-full-access", timeoutMs: 15_000,
  });
  await waitFor("the real OpenCode shell tool", async () => existsSync(toolPidFile) && existsSync(heartbeatFile) ? true : undefined,
    { timeoutMs: 12_000, explain: async () => JSON.stringify({ observations, modelErrors }) });
  const timedOut = await timedRun;
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error!, /timed out/);
  const heartbeat = readFileSync(heartbeatFile, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(readFileSync(heartbeatFile, "utf8"), heartbeat, "the native detached shell tool stops at the action deadline");
  assert.equal(existsSync(join(paths.sessions, `${resultSession.slice(3)}.opencode.lock`)), false,
    "the session lease is released after the real tool stops");
  assert.deepEqual(modelErrors, []);
  passed = true;
  console.log("OpenCode: custom config, JSONC instructions, native plugin, event delivery, deleted-session recovery, permissions, receipts, post-report guards, and detached shell timeout passed.");
} finally {
  await timedRun;
  if (existsSync(toolPidFile)) {
    try { process.kill(Number(readFileSync(toolPidFile, "utf8")), "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await daemon.stop();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else console.error(`OpenCode test files retained at ${scratch}`);
}
