// `self-starter install`, `self-starter uninstall` and `self-starter doctor`: wiring Self-Starter into Codex.
//
// The plugin is copied into a local marketplace under ~/.self-starter, with an
// .mcp.json that starts this installation's MCP server through absolute paths, so
// it does not depend on the PATH that the Codex app gives its MCP servers.

import { spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { bundledDeno, loadConfig, resolveCodex, resolveDeno, saveConfig, which } from "../engine/config.js";
import { ensurePrivateDir, writeJsonAtomic } from "../engine/fs-util.js";
import type { Paths } from "../engine/paths.js";
import { Store } from "../engine/store.js";
import { CLI_SCRIPT, PLUGIN_SOURCE, VERSION } from "../runtime.js";
import { serviceManager, serviceSpec, spawnDetachedDaemon } from "../service/manager.js";

export const MARKETPLACE_NAME = "self-starter";
export const PLUGIN_NAME = "self-starter";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MCP_SERVER_NAME = "self_starter";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A codex binary inside a macOS app bundle (the Codex app, or the ChatGPT app that ships Codex). */
function findInAppBundles(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const bundles = ["/Applications/Codex.app", join(homedir(), "Applications/Codex.app"), "/Applications/ChatGPT.app", join(homedir(), "Applications/ChatGPT.app")];
  const search = (dir: string, depth: number): string | undefined => {
    if (depth < 0 || !existsSync(dir)) return undefined;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === "codex" && isExecutable(path)) return path;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = search(join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const bundle of bundles) {
    const found = search(join(bundle, "Contents"), 4);
    if (found) return found;
  }
  return undefined;
}

export function findCodex(): string | undefined {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  return which("codex") ?? findInAppBundles();
}

function runCodex(codexBin: string, args: string[]): { ok: boolean; output: string } {
  const isScript = /\.[cm]?js$/.test(codexBin);
  const out = spawnSync(isScript ? process.execPath : codexBin, isScript ? [codexBin, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  const output = `${out.stdout ?? ""}${out.stderr ?? ""}`
    .split("\n")
    .filter((line) => !line.startsWith("WARNING: proceeding"))
    .join("\n")
    .trim();
  return { ok: out.status === 0, output };
}

/** Writes the local marketplace with this installation's plugin and MCP server command. */
export function buildMarketplace(paths: Paths): string {
  const pluginDir = join(paths.marketplace, "plugins", PLUGIN_NAME);
  ensurePrivateDir(paths.marketplace);
  rmSync(pluginDir, { recursive: true, force: true });
  cpSync(PLUGIN_SOURCE, pluginDir, { recursive: true });
  const manifestPath = join(pluginDir, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  writeJsonAtomic(manifestPath, { ...manifest, version: VERSION });
  writeJsonAtomic(join(pluginDir, ".mcp.json"), {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [CLI_SCRIPT, "mcp"],
        cwd: ".",
        env: { SELF_STARTER_HOME: paths.home, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) },
        startup_timeout_sec: 30,
      },
    },
  });
  writeJsonAtomic(join(paths.marketplace, ".agents", "plugins", "marketplace.json"), {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Self-Starter" },
    plugins: [{ name: PLUGIN_NAME, source: { source: "local", path: `./plugins/${PLUGIN_NAME}` } }],
  });
  return pluginDir;
}

async function stopRunningDaemon(paths: Paths): Promise<void> {
  if (!(await isDaemonRunning(paths.socket))) return;
  await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await isDaemonRunning(paths.socket))) await new Promise((r) => setTimeout(r, 200));
}

export interface InstallOptions {
  codex?: string;
  service: boolean;
  log: (line: string) => void;
}

export async function install(paths: Paths, options: InstallOptions): Promise<void> {
  const { log } = options;
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20 or newer is required (this is ${process.version})`);
  new Store(paths).ensureLayout();

  const config = loadConfig(paths);
  const codexBin = options.codex ?? findCodex();
  if (!codexBin || !isExecutable(codexBin)) {
    throw new Error(
      "codex was not found. Install the Codex CLI (npm install -g @openai/codex), or pass --codex <path> (the Codex app on macOS ships one inside its bundle).",
    );
  }
  config.codexBin = codexBin;
  saveConfig(paths, config);
  log(`codex: ${codexBin}`);

  const deno = resolveDeno(config);
  if (!deno) throw new Error("deno was not found; run `npm install` in the self-starter folder (it ships deno), or install deno");
  log(`deno: ${deno}`);

  const pluginDir = buildMarketplace(paths);
  log(`plugin files: ${pluginDir}`);

  const added = runCodex(codexBin, ["plugin", "marketplace", "add", paths.marketplace]);
  if (!added.ok && !/already/i.test(added.output)) throw new Error(`codex plugin marketplace add failed: ${added.output}`);
  const plugin = runCodex(codexBin, ["plugin", "add", PLUGIN_ID]);
  if (!plugin.ok) throw new Error(`codex plugin add failed: ${plugin.output}`);
  log(`Codex plugin installed: ${PLUGIN_ID}`);

  await stopRunningDaemon(paths);
  const manager = serviceManager();
  if (options.service && manager.kind !== "none") {
    manager.install(serviceSpec(paths, codexBin));
    if (!(await waitForDaemon(paths.socket, 10_000))) throw new Error(`the service did not start; see ${join(paths.logs, "service.log")}`);
    log(`background service: ${manager.kind} (${manager.file})`);
  } else {
    spawnDetachedDaemon(paths);
    if (!(await waitForDaemon(paths.socket, 10_000))) throw new Error(`the daemon did not start; see ${join(paths.logs, "service.log")}`);
    log(
      options.service
        ? "background service: no launchd or systemd user session here, so the daemon runs as a detached process until the next restart"
        : "background service: not installed (--no-service); the daemon runs until the next restart",
    );
  }
}

export async function uninstall(paths: Paths, options: { purge: boolean; log: (line: string) => void }): Promise<void> {
  const { log } = options;
  serviceManager().uninstall();
  await stopRunningDaemon(paths);
  log("background service removed");
  const codexBin = loadConfig(paths).codexBin ?? findCodex();
  if (codexBin) {
    runCodex(codexBin, ["plugin", "remove", PLUGIN_ID]);
    runCodex(codexBin, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    log("Codex plugin removed");
  }
  rmSync(paths.marketplace, { recursive: true, force: true });
  if (options.purge) {
    rmSync(paths.home, { recursive: true, force: true });
    log(`deleted ${paths.home}`);
  } else {
    log(`kept your triggers and history in ${paths.home} (use --purge to delete them)`);
  }
}

export interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

export async function doctor(paths: Paths): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });
  const config = loadConfig(paths);

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20, "node", `${process.version} (${process.execPath})`);

  const deno = resolveDeno(config);
  if (deno) {
    const out = spawnSync(deno, ["--version"], { encoding: "utf8" });
    add(out.status === 0, "deno", `${(out.stdout ?? "").split("\n")[0] ?? ""} (${deno}${deno === bundledDeno() ? ", bundled" : ""})`);
  } else {
    add(false, "deno", "not found; run `npm install` in the self-starter folder");
  }

  const codexBin = resolveCodex(config) ?? findCodex();
  if (codexBin) {
    const version = runCodex(codexBin, ["--version"]);
    add(version.ok, "codex", `${version.output.split("\n")[0] ?? ""} (${codexBin})`);
    const queue = runCodex(codexBin, ["queue", "--help"]);
    add(queue.ok, "codex queue", queue.ok ? "available (fires reach the thread where a trigger was made)" : "missing; update the Codex CLI");
    const appServer = runCodex(codexBin, ["app-server", "--help"]);
    add(appServer.ok, "app server", appServer.ok ? "available (dedicated threads, and waking threads no Codex app has open)" : "missing; update the Codex CLI");
    const plugins = runCodex(codexBin, ["plugin", "list", "--marketplace", MARKETPLACE_NAME]);
    add(plugins.ok && plugins.output.includes(PLUGIN_NAME), "plugin", plugins.ok ? `${PLUGIN_ID} registered` : "not installed; run `self-starter install`");
  } else {
    add(false, "codex", "not found; install the Codex CLI or run `self-starter install --codex <path>`");
  }

  const manager = serviceManager();
  add(manager.kind === "none" || manager.installed(), "service", manager.kind === "none" ? "no service manager here" : manager.installed() ? `${manager.kind}: ${manager.file}` : "not installed; run `self-starter service install`");

  if (await isDaemonRunning(paths.socket)) {
    const status = await callDaemon<{ version: string; pid: number; triggers: { total: number } }>(paths.socket, "status", {});
    add(status.version === VERSION, "daemon", `running, pid ${status.pid}, version ${status.version}${status.version === VERSION ? "" : ` (this self-starter is ${VERSION}; run \`self-starter service restart\`)`}, ${status.triggers.total} trigger(s)`);
  } else {
    add(false, "daemon", "not running; run `self-starter service start`");
  }

  const notifier =
    process.platform === "darwin"
      ? which("terminal-notifier")
        ? "terminal-notifier (clicks open the thread)"
        : "osascript (install terminal-notifier so clicks open the thread)"
      : which("notify-send")
        ? "notify-send"
        : undefined;
  add(notifier !== undefined, "notifications", notifier ?? "notify-send not found; install libnotify to get notifications");
  return checks;
}
