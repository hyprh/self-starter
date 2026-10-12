// Settings in ~/.self-starter/config.json, and how binaries are located.

import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs-util.js";
import type { Paths } from "./paths.js";

export interface Config {
  /** Notification channels; see channels.ts. */
  channels?: {
    default?: Array<"desktop" | "email">;
    email?: { to: string; from?: string; host: string; port: number; secure: boolean; user?: string };
  };
  /** Absolute path of the codex CLI. Recorded by `self-starter install`; found on PATH otherwise. */
  codexBin?: string;
  /** Absolute path of deno. Defaults to the binary shipped with the deno npm package. */
  denoBin?: string;
  budget: {
    maxAgentRunsPerDay: number;
    maxConcurrentAgentRuns: number;
  };
  maxConcurrentProbes: number;
  /**
   * When no Codex app has the origin thread open, so a fire queued for it is not
   * picked up within a minute, load the thread here and run the fire in it.
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

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

/** The deno binary from the deno npm package, if it was installed with its postinstall step. */
export function bundledDeno(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageDir = dirname(require.resolve("deno/package.json"));
    const binary = join(packageDir, process.platform === "win32" ? "deno.exe" : "deno");
    return existsSync(binary) && isExecutable(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDeno(config: Config): string | undefined {
  return config.denoBin ?? bundledDeno() ?? which("deno");
}

export function resolveCodex(config: Config): string | undefined {
  return config.codexBin ?? which("codex");
}
