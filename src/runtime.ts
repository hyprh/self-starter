// Facts about this installation: the package folder, its version, and the CLI script.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root; this file is compiled to <root>/dist/src/runtime.js. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const VERSION: string = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

/** The `self-starter` entry point, which also runs the daemon (`self-starter daemon`) and the MCP server (`self-starter mcp`). */
export const CLI_SCRIPT = join(PACKAGE_ROOT, "dist", "src", "cli", "main.js");

/** Source of the Codex plugin (skill and manifest). */
export const PLUGIN_SOURCE = join(PACKAGE_ROOT, "codex-plugin");

/** Source of the Claude Code plugin (skills, hooks and manifest). */
export const CC_PLUGIN_SOURCE = join(PACKAGE_ROOT, "cc-plugin");

/** Source of the ZCode plugin (skill and manifest). */
export const ZCODE_PLUGIN_SOURCE = join(PACKAGE_ROOT, "zcode-plugin");
