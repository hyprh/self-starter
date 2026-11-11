// Persists the Self-Starter runtime into <home>/runtime/<version> when the CLI is run
// from an ephemeral package-runner cache (`npx self-starter install`, `pnpm dlx`, `bunx`),
// so that background services, `.mcp.json` files, OpenCode loaders and `<home>/bin/self-starter`
// keep working after the package runner evicts its temporary cache.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensurePrivateDir } from "../engine/fs-util.js";
import type { Paths } from "../engine/paths.js";
import { PACKAGE_ROOT, VERSION } from "../runtime.js";

const EPHEMERAL_SEGMENTS = ["/_npx/", "/pnpm/dlx/", "/bunx-", "/yarn--"];
const RUNTIME_DEPS = ["deno", "jsonc-parser", "nodemailer", "yaml", "@opencode-ai/plugin"];

/** True when `packageRoot` sits inside an ephemeral `npx` / `dlx` / `bunx` cache directory. */
export function isEphemeralPackageRoot(packageRoot: string): boolean {
  const normalized = `${packageRoot.replace(/\\/g, "/")}/`;
  if (EPHEMERAL_SEGMENTS.some((segment) => normalized.includes(segment))) return true;
  return /\/dlx-\d+\//.test(normalized);
}

export type EphemeralAction = "none" | "if-present" | "materialize";

/**
 * Decides how an ephemeral CLI invocation should treat `<home>/runtime/<version>`:
 * - `none`: run directly without touching `<home>/runtime` (`help`, `version`, `uninstall`, `service stop|uninstall`)
 * - `if-present`: delegate if `<home>/runtime/<version>` already exists, without creating it (`doctor`, `logs`, `service status`)
 * - `materialize`: copy or install into `<home>/runtime/<version>` first so written paths stay permanent
 */
export function ephemeralAction(command: string | undefined, subcommand: string | undefined): EphemeralAction {
  switch (command) {
    case undefined:
    case "help":
    case "version":
    case "uninstall":
      return "none";
    case "doctor":
    case "logs":
      return "if-present";
    case "service":
      if (subcommand === "uninstall" || subcommand === "stop") return "none";
      if (subcommand === "status" || subcommand === undefined) return "if-present";
      return "materialize";
    default:
      return "materialize";
  }
}

export function runtimeCliPath(paths: Paths, version = VERSION): string {
  return join(paths.home, "runtime", version, "node_modules", "self-starter", "dist", "src", "cli", "main.js");
}

function canCopyHoistedNodeModules(packageRoot: string): boolean {
  if (basename(packageRoot) !== "self-starter") return false;
  const nodeModules = dirname(packageRoot);
  if (basename(nodeModules) !== "node_modules") return false;
  if (existsSync(join(nodeModules, ".pnpm"))) return false;
  try {
    if (lstatSync(packageRoot).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return RUNTIME_DEPS.every((dep) => existsSync(join(nodeModules, ...dep.split("/"))));
}

export interface MaterializeOptions {
  packageRoot?: string;
  version?: string;
}

/** Ensures `<home>/runtime/<version>` holds a complete Self-Starter installation and returns its CLI entry path. */
export function materializeRuntime(paths: Paths, options: MaterializeOptions = {}): string {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const version = options.version ?? VERSION;
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
    throw new Error(`invalid runtime version: ${version}`);
  }
  const spec = "self-starter@" + version;
  const runtimeDir = join(paths.home, "runtime", version);
  const cli = runtimeCliPath(paths, version);
  if (existsSync(cli)) return cli;

  const parent = dirname(runtimeDir);
  ensurePrivateDir(parent);
  for (const name of readdirSync(parent)) {
    const entry = join(parent, name);
    if (name.endsWith(".partial") && Date.now() - statSync(entry).mtimeMs > 15 * 60_000) {
      rmSync(entry, { recursive: true, force: true });
    }
  }

  const staging = `${runtimeDir}.${process.pid}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  if (canCopyHoistedNodeModules(packageRoot)) {
    cpSync(dirname(packageRoot), join(staging, "node_modules"), { recursive: true, verbatimSymlinks: true });
  } else {
    const npm = spawnSync("npm", ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", spec], {
      stdio: ["ignore", 2, 2],
    });
    if (npm.status !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`could not persist ${spec} into ${runtimeDir}: ${npm.error ? npm.error.message : `npm exited with code ${npm.status}`}`);
    }
  }

  try {
    renameSync(staging, runtimeDir);
  } catch {
    rmSync(staging, { recursive: true, force: true }); // another process finished first
  }
  if (!existsSync(cli)) throw new Error(`persisted runtime in ${runtimeDir} is missing ${cli}`);
  return cli;
}
