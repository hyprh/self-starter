// Starts Self-Starter for Codex when the plugin comes from the marketplace in its
// repository (`codex plugin marketplace add hyprh/self-starter`). The first start
// installs the runtime of this plugin's version, with its background service and
// deno, into ~/.self-starter/runtime/<version>; later starts need no network.
// SELF_STARTER_RUNTIME installs from somewhere else, such as a tarball in tests.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
const { version } = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const home = resolve(process.env.SELF_STARTER_HOME || join(homedir(), ".self-starter"));
const runtime = join(home, "runtime", version);
const cli = join(runtime, "node_modules", "self-starter", "dist", "src", "cli", "main.js");

if (!existsSync(cli)) {
  // Installed beside its final folder and moved into place, so that an interrupted
  // start, or two Codex sessions starting at once, never leave half a runtime.
  const source = process.env.SELF_STARTER_RUNTIME || `${REPOSITORY}#v${version}`;
  const staging = `${runtime}.${process.pid}.partial`;
  mkdirSync(staging, { recursive: true });
  // What a start that Codex gave up on left behind.
  for (const name of readdirSync(dirname(runtime))) {
    const path = join(dirname(runtime), name);
    if (name.endsWith(".partial") && path !== staging && Date.now() - statSync(path).mtimeMs > 15 * 60_000) rmSync(path, { recursive: true, force: true });
  }
  process.stderr.write(`self-starter: installing ${source} into ${runtime}, once for this version\n`);
  const npm = spawnSync("npm", ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", source], {
    stdio: ["ignore", 2, 2],
  });
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

process.argv = [process.argv[0], cli, ...process.argv.slice(2)];
await import(pathToFileURL(cli).href);
