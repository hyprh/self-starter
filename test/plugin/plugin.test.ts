import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { buildMarketplace, doctor, install, MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_ID, PLUGIN_NAME } from "../../src/cli/install.js";
import { loadConfig } from "../../src/engine/config.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { PLUGIN_SERVER_RULE } from "../../src/engine/sessions.js";
import { TOOLS } from "../../src/mcp/server.js";
import { CLI_SCRIPT, PACKAGE_ROOT, PLUGIN_SOURCE, VERSION } from "../../src/runtime.js";
import { compareVersions, stopRunningDaemon } from "../../src/service/manager.js";

const json = (path: string) => JSON.parse(readFileSync(join(PACKAGE_ROOT, path), "utf8"));

describe("the plugin marketplace in this repository", () => {
  it("lists the plugin, with the published runtime shared by the existing catalogs", () => {
    const marketplace = json(".agents/plugins/marketplace.json");
    assert.equal(marketplace.name, MARKETPLACE_NAME);
    assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: unknown }) => [plugin.name, plugin.source]), [[PLUGIN_NAME, { source: "local", path: "./codex-plugin" }]]);
    const version = json("codex-plugin/.codex-plugin/plugin.json").version;
    assert.equal(version, json("cc-plugin/.claude-plugin/plugin.json").version);
    assert.ok(compareVersions(version, VERSION) <= 0, "catalogs cannot require a newer runtime than this source checkout");
  });

  it("starts the MCP server through the launcher, which installs the runtime of the plugin's version from this repository", () => {
    const server = json("codex-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME];
    assert.deepEqual([server.command, ...server.args, server.cwd], ["node", "./bin/start.mjs", "mcp", "."]);
    // Codex gives MCP servers only a few variables (HOME, PATH, USER...); these are passed on too, the proxy for the first install.
    assert.deepEqual(server.env_vars.slice(0, 3), ["SELF_STARTER_HOME", "SELF_STARTER_RUNTIME", "CODEX_HOME"]);
    assert.ok(server.env_vars.includes("HTTPS_PROXY") && server.env_vars.includes("https_proxy"));
    const repository = json("package.json").repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
    assert.ok(readFileSync(join(PLUGIN_SOURCE, "bin", "start.mjs"), "utf8").includes(`"github:${repository}"`), `the launcher installs github:${repository}`);
  });
});

describe("the Claude Code plugin marketplace in this repository", () => {
  it("lists the plugin at its advertised runtime version, started through the same launcher as the Codex plugin", () => {
    const marketplace = json(".claude-plugin/marketplace.json");
    assert.equal(marketplace.name, MARKETPLACE_NAME);
    assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: unknown }) => [plugin.name, plugin.source]), [[PLUGIN_NAME, "./cc-plugin"]]);
    assert.equal(json("cc-plugin/.claude-plugin/plugin.json").version, json("codex-plugin/.codex-plugin/plugin.json").version);
    const server = json("cc-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME];
    assert.deepEqual([server.command, ...server.args], ["node", "${CLAUDE_PLUGIN_ROOT}/bin/start.mjs", "mcp"]);
    assert.equal(readFileSync(join(PACKAGE_ROOT, "cc-plugin", "bin", "start.mjs"), "utf8"), readFileSync(join(PLUGIN_SOURCE, "bin", "start.mjs"), "utf8"), "one launcher, in both plugins");
    // Headless fires may use the plugin's tools: the permission rule names this server.
    assert.equal(PLUGIN_SERVER_RULE, `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}`);
  });

  it("follows sessions and their turns with the session hook, and approves only the safe tools", () => {
    type Entry = { matcher?: string; hooks: Array<{ command: string; args: string[] }> };
    const hooks = json("cc-plugin/hooks/hooks.json").hooks as Record<string, Entry[]>;
    const run = (entry: Entry) => [entry.hooks[0]!.command, ...entry.hooks[0]!.args];
    const { PreToolUse, ...session } = hooks;
    const approve = PreToolUse?.[0];
    assert.deepEqual(Object.keys(session).sort(), ["SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
    for (const [event, entries] of Object.entries(session)) assert.deepEqual(run(entries[0]!), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/session-hook.mjs"], event);

    assert.deepEqual(run(approve!), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/approve.mjs"]);
    const approved = (tool: string) => new RegExp(approve!.matcher!).test(`${PLUGIN_SERVER_RULE}__${tool}`);
    const tools = TOOLS.map((tool) => tool.name);
    assert.deepEqual(tools.filter(approved), ["trigger_recipes", "trigger_tune", "trigger_list", "trigger_get", "trigger_test", "trigger_history", "trigger_report", "service_status"]);
    // What creates, changes, pauses or deletes triggers keeps asking.
    assert.deepEqual(tools.filter((tool) => !approved(tool)), ["trigger_draft", "trigger_activate", "trigger_update", "trigger_pause", "trigger_resume", "trigger_delete"]);
    assert.equal(approved("trigger_report_and_more"), false);
  });
});

describe("the local marketplace that self-starter install writes", () => {
  it("holds all three plugins, at this version, starting this installation's MCP server through absolute paths", () => {
    const home = mkdtempSync(join(tmpdir(), "ss-marketplace-"));
    try {
      const paths = resolvePaths(home);
      buildMarketplace(paths);
      const read = (path: string) => JSON.parse(readFileSync(join(paths.marketplace, path), "utf8"));
      const server = { command: process.execPath, args: [CLI_SCRIPT, "mcp"] };

      assert.deepEqual(read(".agents/plugins/marketplace.json").plugins[0].source, { source: "local", path: "./plugins/self-starter" });
      assert.equal(read("plugins/self-starter/.codex-plugin/plugin.json").version, VERSION);
      const codexEnv = { SELF_STARTER_HOME: paths.home, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
      assert.deepEqual(read("plugins/self-starter/.mcp.json").mcpServers[MCP_SERVER_NAME], { ...server, cwd: ".", env: codexEnv, startup_timeout_sec: 30 });

      assert.deepEqual(read(".claude-plugin/marketplace.json").plugins, [{ name: PLUGIN_NAME, source: "./cc-plugin" }]);
      assert.equal(read("cc-plugin/.claude-plugin/plugin.json").version, VERSION);
      assert.deepEqual(read("cc-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME], { ...server, env: { SELF_STARTER_HOME: paths.home } });
      assert.ok(existsSync(join(paths.marketplace, "cc-plugin", "hooks", "hooks.json")), "with its hooks");

      assert.deepEqual(read("marketplace.json").plugins, [{ name: PLUGIN_NAME, source: "./zcode-plugin", version: VERSION }]);
      assert.equal(read("zcode-plugin/.zcode-plugin/plugin.json").version, VERSION);
      assert.deepEqual(read("zcode-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME], {
        ...server,
        env: { SELF_STARTER_HOME: paths.home, SELF_STARTER_HOST: "zcode" },
        timeoutMs: 30_000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the ZCode plugin", () => {
  it("uses its native manifest, explicit host and native startup timeout", () => {
    const marketplace = json("marketplace.json");
    const manifest = json("zcode-plugin/.zcode-plugin/plugin.json");
    assert.equal(marketplace.name, MARKETPLACE_NAME);
    assert.deepEqual(marketplace.plugins.map((entry: { name: string; source: string; version: string }) => [entry.name, entry.source, entry.version]), [[PLUGIN_NAME, "./zcode-plugin", VERSION]]);
    assert.equal(manifest.version, VERSION);
    const server = json("zcode-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME];
    assert.deepEqual([server.command, ...server.args], ["node", "${ZCODE_PLUGIN_ROOT}/bin/start.mjs", "mcp"]);
    assert.deepEqual(server.env, { SELF_STARTER_HOST: "zcode" });
    assert.equal(server.timeoutMs, 180_000);
    assert.equal(readFileSync(join(PACKAGE_ROOT, "zcode-plugin", "bin", "start.mjs"), "utf8"), readFileSync(join(PLUGIN_SOURCE, "bin", "start.mjs"), "utf8"), "all hosts share the same launcher");
    assert.ok(json("package.json").files.includes("zcode-plugin"), "the runtime package includes its ZCode plugin");
  });

  it("registers and enables the plugin, and doctor rejects disabled, broken or malformed plugin listings", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ss-zcode-install-"));
    const paths = resolvePaths(join(scratch, "home"));
    const calls = join(scratch, "calls.jsonl");
    const mode = join(scratch, "mode");
    writeFileSync(mode, "enabled");
    const binaries = ["codex", "claude", "zcode"].map((name) => {
      const bin = join(scratch, `${name}.mjs`);
      writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
if (args[0] === "--version") console.log("3.16.1");
else if (args[0] === "plugins" && args[1] === "list") {
  const mode = readFileSync(${JSON.stringify(mode)}, "utf8");
  console.log(mode === "invalid" ? "not json" : JSON.stringify([{ id: ${JSON.stringify(PLUGIN_ID)}, enabled: mode !== "disabled", diagnostics: mode === "error" ? [{ severity: "error" }] : [] }]));
} else console.log("self-starter@self-starter");
`);
      chmodSync(bin, 0o755);
      return bin;
    });
    try {
      await install(paths, { codex: binaries[0]!, claude: binaries[1]!, zcode: binaries[2]!, service: false, log: () => {} });
      assert.equal(loadConfig(paths).zcodeBin, binaries[2]);
      const zcodeCalls = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]).filter(([name]) => name === "zcode");
      assert.deepEqual(zcodeCalls, [
        ["zcode", "plugins", "marketplace", "add", join(paths.marketplace, "marketplace.json"), "--scope", "user"],
        ["zcode", "plugins", "install", PLUGIN_ID, "--scope", "user"],
        ["zcode", "plugins", "enable", PLUGIN_ID, "--scope", "user"],
      ]);
      const check = async () => (await doctor(paths)).find((entry) => entry.label === "zcode plugin")!;
      assert.equal((await check()).ok, true);
      for (const state of ["disabled", "error", "invalid"]) {
        writeFileSync(mode, state);
        assert.equal((await check()).ok, false, state);
      }
    } finally {
      await stopRunningDaemon(paths);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the plugin's launcher", () => {
  const catalogVersion = json("codex-plugin/.codex-plugin/plugin.json").version as string;
  const scratch = mkdtempSync(join(tmpdir(), "ss-launcher-"));
  const home = join(scratch, "home");
  const npmLog = join(scratch, "npm.log");
  // An npm that "installs" this checkout by linking it, and logs each call.
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >> "${npmLog}"\n[ -n "$FAKE_NPM_FAIL" ] && exit 7\n[ -n "$FAKE_NPM_DELAY" ] && sleep "$FAKE_NPM_DELAY"\nmkdir -p "$3/node_modules" && ln -s "$7" "$3/node_modules/self-starter"\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  /** Starts the launcher as its host does and returns `initialize`, or its exit code and error output. */
  function start(extraEnv: Record<string, string> = {}, host: "codex" | "claude-code" | "zcode" = "codex", pluginSource = PLUGIN_SOURCE): Promise<{ serverInfo?: { name: string; version: string }; code?: number | null; stderr: string }> {
    const launcher = host === "codex" ? ["./bin/start.mjs"] : [join(PACKAGE_ROOT, host === "zcode" ? "zcode-plugin" : "cc-plugin", "bin", "start.mjs")];
    const child = spawn(process.execPath, [...launcher, "mcp"], {
      cwd: host === "codex" ? pluginSource : scratch,
      env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: scratch, SELF_STARTER_HOME: home, SELF_STARTER_RUNTIME: PACKAGE_ROOT, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        resolve({ serverInfo: JSON.parse(line).result?.serverInfo, stderr });
        child.kill();
      });
      child.on("exit", (code) => resolve({ code, stderr }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`);
    });
  }
  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : []);

  it("explains a failed install and leaves nothing half-installed", async () => {
    const failed = await start({ FAKE_NPM_FAIL: "1" });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, new RegExp(`could not install ${PACKAGE_ROOT.replace(/[/\\]/g, ".")}: npm exited with code 7`));
    assert.deepEqual(readdirSync(join(home, "runtime")), []);
  });

  it("installs the runtime of its version once, then starts the MCP server from it", async () => {
    const first = await start();
    assert.deepEqual(first.serverInfo, { name: "self-starter", version: VERSION });
    assert.match(first.stderr, /installing .* once for this version/);
    assert.match(npmCalls().at(-1)!, new RegExp(`^install --prefix ${join(home, "runtime", catalogVersion)}\\.\\d+\\.partial `));

    const calls = npmCalls().length;
    const again = await start({ SELF_STARTER_RUNTIME: "/nowhere" });
    assert.deepEqual(again.serverInfo, { name: "self-starter", version: VERSION });
    assert.equal(npmCalls().length, calls, "the second start does not install again");
    assert.deepEqual(readdirSync(join(home, "runtime")), [catalogVersion]);
  });

  it("starts the same way from the Claude Code plugin, which has its own manifest", async () => {
    const started = await start({ SELF_STARTER_HOME: join(scratch, "home-cc"), CLAUDE_CODE_SESSION_ID: "s1" }, "claude-code");
    assert.deepEqual(started.serverInfo, { name: "self-starter", version: VERSION });
  });

  it("starts from the ZCode plugin's native manifest and explicit host", async () => {
    const started = await start({ SELF_STARTER_HOME: join(scratch, "home-zcode"), SELF_STARTER_HOST: "zcode" }, "zcode");
    assert.deepEqual(started.serverInfo, { name: "self-starter", version: VERSION });
  });

  it("starts from a catalog bundle containing only manifest-declared paths", async () => {
    const manifest = json("codex-plugin/.codex-plugin/plugin.json");
    const bundle = join(scratch, "catalog-bundle");
    mkdirSync(bundle);
    // Catalogs mirror the manifest, its declared content paths and interface assets.
    // A launcher directory omitted from the manifest must not be copied implicitly.
    for (const path of [".codex-plugin", manifest.skills, manifest.scripts, manifest.mcpServers, "assets"]) {
      if (typeof path === "string") cpSync(join(PLUGIN_SOURCE, path), join(bundle, path), { recursive: true });
    }
    const started = await start({ SELF_STARTER_HOME: join(scratch, "home-catalog") }, "codex", bundle);
    assert.deepEqual(started.serverInfo, { name: "self-starter", version: VERSION }, started.stderr);
  });

  it("answers Claude Code in time when the first start takes longer than it waits, then brings the tools in", async () => {
    const child = spawn(process.execPath, [join(PACKAGE_ROOT, "cc-plugin", "bin", "start.mjs"), "mcp"], {
      cwd: scratch,
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        HOME: scratch,
        SELF_STARTER_HOME: join(scratch, "home-cc-slow"),
        SELF_STARTER_RUNTIME: PACKAGE_ROOT,
        FAKE_NPM_DELAY: "3",
        MCP_TIMEOUT: "1000", // the host waits a second, so the launcher answers after two
        CLAUDE_CODE_SESSION_ID: "s1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<Record<string, any>> = [];
    createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
    const request = (id: number, method: string, params: Record<string, unknown> = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const received = async (match: (message: Record<string, any>) => boolean, what: string) => {
      for (let waited = 0; ; waited += 50) {
        const found = messages.find(match);
        if (found) return found;
        assert.ok(waited < 15_000, `no ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      const init = await received((message) => message.id === 1, "answer to initialize");
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
      assert.match(init.result.instructions, /installing its runtime/);
      request(2, "tools/list");
      assert.deepEqual((await received((message) => message.id === 2, "tool list")).result.tools, [], "no tools while installing");

      await received((message) => message.method === "notifications/tools/list_changed", "notice that the tools changed");
      request(3, "tools/list");
      const tools = (await received((message) => message.id === 3, "tool list")).result.tools as Array<{ name: string }>;
      assert.deepEqual(tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
    } finally {
      child.kill();
    }
  });

  it("finishes the install when the host gives up on a slow first start, so that the next start is ready", async () => {
    const slowHome = join(scratch, "home-slow");
    const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: scratch, SELF_STARTER_HOME: slowHome, SELF_STARTER_RUNTIME: PACKAGE_ROOT, FAKE_NPM_DELAY: "1" };
    const before = npmCalls().length;
    const launcher = spawn(process.execPath, ["./bin/start.mjs", "mcp"], { cwd: PLUGIN_SOURCE, env, stdio: ["pipe", "pipe", "pipe"] });
    while (npmCalls().length === before) await new Promise((resolve) => setTimeout(resolve, 20));
    launcher.kill("SIGKILL"); // in the middle of the install, as a host does when its startup timeout runs out
    const cli = join(slowHome, "runtime", catalogVersion, "node_modules", "self-starter");
    for (let waited = 0; !existsSync(cli); waited += 100) {
      assert.ok(waited < 10_000, "the install did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const calls = npmCalls().length;
    assert.deepEqual((await start({ SELF_STARTER_HOME: slowHome, SELF_STARTER_RUNTIME: "/nowhere" })).serverInfo, { name: "self-starter", version: VERSION });
    assert.equal(npmCalls().length, calls);
  });
});
