import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../src/runtime.js";

/** This intentionally uses real npm: a fake installer cannot catch npm source policies. */
it("bootstraps prepared Git runtimes, upgrades an existing cache, and starts cached runtimes offline", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ss-bootstrap-policy-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = join(scratch, "source");
  const plugin = join(scratch, "plugin");
  const home = join(scratch, "home");
  for (const dir of [source, join(plugin, "bin"), join(plugin, ".codex-plugin")]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, "codex-plugin", "bin", "start.mjs"), join(plugin, "bin", "start.mjs"));
  const userConfig = join(scratch, "user.npmrc");
  const globalConfig = join(scratch, "global.npmrc");
  const gitConfig = join(scratch, "gitconfig");
  for (const file of [userConfig, globalConfig, gitConfig]) writeFileSync(file, "");
  const env = {
    PATH: process.env.PATH, HOME: join(scratch, "user"), SELF_STARTER_HOME: home,
    npm_config_cache: join(scratch, "npm-cache"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = scratch) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "self-starter", version: "0.0.1", type: "module", files: ["dist"], scripts: { prepare: "node prepare.cjs" },
  }));
  writeFileSync(join(source, "prepare.cjs"), `
const fs = require("node:fs");
fs.mkdirSync("dist/src/cli", { recursive: true });
fs.writeFileSync("dist/src/cli/main.js", 'console.log("prepared-runtime " + process.argv.slice(2).join(" "));\\n');
`);
  run("git", ["init", "-q"], {}, source);
  run("git", ["add", "."], {}, source);
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {}, source);
  run("git", ["tag", "v0.0.1"], {}, source);
  run("git", ["tag", "v0.0.2"], {}, source);
  const launcher = join(plugin, "bin", "start.mjs");
  const manifest = join(plugin, ".codex-plugin", "plugin.json");
  for (const version of ["0.0.1", "0.0.2"]) {
    writeFileSync(manifest, JSON.stringify({ version }));
    const installed = run(process.execPath, [launcher, "version"], { SELF_STARTER_RUNTIME: `git+${pathToFileURL(source).href}#v${version}` });
    assert.equal(installed, "prepared-runtime version");
    assert.ok(existsSync(join(home, "runtime", version, "node_modules", "self-starter", "dist", "src", "cli", "main.js")));
    assert.equal(run(process.execPath, [launcher, "version"], { PATH: join(scratch, "offline"), SELF_STARTER_RUNTIME: "/does-not-exist" }),
      "prepared-runtime version", "a cached runtime must not need npm or fetch its source again");
  }
  assert.ok(existsSync(join(home, "runtime", "0.0.1")), "upgrading keeps the older cached runtime");
  const tarball = run("npm", ["pack", "--pack-destination", scratch, "--silent"], {}, source).split("\n").at(-1)!;
  writeFileSync(manifest, JSON.stringify({ version: "0.0.3" }));
  assert.equal(run(process.execPath, [launcher, "version"], { SELF_STARTER_RUNTIME: join(scratch, tarball) }),
    "prepared-runtime version", "explicit tarball overrides still install with the same launcher");
  if (Number.parseInt(run("npm", ["--version"]), 10) >= 12) {
    const child = join(scratch, "child");
    mkdirSync(child);
    writeFileSync(join(child, "package.json"), '{"name":"test-child","version":"1.0.0"}');
    run("git", ["init", "-q"], {}, child);
    run("git", ["add", "."], {}, child);
    run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "child"], {}, child);
    const packageFile = join(source, "package.json");
    writeFileSync(packageFile, JSON.stringify({
      ...JSON.parse(readFileSync(packageFile, "utf8")), dependencies: { "test-child": `git+${pathToFileURL(child).href}` },
    }));
    run("git", ["add", "."], {}, source);
    run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "transitive Git dependency"], {}, source);
    writeFileSync(manifest, JSON.stringify({ version: "0.0.4" }));
    const denied = spawnSync(process.execPath, [launcher, "version"], {
      env: { ...env, SELF_STARTER_RUNTIME: `git+${pathToFileURL(source).href}` }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(denied.status, 1, "authorizing the selected runtime must not authorize its transitive Git dependencies");
    assert.match(readFileSync(join(home, "logs", "install.log"), "utf8"), /EALLOWGIT[\s\S]*non-root/);
  }
  assert.equal(readFileSync(userConfig, "utf8"), "", "installation does not change the user's npm policy");
  assert.equal(readFileSync(globalConfig, "utf8"), "");
});
