// `self-starter install`, `self-starter uninstall` and `self-starter doctor`: wiring Self-Starter into
// the agents on this machine: Codex, Claude Code and ZCode.
//
// The plugins are copied into a local marketplace under ~/.self-starter, laid out like this
// repository (one folder that all agents read), with an MCP server command that starts this
// installation through absolute paths, so it does not depend on the PATH an agent gives its MCP servers.

import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { bundledDeno, cliCommand, findCodex, isExecutable, loadConfig, resolveDeno, saveConfig, which } from "../engine/config.js";
import { ensurePrivateDir, writeJsonAtomic } from "../engine/fs-util.js";
import type { Paths } from "../engine/paths.js";
import { findClaude } from "../engine/sessions.js";
import { Store } from "../engine/store.js";
import { findZCode } from "../engine/zcode.js";
import { CC_PLUGIN_SOURCE, CLI_SCRIPT, PLUGIN_SOURCE, VERSION, ZCODE_PLUGIN_SOURCE } from "../runtime.js";
import { compareVersions, installService, serviceManager, spawnDetachedDaemon, stopRunningDaemon } from "../service/manager.js";

export const MARKETPLACE_NAME = "self-starter";
export const PLUGIN_NAME = "self-starter";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MCP_SERVER_NAME = "self_starter";
/** The first Claude Code with inboxes, through which fires come into open sessions. */
const CLAUDE_INBOX_VERSION = "2.1.224";

/** Runs an agent's CLI as the daemon does, so that what doctor sees is what the daemon gets. */
function runCli(bin: string, args: string[]): { ok: boolean; output: string } {
  const { command, prefix } = cliCommand(bin);
  const out = spawnSync(command, [...prefix, ...args], {
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

/** Copies a plugin into the local marketplace, at this installation's version. */
function copyPlugin(source: string, target: string, manifestDir: string): string {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  const manifestPath = join(target, manifestDir, "plugin.json");
  writeJsonAtomic(manifestPath, { ...(JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>), version: VERSION });
  return target;
}

/** Writes each host's plugin and marketplace manifest beside the others. */
export function buildMarketplace(paths: Paths): void {
  ensurePrivateDir(paths.marketplace);
  const server = { command: process.execPath, args: [CLI_SCRIPT, "mcp"] };
  const env = { SELF_STARTER_HOME: paths.home };

  const codexPlugin = copyPlugin(PLUGIN_SOURCE, join(paths.marketplace, "plugins", PLUGIN_NAME), ".codex-plugin");
  writeJsonAtomic(join(codexPlugin, ".mcp.json"), {
    mcpServers: {
      [MCP_SERVER_NAME]: { ...server, cwd: ".", env: { ...env, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) }, startup_timeout_sec: 30 },
    },
  });
  writeJsonAtomic(join(paths.marketplace, ".agents", "plugins", "marketplace.json"), {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Self-Starter" },
    plugins: [{ name: PLUGIN_NAME, source: { source: "local", path: `./plugins/${PLUGIN_NAME}` } }],
  });

  const claudePlugin = copyPlugin(CC_PLUGIN_SOURCE, join(paths.marketplace, "cc-plugin"), ".claude-plugin");
  writeJsonAtomic(join(claudePlugin, ".mcp.json"), { mcpServers: { [MCP_SERVER_NAME]: { ...server, env } } });
  writeJsonAtomic(join(paths.marketplace, ".claude-plugin", "marketplace.json"), {
    name: MARKETPLACE_NAME,
    owner: { name: "Self-Starter" },
    plugins: [{ name: PLUGIN_NAME, source: "./cc-plugin" }],
  });

  const zcodePlugin = copyPlugin(ZCODE_PLUGIN_SOURCE, join(paths.marketplace, "zcode-plugin"), ".zcode-plugin");
  writeJsonAtomic(join(zcodePlugin, ".mcp.json"), {
    mcpServers: { [MCP_SERVER_NAME]: { ...server, env: { ...env, SELF_STARTER_HOST: "zcode" }, timeoutMs: 30_000 } },
  });
  writeJsonAtomic(join(paths.marketplace, "marketplace.json"), {
    name: MARKETPLACE_NAME,
    plugins: [{ name: PLUGIN_NAME, source: "./zcode-plugin", version: VERSION }],
  });
}

export interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

/** An agent on this machine: how the plugin is added to it, checked and removed. */
interface Agent {
  /** As the user knows it. */
  name: string;
  /** The config.json key that records its CLI. */
  configKey: "codexBin" | "claudeBin" | "zcodeBin";
  bin: string;
  install(paths: Paths): void;
  uninstall(): void;
  checks(): Check[];
}

function codexAgent(bin: string): Agent {
  const run = (args: string[]) => runCli(bin, args);
  return {
    name: "Codex",
    configKey: "codexBin",
    bin,
    install(paths) {
      const added = run(["plugin", "marketplace", "add", paths.marketplace]);
      if (!added.ok && !/already/i.test(added.output)) throw new Error(`codex plugin marketplace add failed: ${added.output}`);
      const plugin = run(["plugin", "add", PLUGIN_ID]);
      if (!plugin.ok) throw new Error(`codex plugin add failed: ${plugin.output}`);
    },
    uninstall() {
      run(["plugin", "remove", PLUGIN_ID]);
      run(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    },
    checks() {
      const version = run(["--version"]);
      const queue = run(["queue", "--help"]);
      const appServer = run(["app-server", "--help"]);
      const plugins = run(["plugin", "list", "--marketplace", MARKETPLACE_NAME]);
      return [
        { ok: version.ok, label: "codex", detail: `${version.output.split("\n")[0] ?? ""} (${bin})` },
        { ok: queue.ok, label: "codex queue", detail: queue.ok ? "available (fires reach the thread where a trigger was made)" : "missing; update the Codex CLI" },
        { ok: appServer.ok, label: "app server", detail: appServer.ok ? "available (dedicated threads, and waking threads no Codex app has open)" : "missing; update the Codex CLI" },
        { ok: plugins.ok && plugins.output.includes(PLUGIN_NAME), label: "codex plugin", detail: plugins.ok ? `${PLUGIN_ID} registered` : "not installed; run `self-starter install`" },
      ];
    },
  };
}

function claudeAgent(bin: string): Agent {
  const run = (args: string[]) => runCli(bin, args);
  return {
    name: "Claude Code",
    configKey: "claudeBin",
    bin,
    install(paths) {
      const added = run(["plugin", "marketplace", "add", paths.marketplace]);
      if (!added.ok && !/already/i.test(added.output)) throw new Error(`claude plugin marketplace add failed: ${added.output}`);
      const plugin = run(["plugin", "install", PLUGIN_ID]);
      if (!plugin.ok) throw new Error(`claude plugin install failed: ${plugin.output}`);
    },
    uninstall() {
      run(["plugin", "uninstall", PLUGIN_ID]);
      run(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    },
    checks() {
      const version = run(["--version"]);
      const number = /\d+\.\d+\.\d+/.exec(version.output)?.[0];
      const inboxes = number !== undefined && compareVersions(number, CLAUDE_INBOX_VERSION) >= 0;
      const listed = run(["plugin", "list", "--json"]);
      let plugin: { enabled?: boolean } | undefined;
      try {
        plugin = (JSON.parse(listed.output) as Array<{ id?: string; enabled?: boolean }>).find((entry) => entry.id === PLUGIN_ID);
      } catch {
        // reported below
      }
      return [
        { ok: version.ok, label: "claude", detail: `${version.output.split("\n")[0] ?? ""} (${bin})` },
        {
          ok: inboxes,
          label: "sessions",
          detail: inboxes ? "fires come into open sessions, and resume closed ones" : `update Claude Code to ${CLAUDE_INBOX_VERSION} or newer, so that fires can come into open sessions`,
        },
        {
          ok: plugin?.enabled === true,
          label: "claude plugin",
          detail: plugin ? (plugin.enabled ? `${PLUGIN_ID} installed` : `${PLUGIN_ID} is disabled; enable it with /plugin`) : "not installed; run `self-starter install`",
        },
      ];
    },
  };
}

function zcodeAgent(bin: string): Agent {
  const run = (args: string[]) => runCli(bin, args);
  return {
    name: "ZCode",
    configKey: "zcodeBin",
    bin,
    install(paths) {
      // A directory also has Claude Code's catalog, which ZCode would prefer over marketplace.json.
      const added = run(["plugins", "marketplace", "add", join(paths.marketplace, "marketplace.json"), "--scope", "user"]);
      if (!added.ok) throw new Error(`zcode plugins marketplace add failed: ${added.output}`);
      const plugin = run(["plugins", "install", PLUGIN_ID, "--scope", "user"]);
      if (!plugin.ok) throw new Error(`zcode plugins install failed: ${plugin.output}`);
      const enabled = run(["plugins", "enable", PLUGIN_ID, "--scope", "user"]);
      if (!enabled.ok) throw new Error(`zcode plugins enable failed: ${enabled.output}`);
    },
    uninstall() {
      run(["plugins", "uninstall", PLUGIN_ID, "--scope", "user", "--keep-data", "--force"]);
      run(["plugins", "marketplace", "remove", MARKETPLACE_NAME]);
    },
    checks() {
      const version = run(["--version"]);
      const listed = run(["plugins", "list", "--json"]);
      let plugin: { enabled?: boolean; diagnostics?: Array<{ severity?: string }> } | undefined;
      try {
        plugin = (JSON.parse(listed.output) as Array<typeof plugin & { id?: string }>).find((entry) => entry?.id === PLUGIN_ID);
      } catch {
        // Missing or invalid output is reported below, without claiming the plugin is loaded.
      }
      const usable = listed.ok && plugin?.enabled === true && !plugin.diagnostics?.some((diagnostic) => diagnostic.severity === "error");
      return [
        { ok: version.ok, label: "zcode", detail: `${version.output.split("\n")[0] ?? ""} (${bin})` },
        {
          ok: usable,
          label: "zcode plugin",
          detail: usable
            ? `${PLUGIN_ID} enabled (dedicated CLI result sessions; model access is not checked)`
            : plugin?.enabled === false
              ? `${PLUGIN_ID} is disabled; run \`zcode plugins enable ${PLUGIN_ID} --scope user\``
              : "not loaded without errors; run `self-starter install` and `zcode plugins list --json`",
        },
      ];
    },
  };
}

/** The agents here, from the CLIs given, or found on PATH (and, for codex, in the macOS app bundles). */
function agentsFound(bins: { codex?: string | undefined; claude?: string | undefined; zcode?: string | undefined }): Agent[] {
  const codex = bins.codex ?? findCodex();
  const claude = bins.claude ?? findClaude();
  const zcode = bins.zcode ?? findZCode();
  return [...(codex ? [codexAgent(codex)] : []), ...(claude ? [claudeAgent(claude)] : []), ...(zcode ? [zcodeAgent(zcode)] : [])];
}

export interface InstallOptions {
  codex?: string;
  claude?: string;
  zcode?: string;
  service: boolean;
  log: (line: string) => void;
}

export async function install(paths: Paths, options: InstallOptions): Promise<void> {
  const { log } = options;
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20 or newer is required (this is ${process.version})`);
  new Store(paths).ensureLayout();

  for (const [name, bin] of [["codex", options.codex], ["claude", options.claude], ["zcode", options.zcode]] as const) {
    if (bin && !isExecutable(bin)) throw new Error(`--${name} ${bin} is not an executable`);
  }
  const config = loadConfig(paths);
  const agents = agentsFound(options);
  if (agents.length === 0) {
    throw new Error(
      "No supported agent was found. Install the Codex CLI (npm install -g @openai/codex), Claude Code or ZCode, or pass --codex <path>, --claude <path> or --zcode <path> (the Codex app on macOS ships codex inside its bundle).",
    );
  }
  for (const agent of agents) {
    config[agent.configKey] = agent.bin;
    log(`${agent.name}: ${agent.bin}`);
  }
  saveConfig(paths, config);

  const deno = resolveDeno(config);
  if (!deno) throw new Error("deno was not found; run `npm install` in the self-starter folder (it ships deno), or install deno");
  log(`deno: ${deno}`);

  buildMarketplace(paths);
  log(`plugin files: ${paths.marketplace}`);
  for (const agent of agents) {
    agent.install(paths);
    log(`${agent.name} plugin installed: ${PLUGIN_ID}`);
  }

  const manager = serviceManager();
  if (options.service && manager.kind !== "none") {
    await installService(paths, manager);
    if (!(await waitForDaemon(paths.socket, 10_000))) throw new Error(`the service did not start; see ${join(paths.logs, "service.log")}`);
    log(`background service: ${manager.kind} (${manager.file})`);
  } else {
    if (!options.service) saveConfig(paths, { ...loadConfig(paths), service: false });
    await stopRunningDaemon(paths);
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
  const config = loadConfig(paths);
  for (const agent of agentsFound({ codex: config.codexBin, claude: config.claudeBin, zcode: config.zcodeBin })) {
    agent.uninstall();
    log(`${agent.name} plugin removed`);
  }
  rmSync(paths.marketplace, { recursive: true, force: true });
  if (options.purge) {
    rmSync(paths.home, { recursive: true, force: true });
    log(`deleted ${paths.home}`);
  } else {
    log(`kept your triggers and history in ${paths.home} (use --purge to delete them)`);
  }
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

  const agents = agentsFound({ codex: config.codexBin, claude: config.claudeBin, zcode: config.zcodeBin });
  add(agents.length > 0, "agents", agents.length > 0 ? agents.map((agent) => agent.name).join(", ") : "no supported agent found; install the Codex CLI, Claude Code or ZCode");
  for (const agent of agents) checks.push(...agent.checks());

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
