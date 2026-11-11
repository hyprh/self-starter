import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ephemeralAction, isEphemeralPackageRoot, runtimeCliPath } from "../../src/cli/ephemeral.js";
import { MCP_SERVER_NAME, openCodePluginPath, PLUGIN_NAME } from "../../src/cli/install.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { PACKAGE_ROOT, VERSION } from "../../src/runtime.js";
import { stopRunningDaemon } from "../../src/service/manager.js";

describe("ephemeral npx / dlx runtime persistence", () => {
  it("recognizes ephemeral package-runner cache paths without matching normal installs", () => {
    assert.equal(isEphemeralPackageRoot("/home/user/.npm/_npx/8a9b1c2d/node_modules/self-starter"), true);
    assert.equal(isEphemeralPackageRoot("/Users/dev/.cache/pnpm/dlx/abc/node_modules/self-starter"), true);
    assert.equal(isEphemeralPackageRoot("/home/user/.local/share/pnpm/store/v3/tmp/dlx-42190/node_modules/self-starter"), true);
    assert.equal(isEphemeralPackageRoot("/tmp/bunx-1000-self-starter@0.0.8/node_modules/self-starter"), true);

    assert.equal(isEphemeralPackageRoot("/usr/local/lib/node_modules/self-starter"), false);
    assert.equal(isEphemeralPackageRoot("/home/user/.self-starter/runtime/0.0.8/node_modules/self-starter"), false);
    assert.equal(isEphemeralPackageRoot("/home/user/workspace/self-starter"), false);
  });

  it("classifies read-only, conditional, and materializing CLI commands", () => {
    assert.equal(ephemeralAction(undefined, undefined), "none");
    assert.equal(ephemeralAction("help", undefined), "none");
    assert.equal(ephemeralAction("version", undefined), "none");
    assert.equal(ephemeralAction("uninstall", undefined), "none");
    assert.equal(ephemeralAction("service", "stop"), "none");
    assert.equal(ephemeralAction("service", "uninstall"), "none");

    assert.equal(ephemeralAction("doctor", undefined), "if-present");
    assert.equal(ephemeralAction("logs", undefined), "if-present");
    assert.equal(ephemeralAction("service", "status"), "if-present");
    assert.equal(ephemeralAction("service", undefined), "if-present");

    assert.equal(ephemeralAction("install", undefined), "materialize");
    assert.equal(ephemeralAction("service", "install"), "materialize");
    assert.equal(ephemeralAction("ui", undefined), "materialize");
    assert.equal(ephemeralAction("mcp", undefined), "materialize");
  });

  it("persists runtime out of _npx on install so plugins, daemon and bin wrapper survive _npx cache eviction", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ss-npx-install-"));
    const npxNodeModules = join(scratch, "npm-cache", "_npx", "f00baa42", "node_modules");
    const npxPkg = join(npxNodeModules, "self-starter");
    mkdirSync(npxPkg, { recursive: true });

    // Populate a realistic unpacked tarball layout in _npx/f00baa42/node_modules/self-starter.
    for (const item of ["package.json", "dist", "codex-plugin", "cc-plugin", "agy-plugin", "zcode-plugin", "opencode-plugin", "recipes"]) {
      cpSync(join(PACKAGE_ROOT, item), join(npxPkg, item), { recursive: true });
    }
    mkdirSync(join(npxNodeModules, "@opencode-ai"), { recursive: true });
    for (const dep of ["deno", "jsonc-parser", "nodemailer", "yaml", "@opencode-ai/plugin", "@opencode-ai/sdk"]) {
      const target = join(npxNodeModules, ...dep.split("/"));
      symlinkSync(join(PACKAGE_ROOT, "node_modules", ...dep.split("/")), target);
    }

    const paths = resolvePaths(join(scratch, "ss-home"));
    const xdgConfig = join(scratch, "xdg-config");
    const mockBins = join(scratch, "mock-bins");
    mkdirSync(mockBins, { recursive: true });

    const agyBin = join(mockBins, "agy");
    writeFileSync(
      agyBin,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "--version") console.log("1.4.8");\nelse if (args[0] === "plugin" && args[1] === "list") console.log(JSON.stringify([{ name: ${JSON.stringify(PLUGIN_NAME)}, enabled: true }]));\nelse console.log("ok");\n`,
      { mode: 0o755 },
    );
    const opencodeBin = join(mockBins, "opencode");
    writeFileSync(
      opencodeBin,
      `#!${process.execPath}\nif (process.argv[2] === "--version") console.log("1.19.5");\nelse console.log("ok");\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(mockBins, "notify-send"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: scratch,
      XDG_CONFIG_HOME: xdgConfig,
      SELF_STARTER_HOME: paths.home,
      PATH: mockBins,
      CODEX_BIN: "",
      CLAUDE_BIN: "",
      ZCODE_BIN: "",
      AGY_BIN: "",
      OPENCODE_BIN: "",
    };

    try {
      const npxCli = join(npxPkg, "dist", "src", "cli", "main.js");

      // 1. `doctor` before install must not materialize `<home>/runtime`.
      const preDoctor = spawnSync(process.execPath, [npxCli, "doctor"], { env: baseEnv, encoding: "utf8" });
      assert.notEqual(preDoctor.status, 0);
      assert.equal(existsSync(join(paths.home, "runtime")), false, "doctor alone must not materialize runtime");

      // 2. `npx self-starter install` materializes `<home>/runtime/<VERSION>` and wires everything to it.
      const installed = spawnSync(
        process.execPath,
        [npxCli, "install", "--agy", agyBin, "--opencode", opencodeBin, "--no-service"],
        { env: baseEnv, encoding: "utf8" },
      );
      assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

      const persistedCli = runtimeCliPath(paths, VERSION);
      assert.equal(existsSync(persistedCli), true, "runtime CLI persisted under ~/.self-starter/runtime/<version>");
      assert.match(installed.stdout, /cli command: .*\/bin\/self-starter/);

      // 3. Evict the entire `_npx` cache directory to prove zero lingering references to `_npx`.
      rmSync(join(scratch, "npm-cache"), { recursive: true, force: true });
      assert.equal(existsSync(npxCli), false);

      const agyMcp = JSON.parse(readFileSync(join(paths.marketplace, "agy-plugin", "mcp_config.json"), "utf8"));
      assert.equal(agyMcp.mcpServers[MCP_SERVER_NAME].args[0], persistedCli);
      assert.doesNotMatch(agyMcp.mcpServers[MCP_SERVER_NAME].args[0], /_npx/);

      const ocLoader = readFileSync(openCodePluginPath(join(xdgConfig, "opencode")), "utf8");
      assert.doesNotMatch(ocLoader, /_npx/);
      assert.match(ocLoader, /runtime/);

      // 4. `<home>/bin/self-starter` continues working after `_npx` was deleted!
      const wrapper = join(paths.home, "bin", "self-starter");
      assert.equal(existsSync(wrapper), true);
      const verOut = spawnSync(wrapper, ["version"], { env: baseEnv, encoding: "utf8" });
      assert.equal(verOut.status, 0, verOut.stderr);
      assert.equal(verOut.stdout.trim(), VERSION);

      const docOut = spawnSync(wrapper, ["doctor"], { env: baseEnv, encoding: "utf8" });
      for (const expected of ["✓ node", "✓ deno", "✓ antigravity", "✓ agy plugin", "✓ opencode", "✓ opencode plugin", "✓ daemon"]) {
        assert.match(docOut.stdout, new RegExp(expected), docOut.stdout);
      }

      // 5. `uninstall --purge` removes the persisted runtime cleanly.
      const uninstalled = spawnSync(wrapper, ["uninstall", "--purge"], { env: baseEnv, encoding: "utf8" });
      assert.equal(uninstalled.status, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
      assert.equal(existsSync(paths.home), false);
    } finally {
      await stopRunningDaemon(paths);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
