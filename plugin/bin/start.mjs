// Starts Self-Starter when the plugin comes from the marketplace in its repository
// (`codex plugin marketplace add hyprh/self-starter`, or `/plugin marketplace add
// hyprh/self-starter` in Claude Code). The first start installs the runtime of this
// plugin's version, with its background service and deno, into
// ~/.self-starter/runtime/<version>; later starts need no network.
// SELF_STARTER_RUNTIME installs from somewhere else, such as a tarball in tests.
//
// The same file is the launcher of both plugins (plugin/ for Codex, cc-plugin/ for
// Claude Code); a test keeps the two copies identical.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "github:hyprh/self-starter";

function fail(message) {
  process.stderr.write(`self-starter: ${message}\n`);
  process.exit(1);
}

if (Number(process.versions.node.split(".")[0]) < 20) fail(`Node.js 20 or newer is required (this is ${process.version})`);

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = [".codex-plugin", ".claude-plugin"].map((dir) => join(pluginRoot, dir, "plugin.json")).find((path) => existsSync(path));
if (!manifest) fail(`no plugin manifest in ${pluginRoot}`);
const { version } = JSON.parse(readFileSync(manifest, "utf8"));
const home = resolve(process.env.SELF_STARTER_HOME || join(homedir(), ".self-starter"));
const runtime = join(home, "runtime", version);
const cli = join(runtime, "node_modules", "self-starter", "dist", "src", "cli", "main.js");
const source = process.env.SELF_STARTER_RUNTIME || `${REPOSITORY}#v${version}`;

/** Installs the runtime beside its final folder and moves it into place, so that no start ever sees half of one. */
function install() {
  const staging = `${runtime}.${process.pid}.partial`;
  mkdirSync(staging, { recursive: true });
  // What an install that was stopped left behind.
  for (const name of readdirSync(dirname(runtime))) {
    const path = join(dirname(runtime), name);
    if (name.endsWith(".partial") && path !== staging && Date.now() - statSync(path).mtimeMs > 15 * 60_000) rmSync(path, { recursive: true, force: true });
  }
  const npm = spawnSync("npm", ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", source], { stdio: ["ignore", 2, 2] });
  if (npm.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    fail(`could not install ${source}: ${npm.error ? npm.error.message : `npm exited with code ${npm.status}`}`);
  }
  try {
    renameSync(staging, runtime);
  } catch {
    rmSync(staging, { recursive: true, force: true }); // another start finished first
  }
  if (!existsSync(cli)) fail(`the runtime in ${runtime} has no ${cli}`);
}

if (process.env.SELF_STARTER_INSTALL_ONLY === "1") {
  install();
  process.exit(0);
}

if (!existsSync(cli)) {
  // The install runs in a process of its own, which outlives this one: a host that
  // gives up on a slow first start (Claude Code waits 30 seconds) and stops this
  // process does not stop the install, and the next start finds the runtime ready.
  process.stderr.write(`self-starter: installing ${source} into ${runtime}, once for this version\n`);
  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = join(logs, "install.log");
  const out = openSync(log, "w", 0o600);
  const installer = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SELF_STARTER_INSTALL_ONLY: "1" },
  });
  const code = await new Promise((done) => {
    installer.on("error", () => done(-1));
    installer.on("exit", (exitCode) => done(exitCode));
  });
  if (code !== 0 || !existsSync(cli)) {
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const reason = lines.reverse().find((line) => line.startsWith("self-starter: "));
    fail(reason ? reason.slice("self-starter: ".length) : `could not install ${source}; see ${log}`);
  }
}

process.argv = [process.argv[0], cli, ...process.argv.slice(2)];
await import(pathToFileURL(cli).href);
