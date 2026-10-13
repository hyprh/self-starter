import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_NAME } from "../../src/cli/install.js";
import { PLUGIN_SERVER_RULE } from "../../src/engine/sessions.js";
import { PACKAGE_ROOT, PLUGIN_SOURCE, VERSION } from "../../src/runtime.js";

const json = (path: string) => JSON.parse(readFileSync(join(PACKAGE_ROOT, path), "utf8"));

describe("the plugin marketplace in this repository", () => {
  it("lists the plugin, at the package's version", () => {
    const marketplace = json(".agents/plugins/marketplace.json");
    assert.equal(marketplace.name, MARKETPLACE_NAME);
    assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: unknown }) => [plugin.name, plugin.source]), [[PLUGIN_NAME, { source: "local", path: "./plugin" }]]);
    assert.equal(json("plugin/.codex-plugin/plugin.json").version, VERSION);
  });

  it("starts the MCP server through the launcher, which installs the runtime of the plugin's version from this repository", () => {
    const server = json("plugin/.mcp.json").mcpServers[MCP_SERVER_NAME];
    assert.deepEqual([server.command, ...server.args, server.cwd], ["node", "./bin/start.mjs", "mcp", "."]);
    // Codex gives MCP servers only a few variables (HOME, PATH, USER...); these are passed on too, the proxy for the first install.
    assert.deepEqual(server.env_vars.slice(0, 3), ["SELF_STARTER_HOME", "SELF_STARTER_RUNTIME", "CODEX_HOME"]);
    assert.ok(server.env_vars.includes("HTTPS_PROXY") && server.env_vars.includes("https_proxy"));
    const repository = json("package.json").repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
    assert.ok(readFileSync(join(PLUGIN_SOURCE, "bin", "start.mjs"), "utf8").includes(`"github:${repository}"`), `the launcher installs github:${repository}`);
  });
});

describe("the Claude Code plugin marketplace in this repository", () => {
  it("lists the plugin at the package's version, started through the same launcher as the Codex plugin", () => {
    const marketplace = json(".claude-plugin/marketplace.json");
    assert.equal(marketplace.name, MARKETPLACE_NAME);
    assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: unknown }) => [plugin.name, plugin.source]), [[PLUGIN_NAME, "./cc-plugin"]]);
    assert.equal(json("cc-plugin/.claude-plugin/plugin.json").version, VERSION);
    const server = json("cc-plugin/.mcp.json").mcpServers[MCP_SERVER_NAME];
    assert.deepEqual([server.command, ...server.args], ["node", "${CLAUDE_PLUGIN_ROOT}/bin/start.mjs", "mcp"]);
    assert.equal(readFileSync(join(PACKAGE_ROOT, "cc-plugin", "bin", "start.mjs"), "utf8"), readFileSync(join(PLUGIN_SOURCE, "bin", "start.mjs"), "utf8"), "one launcher, in both plugins");
    // Headless fires may use the plugin's tools: the permission rule names this server.
    assert.equal(PLUGIN_SERVER_RULE, `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}`);
  });

  it("runs the session hook when a session starts and ends, and for every prompt", () => {
    const hooks = json("cc-plugin/hooks/hooks.json").hooks as Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>>;
    assert.deepEqual(Object.keys(hooks).sort(), ["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    for (const [event, entries] of Object.entries(hooks)) {
      assert.deepEqual([entries[0]!.hooks[0]!.command, ...entries[0]!.hooks[0]!.args], ["node", "${CLAUDE_PLUGIN_ROOT}/bin/session-hook.mjs"], event);
    }
  });
});

describe("the plugin's launcher", () => {
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

  /** Starts the launcher as Codex does (or as Claude Code does) and returns what `initialize` answered, or its exit code and error output. */
  function start(extraEnv: Record<string, string> = {}, host: "codex" | "claude-code" = "codex"): Promise<{ serverInfo?: { name: string; version: string }; code?: number | null; stderr: string }> {
    const launcher = host === "codex" ? ["./bin/start.mjs"] : [join(PACKAGE_ROOT, "cc-plugin", "bin", "start.mjs")];
    const child = spawn(process.execPath, [...launcher, "mcp"], {
      cwd: host === "codex" ? PLUGIN_SOURCE : scratch,
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
    assert.match(npmCalls().at(-1)!, new RegExp(`^install --prefix ${join(home, "runtime", VERSION)}\\.\\d+\\.partial `));

    const calls = npmCalls().length;
    const again = await start({ SELF_STARTER_RUNTIME: "/nowhere" });
    assert.deepEqual(again.serverInfo, { name: "self-starter", version: VERSION });
    assert.equal(npmCalls().length, calls, "the second start does not install again");
    assert.deepEqual(readdirSync(join(home, "runtime")), [VERSION]);
  });

  it("starts the same way from the Claude Code plugin, which has its own manifest", async () => {
    const started = await start({ SELF_STARTER_HOME: join(scratch, "home-cc") }, "claude-code");
    assert.deepEqual(started.serverInfo, { name: "self-starter", version: VERSION });
  });

  it("finishes the install when the host gives up on a slow first start, so that the next start is ready", async () => {
    const slowHome = join(scratch, "home-slow");
    const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: scratch, SELF_STARTER_HOME: slowHome, SELF_STARTER_RUNTIME: PACKAGE_ROOT, FAKE_NPM_DELAY: "1" };
    const before = npmCalls().length;
    const launcher = spawn(process.execPath, ["./bin/start.mjs", "mcp"], { cwd: PLUGIN_SOURCE, env, stdio: ["pipe", "pipe", "pipe"] });
    while (npmCalls().length === before) await new Promise((resolve) => setTimeout(resolve, 20));
    launcher.kill("SIGKILL"); // in the middle of the install, as a host does when its startup timeout runs out
    const cli = join(slowHome, "runtime", VERSION, "node_modules", "self-starter");
    for (let waited = 0; !existsSync(cli); waited += 100) {
      assert.ok(waited < 10_000, "the install did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const calls = npmCalls().length;
    assert.deepEqual((await start({ SELF_STARTER_HOME: slowHome, SELF_STARTER_RUNTIME: "/nowhere" })).serverInfo, { name: "self-starter", version: VERSION });
    assert.equal(npmCalls().length, calls);
  });
});
