// Settings in ~/.self-starter/config.json, and how binaries are located.

import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Channel } from "../core/definition.js";
import { readJson, writeJsonAtomic } from "./fs-util.js";
import type { Paths } from "./paths.js";

export interface EmailSettings {
  to: string;
  from?: string;
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is used, and required whenever a password is sent. */
  secure: boolean;
  user?: string;
}

export interface Config {
  /** Notification channels; see channels.ts. */
  channels?: { default?: Channel[]; email?: EmailSettings };
  /** Absolute path of the codex CLI. Recorded by `self-starter install`; found on PATH otherwise. */
  codexBin?: string;
  /** Absolute path of the claude CLI, for fires of triggers made in Claude Code; found on PATH otherwise. */
  claudeBin?: string;
  /** Absolute path of ZCode for dedicated result sessions. */
  zcodeBin?: string;
  /** Absolute path of OpenCode for dedicated result sessions. */
  opencodeBin?: string;
  /** Global OpenCode config directory where our native plugin loader is installed. */
  opencodeConfigDir?: string;
  /**
   * Whether the daemon runs as a launchd or systemd service. Unset until the user
   * decides: the Codex plugin then sets one up on first use; false after
   * `self-starter install --no-service` or `self-starter service uninstall`.
   */
  service?: boolean;
  /** Absolute path of deno. Defaults to the binary shipped with the deno npm package. */
  denoBin?: string;
  budget: {
    maxAgentRunsPerDay: number;
    maxConcurrentAgentRuns: number;
  };
  maxConcurrentProbes: number;
  /**
   * When no Codex app has the origin thread open, so a fire queued for it is not
   * picked up, load the thread here and run the fire in it. (The trigger's own
   * thread is always woken.)
   */
  wakeClosedThreads: boolean;
  /** A fire sent to the origin thread with no receipt after this long triggers a reminder notification. */
  originReminderMinutes: number;
  /** After this long without a receipt, a fire is closed as "no reply". */
  receiptTimeoutMinutes: number;
  agentRunTimeoutMinutes: number;
}

export const DEFAULT_CONFIG: Config = {
  budget: { maxAgentRunsPerDay: 20, maxConcurrentAgentRuns: 1 },
  maxConcurrentProbes: 2,
  wakeClosedThreads: true,
  originReminderMinutes: 5,
  receiptTimeoutMinutes: 30,
  agentRunTimeoutMinutes: 20,
};

export function loadConfig(paths: Paths): Config {
  const stored = readJson<Partial<Config>>(paths.config) ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    budget: { ...DEFAULT_CONFIG.budget, ...(stored.budget ?? {}) },
  };
}

export function saveConfig(paths: Paths, config: Config): void {
  writeJsonAtomic(paths.config, config);
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * How to run an agent's CLI. Installed with npm, codex and claude are node scripts; they run with
 * this node, so that they work even when node is not on the daemon's PATH.
 */
export function cliCommand(bin: string): { command: string; prefix: string[] } {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    // keep the path as given
  }
  return /\.[cm]?js$/.test(real) ? { command: process.execPath, prefix: [real] } : { command: bin, prefix: [] };
}

/** Finds an executable on PATH, like `command -v`. */
export function which(name: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** The bundled Deno, including when npm blocked the package's postinstall script. */
export function bundledDeno(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageDir = dirname(require.resolve("deno/package.json"));
    const binary = join(packageDir, process.platform === "win32" ? "deno.exe" : "deno");
    if (isExecutable(binary)) return binary;
    // The package's own installer selects the matching optional platform package
    // (including macOS and Linux architectures), without downloading anything.
    // It also returns that package's executable when the deno folder is read-only.
    const installer = require("deno/install_api.cjs") as { runInstall(): string };
    const installed = installer.runInstall();
    return typeof installed === "string" && isExecutable(installed) ? installed : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDeno(config: Config): string | undefined {
  return config.denoBin ?? bundledDeno() ?? which("deno");
}

/** A codex binary inside a macOS app bundle (the Codex app, or the ChatGPT app that ships Codex). */
function findInAppBundles(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const home = homedir();
  const systemBundles = home === userInfo().homedir ? ["/Applications/Codex.app", "/Applications/ChatGPT.app"] : [];
  const bundles = [...systemBundles, join(home, "Applications/Codex.app"), join(home, "Applications/ChatGPT.app")];
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

/** The codex CLI: $CODEX_BIN, then PATH, then the macOS app bundles. */
export function findCodex(): string | undefined {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  return which("codex") ?? findInAppBundles();
}

export function resolveCodex(config: Config): string | undefined {
  return config.codexBin ?? findCodex();
}
