import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_NAME } from "../../src/cli/install.js";
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

describe("the plugin's launcher", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ss-launcher-"));
  const home = join(scratch, "home");
  const npmLog = join(scratch, "npm.log");
  // An npm that "installs" this checkout by linking it, and logs each call.
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >> "${npmLog}"\n[ -n "$FAKE_NPM_FAIL" ] && exit 7\nmkdir -p "$3/node_modules" && ln -s "$7" "$3/node_modules/self-starter"\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  /** Starts the launcher as Codex does and returns what `initialize` answered, or its exit code and error output. */
  function start(extraEnv: Record<string, string> = {}): Promise<{ serverInfo?: { name: string; version: string }; code?: number | null; stderr: string }> {
    const child = spawn(process.execPath, ["./bin/start.mjs", "mcp"], {
      cwd: PLUGIN_SOURCE,
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
});
