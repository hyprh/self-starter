import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  doctor, install, installOpenCodePlugin, openCodeConfigDir, openCodePluginPath, uninstallOpenCodePlugin,
} from "../../src/cli/install.js";
import { loadConfig, saveConfig } from "../../src/engine/config.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { stopRunningDaemon } from "../../src/service/manager.js";
import { CLI_SCRIPT } from "../../src/runtime.js";

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "ss-opencode-install-"));
  const keys = ["HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "PATH", "CODEX_BIN", "CLAUDE_BIN", "ZCODE_BIN", "OPENCODE_BIN"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const versionFile = join(scratch, "version");
  writeFileSync(versionFile, "1.19.3");
  const bin = join(scratch, "agent.mjs");
  writeFileSync(bin, `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconsole.log(readFileSync(${JSON.stringify(versionFile)}, 'utf8'));\n`, { mode: 0o755 });
  Object.assign(process.env, {
    HOME: join(scratch, "user"), XDG_CONFIG_HOME: join(scratch, "config"),
    OPENCODE_CONFIG_DIR: join(scratch, "extra-config"), PATH: join(scratch, "no-binaries"),
    CODEX_BIN: bin, CLAUDE_BIN: bin, ZCODE_BIN: bin, OPENCODE_BIN: bin,
  });
  const paths = resolvePaths(join(scratch, "self-starter"));
  return {
    scratch, paths, bin, versionFile,
    cleanup() {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

describe("OpenCode native plugin installation", () => {
  it("installs one discoverable loader without rewriting configuration or other plugins", () => {
    const f = fixture();
    try {
      const configDir = openCodeConfigDir();
      const pluginDir = join(configDir, "plugins");
      mkdirSync(pluginDir, { recursive: true });
      const config = '{\n  // Keep my configuration\n  "model": "local/custom",\n}\n';
      writeFileSync(join(configDir, "opencode.jsonc"), config);
      writeFileSync(join(pluginDir, "mine.js"), "export default async () => ({});\n");
      installOpenCodePlugin(f.paths);
      const target = openCodePluginPath();
      const loader = readFileSync(target, "utf8");
      assert.match(loader, /import plugin from "file:\/\//);
      assert.match(loader, /export default \(input\) => plugin\(input, \{ home:/);
      assert.ok(loader.includes(JSON.stringify(f.paths.home)));
      assert.equal(loadConfig(f.paths).opencodeConfigDir, configDir);
      assert.equal(existsSync(join(process.env.OPENCODE_CONFIG_DIR!, "plugins", "self-starter.js")), false,
        "OPENCODE_CONFIG_DIR adds a directory; installing in both would load the plugin twice");
      installOpenCodePlugin(f.paths);
      assert.equal(readFileSync(target, "utf8"), loader);
      assert.deepEqual(readdirSync(pluginDir).sort(), ["mine.js", "self-starter.js"]);
      assert.equal(readFileSync(join(configDir, "opencode.jsonc"), "utf8"), config);
    } finally {
      f.cleanup();
    }
  });

  it("refuses existing user loaders, including the singular directory and TypeScript variant", () => {
    const f = fixture();
    try {
      for (const folder of ["plugin", "plugins"]) {
        for (const extension of ["js", "ts"]) {
          const target = join(openCodeConfigDir(), folder, `self-starter.${extension}`);
          mkdirSync(join(openCodeConfigDir(), folder), { recursive: true });
          const original = "export default async () => ({ tool: {} });\n";
          writeFileSync(target, original);
          assert.throws(() => installOpenCodePlugin(f.paths), /already has.*move that plugin/);
          assert.equal(readFileSync(target, "utf8"), original);
          uninstallOpenCodePlugin(f.paths);
          assert.equal(readFileSync(target, "utf8"), original);
          rmSync(target);
        }
      }
    } finally {
      f.cleanup();
    }
  });

  it("removes only this installation's loader, using its recorded directory after the environment changes", () => {
    const f = fixture();
    try {
      installOpenCodePlugin(f.paths);
      const target = openCodePluginPath();
      const second = resolvePaths(join(f.scratch, "second-installation"));
      installOpenCodePlugin(second);
      uninstallOpenCodePlugin(f.paths);
      assert.ok(existsSync(target), "uninstalling the old installation leaves the replacement in place");
      process.env.XDG_CONFIG_HOME = join(f.scratch, "different-config");
      uninstallOpenCodePlugin(second);
      assert.equal(existsSync(target), false);
    } finally {
      f.cleanup();
    }
  });

  it("rejects unknown, older and incompatible major versions before writing plugin files", async () => {
    const f = fixture();
    try {
      for (const version of ["unknown", "1.19.2", "2.0.0"]) {
        writeFileSync(f.versionFile, version);
        await assert.rejects(install(f.paths, { opencode: f.bin, service: false, log: () => {} }), /requires OpenCode 1\.19\.3.*1\.x/);
        assert.equal(existsSync(openCodePluginPath()), false);
        assert.equal(existsSync(f.paths.marketplace), false);
      }
    } finally {
      f.cleanup();
    }
  });

  it("registers a supported CLI and keeps its loader when installing again", async () => {
    const f = fixture();
    try {
      saveConfig(f.paths, { ...loadConfig(f.paths), denoBin: f.bin });
      const options = { opencode: f.bin, service: false, log: () => {} };
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_SCRIPT, "install", "--opencode", f.bin, "--zcode", f.bin, "--no-service"], {
          env: { ...process.env, SELF_STARTER_HOME: f.paths.home, OPENCODE_BIN: "", ZCODE_BIN: "" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
      });
      assert.equal(loadConfig(f.paths).opencodeBin, f.bin);
      assert.equal(loadConfig(f.paths).zcodeBin, f.bin);
      const source = readFileSync(openCodePluginPath(), "utf8");
      await install(f.paths, options);
      assert.equal(readFileSync(openCodePluginPath(), "utf8"), source);
      assert.equal((await doctor(f.paths)).find((entry) => entry.label === "opencode plugin")?.ok, true);
    } finally {
      await stopRunningDaemon(f.paths);
      f.cleanup();
    }
  });

  it("doctor checks the supported version and the actual loader without claiming model access", async () => {
    const f = fixture();
    try {
      installOpenCodePlugin(f.paths);
      saveConfig(f.paths, { ...loadConfig(f.paths), opencodeBin: f.bin, denoBin: f.bin });
      const check = async (label: string) => (await doctor(f.paths)).find((entry) => entry.label === label)!;
      assert.equal((await check("opencode")).ok, true);
      assert.equal((await check("opencode plugin")).ok, true);
      assert.match((await check("opencode plugin")).detail, /model access is not checked/);
      const target = openCodePluginPath();
      const source = readFileSync(target, "utf8");
      writeFileSync(target, source.replace("index.mjs", "missing.mjs"));
      assert.equal((await check("opencode plugin")).ok, false);
      writeFileSync(target, source);
      writeFileSync(f.versionFile, "2.0.0");
      assert.equal((await check("opencode")).ok, false);
      process.env.XDG_CONFIG_HOME = join(f.scratch, "different-config");
      assert.equal((await check("opencode plugin")).ok, true, "doctor finds the recorded installation directory");
    } finally {
      f.cleanup();
    }
  });
});
