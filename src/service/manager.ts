// Keeps the daemon running in the background: a launchd agent on macOS, a
// systemd user unit on Linux. Without either, the daemon can still run as a
// detached process, but it does not come back after a restart.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { findCodex, loadConfig, saveConfig, which } from "../engine/config.js";
import type { Paths } from "../engine/paths.js";
import { findClaude } from "../engine/sessions.js";
import { findZCode } from "../engine/zcode.js";
import { CLI_SCRIPT, VERSION } from "../runtime.js";

export const LAUNCHD_LABEL = "dev.self-starter.daemon";
export const SYSTEMD_UNIT = "self-starter.service";

export interface ServiceSpec {
  node: string;
  script: string;
  env: Record<string, string>;
  logFile: string;
}

export interface ServiceManager {
  kind: "launchd" | "systemd" | "none";
  /** Where the service definition lives. */
  file: string | null;
  installed(): boolean;
  install(spec: ServiceSpec): void;
  uninstall(): void;
  start(): boolean;
  stop(): boolean;
  restart(): boolean;
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  const out = spawnSync(cmd, args, { encoding: "utf8", env: commandEnv() });
  return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim() };
}

/**
 * `systemctl --user` finds the user's systemd through XDG_RUNTIME_DIR, which
 * Codex does not pass to the MCP servers it starts; it is /run/user/<uid> on
 * systemd systems.
 */
function commandEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "linux" || process.env.XDG_RUNTIME_DIR) return process.env;
  const runtimeDir = `/run/user/${userInfo().uid}`;
  return existsSync(runtimeDir) ? { ...process.env, XDG_RUNTIME_DIR: runtimeDir } : process.env;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.node)}</string>
      <string>${xml(spec.script)}</string>
      <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(spec.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(spec.logFile)}</string>
  </dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Self-Starter: runs trigger probes and hands events to coding agents

[Service]
ExecStart=${systemdQuote(spec.node)} ${systemdQuote(spec.script)} daemon
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

class Launchd implements ServiceManager {
  readonly kind = "launchd" as const;
  readonly file = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  private readonly domain = `gui/${userInfo().uid}`;

  installed(): boolean {
    return existsSync(this.file);
  }

  install(spec: ServiceSpec): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, launchdPlist(spec));
    run("launchctl", ["bootout", `${this.domain}/${LAUNCHD_LABEL}`]);
    const out = run("launchctl", ["bootstrap", this.domain, this.file]);
    if (!out.ok) throw new Error(`launchctl bootstrap failed: ${out.output}`);
  }

  uninstall(): void {
    run("launchctl", ["bootout", `${this.domain}/${LAUNCHD_LABEL}`]);
    rmSync(this.file, { force: true });
  }

  start(): boolean {
    if (run("launchctl", ["kickstart", `${this.domain}/${LAUNCHD_LABEL}`]).ok) return true;
    return run("launchctl", ["bootstrap", this.domain, this.file]).ok;
  }

  stop(): boolean {
    return run("launchctl", ["bootout", `${this.domain}/${LAUNCHD_LABEL}`]).ok;
  }

  restart(): boolean {
    return run("launchctl", ["kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`]).ok || this.start();
  }
}

class Systemd implements ServiceManager {
  readonly kind = "systemd" as const;
  readonly file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", SYSTEMD_UNIT);

  installed(): boolean {
    return existsSync(this.file);
  }

  install(spec: ServiceSpec): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, systemdUnit(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    const out = run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    if (!out.ok) throw new Error(`systemctl --user enable failed: ${out.output}`);
    run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  }

  uninstall(): void {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(this.file, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }

  start(): boolean {
    return run("systemctl", ["--user", "start", SYSTEMD_UNIT]).ok;
  }

  stop(): boolean {
    return run("systemctl", ["--user", "stop", SYSTEMD_UNIT]).ok;
  }

  restart(): boolean {
    return run("systemctl", ["--user", "restart", SYSTEMD_UNIT]).ok;
  }
}

class NoManager implements ServiceManager {
  readonly kind = "none" as const;
  readonly file = null;
  installed(): boolean {
    return false;
  }
  install(): void {
    throw new Error(
      "no supported service manager (launchd or a systemd user session) was found; keep `self-starter daemon` running some other way, for example from your login items",
    );
  }
  uninstall(): void {}
  start(): boolean {
    return false;
  }
  stop(): boolean {
    return false;
  }
  restart(): boolean {
    return false;
  }
}

export function serviceManager(): ServiceManager {
  if (process.platform === "darwin") return new Launchd();
  if (process.platform === "linux" && which("systemctl") && run("systemctl", ["--user", "show-environment"]).ok) return new Systemd();
  return new NoManager();
}

/** PATH for the daemon: where node and the agents' CLIs live, then the current PATH. */
export function servicePath(agentBins: Array<string | undefined>): string {
  const bins = agentBins.filter((bin): bin is string => bin !== undefined);
  const dirs = [dirname(process.execPath), ...bins.map((bin) => dirname(bin)), ...(process.env.PATH ?? "").split(delimiter)];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

export function serviceSpec(paths: Paths, agentBins: Array<string | undefined>): ServiceSpec {
  const env: Record<string, string> = { PATH: servicePath(agentBins) };
  if (process.env.SELF_STARTER_HOME) env.SELF_STARTER_HOME = paths.home;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  return { node: process.execPath, script: CLI_SCRIPT, env, logFile: join(paths.logs, "service.log") };
}

/** Starts the daemon as a detached process that outlives the caller. */
export function spawnDetachedDaemon(paths: Paths): void {
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const out = openSync(join(paths.logs, "service.log"), "a", 0o600);
  const child = spawn(process.execPath, [CLI_SCRIPT, "daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SELF_STARTER_HOME: paths.home },
  });
  child.unref();
}

/** Asks a running daemon to stop, and waits until it no longer answers. */
export async function stopRunningDaemon(paths: Paths): Promise<void> {
  if (!(await isDaemonRunning(paths.socket))) return;
  await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await isDaemonRunning(paths.socket))) await new Promise((r) => setTimeout(r, 200));
}

/** The version of the daemon listening on the socket, or undefined when none answers. */
export async function daemonVersion(socket: string): Promise<string | undefined> {
  try {
    return (await callDaemon<{ version: string }>(socket, "ping", {}, { via: "cli" }, 3000)).version;
  } catch {
    return undefined;
  }
}

/** Compares versions such as 0.0.1 and 0.1.0, ignoring a pre-release suffix: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Writes <home>/bin/self-starter, which runs this installation's CLI. Users who
 * installed only the Codex plugin have no `self-starter` on their PATH, and use
 * this one for what they do in a terminal (secrets, the email password).
 */
export function writeCommand(paths: Paths): string {
  const file = join(paths.home, "bin", "self-starter");
  const command = ["exec", shellQuote(process.execPath), shellQuote(CLI_SCRIPT), '"$@"'].join(" ");
  const lines = ["#!/bin/sh", "# Runs the Self-Starter installation that the background service runs."];
  if (process.env.SELF_STARTER_HOME) lines.push(`export SELF_STARTER_HOME=${shellQuote(paths.home)}`);
  lines.push(command, "");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, lines.join("\n"), { mode: 0o755 });
  return file;
}

/**
 * Makes the background service run this installation from now on and starts it,
 * stopping whatever daemon still runs. Also records the agents' CLIs for the
 * daemon, as found from here (an agent's MCP server sees the user's PATH), and
 * writes the self-starter command.
 */
export async function installService(paths: Paths, manager = serviceManager()): Promise<void> {
  const config = loadConfig(paths);
  config.codexBin ??= findCodex();
  config.claudeBin ??= findClaude();
  config.zcodeBin ??= findZCode();
  config.service = true;
  saveConfig(paths, config);
  await stopRunningDaemon(paths);
  writeCommand(paths);
  manager.install(serviceSpec(paths, [config.codexBin, config.claudeBin, config.zcodeBin]));
}

/**
 * Makes sure a daemon of this version or a newer one is listening. When none
 * answers, or an older one does, the background service is set up to run this
 * installation: the first time the Codex plugin starts Self-Starter on a
 * machine, and after an upgrade. Without a service manager, or when the user
 * chose to run without the service, the daemon runs as a detached process.
 */
export async function ensureDaemon(paths: Paths): Promise<"running" | "started"> {
  const running = await daemonVersion(paths.socket);
  if (running !== undefined && compareVersions(running, VERSION) >= 0) return "running";
  const manager = serviceManager();
  let serviceError = "";
  if (manager.kind !== "none" && loadConfig(paths).service !== false) {
    try {
      await installService(paths, manager);
      if (await waitForDaemon(paths.socket, 10_000)) return "started";
      serviceError = `the ${manager.kind} service did not start; `;
    } catch (error) {
      serviceError = `${(error as Error).message}; `;
    }
  }
  await stopRunningDaemon(paths);
  writeCommand(paths);
  spawnDetachedDaemon(paths);
  if (await waitForDaemon(paths.socket, 10_000)) return "started";
  throw new Error(`${serviceError}could not start the self-starter daemon; see ${join(paths.logs, "service.log")} or run \`self-starter doctor\``);
}
