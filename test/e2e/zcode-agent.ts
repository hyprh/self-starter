// Real ZCode CLI and a local stand-in model; no account or model API is used.
// Requires a configured CLI executable, but uses isolated user and data folders:
// ZCODE_BIN=/absolute/path/to/zcode node dist/test/e2e/zcode-agent.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMarketplace } from "../../src/cli/install.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { cliCommand, DEFAULT_CONFIG, saveConfig } from "../../src/engine/config.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { findZCode, ZCodeCli } from "../../src/engine/zcode.js";
import { waitFor } from "./harness.js";

type Json = Record<string, any>;
const bin = findZCode();
if (!bin) throw new Error("Set ZCODE_BIN to an installed ZCode CLI (Node.js 24.14.0 or newer).");
const scratch = mkdtempSync(join(tmpdir(), "ss-zcode-e2e-"));
const project = join(scratch, "project");
const user = join(scratch, "user");
const data = join(scratch, "data");
for (const dir of [project, user, data]) mkdirSync(dir);
const paths = resolvePaths(join(scratch, "self-starter"));
let replies = 0;
let toolCalls = 0;
const reportResults: string[] = [];
const response = "SELF_STARTER_NATIVE_SMOKE_OK";

const model = createServer(async (request, result) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body) as Json;
  const last = input.messages?.at(-1);
  const previousCall = input.messages?.flatMap((message: Json) => message.tool_calls ?? []).find((call: Json) => call.id === last?.tool_call_id);
  if (last?.role === "tool") {
    if (previousCall?.function.name.endsWith("trigger_report")) reportResults.push(String(last.content));
    else {
      assert.match(String(last.content), /"triggers"/);
      replies++;
    }
  }
  const userMessage = input.messages?.findLast((message: Json) => message.role === "user");
  const text = typeof userMessage?.content === "string" ? userMessage.content : userMessage?.content?.map((block: Json) => block.text ?? "").join("") ?? "";
  const fireId = /fire_id="(fire_[a-z0-9]+)"/.exec(text)?.[1];
  const tool = input.tools?.find((entry: Json) => entry.function?.name.endsWith(fireId ? "trigger_report" : "service_status"));
  const calls = tool && last?.role !== "tool" ? [{
    id: `call_${++toolCalls}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(fireId ? { fire_id: fireId, summary: "Observed the flag file", notify: false } : {}) },
  }] : undefined;
  const message = calls ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: response };
  const base = { id: "chatcmpl-local-smoke", created: 1, model: "local-smoke" };
  result.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
  if (input.stream) {
    const delta = calls ? { role: "assistant", tool_calls: calls.map((call: Json) => ({ index: 0, ...call })) } : message;
    for (const [part, finish] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) {
      result.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    result.end("data: [DONE]\n\n");
  } else result.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
const builtin = join(scratch, "builtin.json");
const personal = join(scratch, "personal.json");
writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, revision: 1, config: {
  providerConfigRules: { templateRules: [], providerRules: [] },
  modelConfigRules: { modelRules: [{ modelMatch: ".*", config: { enabled: true, properties: {
    contextWindow: 1000000,
    inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
    outputFormat: { supportsText: true }, supportsToolCall: true, supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false, supportsMidConversationSystem: false, requiresMfjsToolSchema: false,
  }, optionSpecs: { maxOutputTokens: { max: 128000 }, reasoningLevel: { values: ["disabled", "enabled"], map: "{}" } } } }],
    modelApiRules: [{ modelMatch: ".*", apiTypeMatch: "openai-chat-completions", config: {
      optionSpecs: { maxOutputTokens: { map: "{'max_completion_tokens': maxOutputTokens}" } },
    } }], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [] },
} }));
writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [{ providerId: "local", providerName: "Local Stand-in", config: {
    group: "standard-personal", access: { type: "api-key", apiKey: randomUUID() },
    api: { type: "openai-chat-completions", baseUrl: origin }, personalModelIds: ["gpt-4o"],
  } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  defaultModelSelection: { providerId: "local", modelId: "gpt-4o" },
} }), { mode: 0o600 });
writeFileSync(join(project, "zcode.json"), JSON.stringify({
  features: { mcp: true, subagent: false, memory: false, skill: true }, memory: { use: false },
  plugins: { enabled: true }, skills: { enabled: true }, hooks: { enabled: false },
}));
const env = {
  ...process.env, HOME: user, SELF_STARTER_HOME: paths.home,
  ZCODE_DATA_BASE_DIR: data, ZCODE_STORAGE_DIR: join(data, "cli"),
  ZCODE_SESSION_DB_PATH: join(data, "cli", "db", "db.sqlite"), ZCODE_LOG_DIR: join(data, "logs"),
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
  ZCODE_NO_PROXY: "127.0.0.1,localhost",
};
const command = cliCommand(bin);
function zcode(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.prefix, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 45_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(`zcode ${args[0]} exited ${code}: ${stderr || stdout}`));
    });
  });
}
saveConfig(paths, { ...DEFAULT_CONFIG, zcodeBin: bin, agentRunTimeoutMinutes: 0.25 });
const daemon = await startDaemon({ paths });
let passed = false;
try {
  buildMarketplace(paths);
  await zcode(["plugins", "validate", join(paths.marketplace, "zcode-plugin"), "--json"]);
  await zcode(["plugins", "marketplace", "add", join(paths.marketplace, "marketplace.json"), "--scope", "user"]);
  await zcode(["plugins", "install", "self-starter@self-starter", "--scope", "user"]);
  await zcode(["plugins", "enable", "self-starter@self-starter", "--scope", "user"]);
  const plugins = JSON.parse(await zcode(["plugins", "list", "--json"])) as Json[];
  const plugin = plugins.find((entry) => entry.id === "self-starter@self-starter");
  assert.equal(plugin?.enabled, true);
  assert.ok(!plugin.diagnostics?.some((entry: Json) => entry.severity === "error"));
  Object.assign(process.env, env);
  const runner = new ZCodeCli(bin, paths.sessions);
  const prompt = { message: "Use service_status once, then confirm the local smoke test.", cwd: project, sandbox: "read-only" as const, timeoutMs: 45000 };
  const first = await runner.run(prompt);
  assert.ok(first.ok && first.sessionId, first.error);
  const second = await runner.run({ ...prompt, sessionId: first.sessionId });
  for (const result of [first, second]) {
    assert.ok(result.ok && result.sessionId, result.error);
    assert.match(result.sessionId, /^sess_/);
    assert.equal(result.lastMessage, response);
  }
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(replies, 2, "each real ZCode turn called Self-Starter through MCP with native session metadata");

  const flag = join(project, "training-finished");
  const caller = { via: "mcp" as const, threadId: `zc:${first.sessionId}`, turnId: "user-setup", cwd: project };
  const draft = await daemon.service.createDraft({
    definition: {
      id: "training-finished", name: "Training finished", intent: "Report when the local flag appears",
      probe: { params: { flag }, interval: { min: "10s", default: "1m" } },
      policy: { max_fires: 1 },
      action: { type: "agent", prompt: "Confirm the flag file appeared and report this fire.", sandbox: "read-only" },
      target: { kind: "dedicated", cwd: project }, notify: { when: "never" },
    },
    code: `
      const {params} = JSON.parse(await new Response(Deno.stdin.readable).text());
      const fire = await Deno.stat(params.flag).then(() => true, (error) => {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      });
      console.log(JSON.stringify({fire, summary:fire ? "Flag appeared" : "Waiting for the flag"}));
    `,
  }, caller);
  assert.equal(draft.trial?.fire, false);
  daemon.service.activateDraft({ draftId: draft.draftId }, caller);
  const baseline = await daemon.engine.runNow("training-finished");
  assert.equal(baseline?.fireId, undefined);
  writeFileSync(flag, "done\n");
  const fired = await daemon.engine.runNow("training-finished");
  assert.ok(fired?.fireId, "the file change produces a fire");
  const fireId = fired.fireId;
  const completed = await waitFor("the real ZCode fire receipt", async () => {
    const fire = daemon.fires.get(fireId);
    return fire?.receipt ? fire : undefined;
  }, { timeoutMs: 30_000, explain: async () => `${JSON.stringify(reportResults)}\n${readFileSync(join(paths.logs, "daemon.log"), "utf8")}` });
  assert.equal(completed.receipt?.source, "tool", JSON.stringify({ completed, reportResults }));
  assert.equal(completed.receipt.summary, "Observed the flag file");
  assert.equal(completed.target?.via, "headless");
  assert.equal(completed.target?.threadId, daemon.store.loadTrigger("training-finished").definition.target.thread_id);
  await waitFor("the background CLI to finish", async () => daemon.executor.status().activeAgentRuns === 0 ? true : undefined, { timeoutMs: 30_000 });
  assert.equal(reportResults.length, 1);
  assert.match(reportResults[0]!, /Receipt recorded/);
  passed = true;
  console.log("ZCode: native plugin installation, MCP calls, session resume, and a file-triggered background receipt passed.");
} finally {
  await daemon.stop();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else console.error(`ZCode test files retained at ${scratch}`);
}
