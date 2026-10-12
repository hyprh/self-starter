// Facts about this installation: the package folder, its version, and the CLI script.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root; this file is compiled to <root>/dist/src/runtime.js. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const VERSION: string = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

/** The `ctrig` entry point, which also runs the daemon (`ctrig daemon`) and the MCP server (`ctrig mcp`). */
export const CLI_SCRIPT = join(PACKAGE_ROOT, "dist", "src", "cli", "main.js");

/** Source of the Codex plugin (skill and manifest). */
export const PLUGIN_SOURCE = join(PACKAGE_ROOT, "plugin");
