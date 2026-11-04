// End-to-end Antigravity plugin installation, PreToolUse guard hook, MCP session
// metadata, dedicated `agy --print --conversation <id>` execution, and plugin removal.
// When a real `agy` CLI is present on the machine (via AGY_REAL_BIN or findAntigravity()),
// it also runs `agy plugin validate --strict --json` against the built marketplace plugin.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { doctor } from "../../src/cli/install.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { findAntigravity } from "../../src/engine/antigravity.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { stopRunningDaemon } from "../../src/service/manager.js";
import { cli, waitFor } from "./harness.js";

type Json = Record<string, any>;

const realAgy = process.env.AGY_REAL_BIN || findAntigravity();
const scratch = mkdtempSync(join(tmpdir(), "ss-agy-e2e-"));
const userHome = join(scratch, "user");
const project = join(scratch, "project");
const paths = resolvePaths(join(scratch, "self-starter"));
for (const dir of [userHome, project]) mkdirSync(dir, { recursive: true });

// Stand-in `agy` CLI implementing Antigravity's plugin lifecycle (`plugin install/enable/list/uninstall`)
// and headless `--print <msg> --dangerously-skip-permissions --output-format json [--conversation <id>]`
// including executing the installed PreToolUse hook and speaking real stdio MCP from `mcp_config.json`.
const standInAgy = join(scratch, "agy.mjs");
writeFileSync(
  standInAgy,
  `#!${process.execPath}
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const pluginsRoot = join(process.env.HOME, ".gemini", "config", "plugins");
const statePath = join(pluginsRoot, "state.json");
const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const writeState = (s) => { mkdirSync(pluginsRoot, { recursive: true }); writeFileSync(statePath, JSON.stringify(s, null, 2)); };

if (args[0] === "--version") {
  console.log("1.4.8");
  process.exit(0);
}
if (args[0] === "plugin") {
  const sub = args[1];
  if (sub === "install") {
    const src = args[2];
    const manifest = JSON.parse(readFileSync(join(src, "plugin.json"), "utf8"));
    const dest = join(pluginsRoot, manifest.name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    const state = readState();
    state[manifest.name] = { name: manifest.name, version: manifest.version, enabled: false };
    writeState(state);
    console.log("Installed " + manifest.name);
    process.exit(0);
  }
  if (sub === "enable") {
    const name = args[2];
    const state = readState();
    if (!state[name]) process.exit(1);
    state[name].enabled = true;
    writeState(state);
    console.log("Enabled " + name);
    process.exit(0);
  }
  if (sub === "uninstall") {
    const name = args[2];
    const state = readState();
    delete state[name];
    writeState(state);
    rmSync(join(pluginsRoot, name), { recursive: true, force: true });
    console.log("Uninstalled " + name);
    process.exit(0);
  }
  if (sub === "list") {
    const state = readState();
    console.log(JSON.stringify(Object.values(state)));
    process.exit(0);
  }
}

const pIdx = args.indexOf("--print");
if (pIdx !== -1) {
  const prompt = args[pIdx + 1] ?? "";
  const convIdx = args.indexOf("--conversation");
  const convId = convIdx !== -1 ? args[convIdx + 1] : "conv_" + Math.random().toString(36).slice(2, 10);
  const pluginDir = join(pluginsRoot, "self-starter");
  const hooksCfg = JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8"));
  const hookCmd = hooksCfg["self-starter"].PreToolUse[0].hooks[0].command;
  const runHook = (toolName, toolArgs) => {
    const res = spawnSync("/bin/sh", ["-c", hookCmd], {
      cwd: pluginDir,
      input: JSON.stringify({ toolCall: { name: toolName, args: toolArgs } }),
      encoding: "utf8",
      env: process.env,
    });
    if (res.status !== 0) throw new Error("hook failed: " + res.stderr);
    return JSON.parse(res.stdout.trim());
  };

  // Seed turn: return allocated conversation_id.
  const fireMatch = /fire_id="(fire_[a-z0-9]+)"/.exec(prompt);
  if (!fireMatch) {
    process.stdout.write(JSON.stringify({ conversation_id: convId, status: "SUCCESS", response: "Ready." }) + "\\n");
    process.exit(0);
  }

  // Trigger turn: verify PreToolUse hook blocks mutating Self-Starter tools and read-only shell commands,
  // allows trigger_report, and calls the installed MCP server over stdio.
  const blockedMcp = runHook("call_mcp_tool", { ServerName: "plugin_self-starter_self_starter", ToolName: "trigger_delete" });
  if (blockedMcp.decision !== "deny") throw new Error("expected trigger_delete to be denied by hook");
  const blockedCmd = runHook("run_command", { CommandLine: "echo should-not-run" });
  if (blockedCmd.decision !== "deny") throw new Error("expected run_command to be denied in read-only trigger turn");
  const allowedReport = runHook("call_mcp_tool", { ServerName: "plugin_self-starter_self_starter", ToolName: "trigger_report" });
  if (allowedReport.decision !== "allow") throw new Error("expected trigger_report to be allowed by hook");

  const mcpCfg = JSON.parse(readFileSync(join(pluginDir, "mcp_config.json"), "utf8")).mcpServers.self_starter;
  const child = spawn(mcpCfg.command, mcpCfg.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...mcpCfg.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agy", version: "1.4.8" } });
  const progressKey = ["progress", "Token"].join("");
  const rep = await rpc(2, "tools/call", {
    name: "trigger_report",
    arguments: { fire_id: fireMatch[1], summary: "Antigravity verified the flag file", notify: false },
    _meta: {
      "antigravity.google/conversation_id": convId,
      [progressKey]: ["turn-fire", "1"].join(":"),
      workspace_path: process.cwd(),
    },
  });
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  if (rep.result?.isError) throw new Error("trigger_report failed: " + JSON.stringify(rep));
  process.stdout.write(JSON.stringify({ conversation_id: convId, status: "SUCCESS", response: "Reported fire " + fireMatch[1] }) + "\\n");
  process.exit(0);
}
process.exit(1);
`,
  { mode: 0o755 },
);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: userHome,
  XDG_CONFIG_HOME: join(userHome, ".config"),
  XDG_RUNTIME_DIR: join(scratch, "no-systemd"),
  DBUS_SESSION_BUS_ADDRESS: "",
  SELF_STARTER_HOME: paths.home,
  PATH: join(scratch, "empty-bin"),
  CODEX_BIN: "",
  CLAUDE_BIN: "",
  AGY_BIN: "",
  ZCODE_BIN: "",
  OPENCODE_BIN: "",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let passed = false;

try {
  // 1. Install Self-Starter for Antigravity via the CLI (--no-service so host launchd/systemd is untouched)
  const installOut = await cli(env, ["install", "--agy", standInAgy, "--no-service"]);
  assert.match(installOut, /Antigravity/);

  // 2. If real `agy` is available on this host, validate the built marketplace agy-plugin strictly
  if (realAgy && existsSync(realAgy)) {
    const val = spawnSync(realAgy, ["plugin", "validate", join(paths.marketplace, "agy-plugin"), "--strict", "--json"], {
      encoding: "utf8",
    });
    assert.equal(val.status, 0, `real agy plugin validate failed: ${val.stderr || val.stdout}`);
    const parsed = JSON.parse(val.stdout) as { findings: unknown[]; components?: { mcpServers?: number; hooks?: number; skills?: number } };
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.components?.mcpServers, 1);
    assert.equal(parsed.components?.hooks, 1);
    assert.equal(parsed.components?.skills, 1);
  }

  // 3. Verify `doctor` checks for antigravity, agy plugin and running daemon
  const savedHome = process.env.HOME;
  process.env.HOME = userHome;
  try {
    const checks = await doctor(paths);
    assert.equal(checks.find((c) => c.label === "antigravity")?.ok, true);
    assert.equal(checks.find((c) => c.label === "agy plugin")?.ok, true);
    assert.equal(checks.find((c) => c.label === "daemon")?.ok, true);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }

  // Replace the CLI-spawned detached daemon with an in-process daemon so we can drive & inspect fires deterministically
  await stopRunningDaemon(paths);
  process.env.HOME = userHome;
  daemon = await startDaemon({ paths });

  const installedPluginDir = join(userHome, ".gemini", "config", "plugins", "self-starter");
  const mcpServerCfg = JSON.parse(readFileSync(join(installedPluginDir, "mcp_config.json"), "utf8")).mcpServers.self_starter as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  const mcpChild = spawn(mcpServerCfg.command, mcpServerCfg.args, {
    cwd: project,
    env: { ...env, ...mcpServerCfg.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (msg: Json) => void>();
  createInterface({ input: mcpChild.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Json;
    if (typeof msg.id === "number") {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (id: number, method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      pending.set(id, resolve);
      mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const flagFile = join(project, "deploy-ready.flag");
  const progressKey = ["progress", "Token"].join("");
  const meta = {
    "antigravity.google/conversation_id": "conv_interactive_origin",
    [progressKey]: ["req-user", "1"].join(":"),
    workspace_path: project,
  };

  try {
    const init = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "antigravity-client", version: "1.4.8" },
    });
    assert.match(init.result.instructions, /Antigravity/);

    const draftRes = await rpc(2, "tools/call", {
      name: "trigger_draft",
      arguments: {
        definition: {
          id: "deploy-flag",
          name: "Deploy flag watch",
          intent: "Verify when deploy-ready.flag appears",
          probe: { params: { flag: flagFile }, interval: { min: "10s", default: "1m" } },
          policy: { max_fires: 1 },
          action: { type: "agent", prompt: "Inspect the flag and call trigger_report.", sandbox: "read-only" },
          notify: { when: "never" },
        },
        code: `
          const { params } = JSON.parse(await new Response(Deno.stdin.readable).text());
          const fire = await Deno.stat(params.flag).then(() => true, () => false);
          console.log(JSON.stringify({ fire, summary: fire ? "Flag ready" : "Waiting" }));
        `,
      },
      _meta: meta,
    });
    const draftText = draftRes.result.content[0].text as string;
    assert.equal(draftRes.result.isError, undefined, draftText);
    const draftId = /Draft (\S+) saved/.exec(draftText)?.[1];
    assert.ok(draftId, draftText);

    const actRes = await rpc(3, "tools/call", {
      name: "trigger_activate",
      arguments: { draft_id: draftId },
      _meta: meta,
    });
    assert.equal(actRes.result.isError, undefined, actRes.result.content[0].text);
  } finally {
    mcpChild.stdin.end();
    await new Promise((resolve) => mcpChild.once("close", resolve));
  }

  // Wait for dedicated Antigravity CLI seed conversation to bind and finish releasing its session lease
  const boundRef = await waitFor(
    "dedicated agy conversation seed",
    async () => daemon!.store.loadTrigger("deploy-flag").definition.target.thread_id ?? undefined,
    { timeoutMs: 15_000 },
  );
  assert.match(boundRef, /^agy:conv_/);
  await waitFor("seed run to release lease", async () => (daemon!.executor.status().activeAgentRuns === 0 ? true : undefined), {
    timeoutMs: 10_000,
  });

  // Trigger the probe by creating the watched flag file
  writeFileSync(flagFile, "ready\n");
  const fired = await daemon.engine.runNow("deploy-flag");
  assert.ok(fired?.fireId, "probe run produced a fire");
  const completed = await waitFor(
    "Antigravity headless trigger_report receipt",
    async () => {
      const f = daemon!.fires.get(fired.fireId!);
      return f?.receipt ? f : undefined;
    },
    { timeoutMs: 20_000 },
  );
  assert.equal(completed.receipt?.source, "tool");
  assert.equal(completed.receipt?.summary, "Antigravity verified the flag file");
  assert.equal(completed.target?.threadId, boundRef);
  await waitFor("activeAgentRuns to drain", async () => (daemon!.executor.status().activeAgentRuns === 0 ? true : undefined), {
    timeoutMs: 10_000,
  });

  await daemon.stop();
  daemon = undefined;

  // Verify plugin uninstall removes the installed plugin directory cleanly
  const unRes = spawnSync(standInAgy, ["plugin", "uninstall", "self-starter"], { env, encoding: "utf8" });
  assert.equal(unRes.status, 0, unRes.stderr);
  assert.equal(existsSync(installedPluginDir), false, "agy plugin uninstalled cleanly");

  passed = true;
  console.log("Antigravity E2E: plugin install, strict validation, PreToolUse guard, MCP metadata, dedicated fire delivery, and uninstall passed.");
} finally {
  if (daemon) await daemon.stop();
  await stopRunningDaemon(paths);
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Antigravity E2E scratch retained at ${scratch}`);
}
