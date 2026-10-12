// Keeps the daemon running in the background: a launchd agent on macOS, a
// systemd user unit on Linux. Without either, the daemon can still run as a
// detached process, but it does not come back after a restart.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { which } from "../engine/config.js";
import type { Paths } from "../engine/paths.js";
import { CLI_SCRIPT } from "../runtime.js";
import { isDaemonRunning, waitForDaemon } from "../client/client.js";

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
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim() };
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
Description=Self-Starter: runs trigger probes and hands fires to Codex

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

/** PATH for the daemon: where node and codex live, then the current PATH. */
export function servicePath(codexBin: string | undefined): string {
  const dirs = [dirname(process.execPath), ...(codexBin ? [dirname(codexBin)] : []), ...(process.env.PATH ?? "").split(delimiter)];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

export function serviceSpec(paths: Paths, codexBin: string | undefined): ServiceSpec {
  const env: Record<string, string> = { PATH: servicePath(codexBin) };
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

/** Makes sure a daemon is listening: through the service manager when installed, otherwise as a detached process. */
export async function ensureDaemon(paths: Paths): Promise<"running" | "started"> {
  if (await isDaemonRunning(paths.socket)) return "running";
  const manager = serviceManager();
  if (manager.installed() && manager.start() && (await waitForDaemon(paths.socket, 8000))) return "started";
  spawnDetachedDaemon(paths);
  if (await waitForDaemon(paths.socket, 10_000)) return "started";
  throw new Error(`could not start the self-starter daemon; see ${join(paths.logs, "service.log")} or run \`self-starter doctor\``);
}
