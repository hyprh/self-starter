// What the end-to-end checks share: the CLI, run the way a user runs it, and the
// MCP server, spoken to the way Codex speaks to it.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_NAME, PLUGIN_ID } from "../../src/cli/install.js";
import { findCodex } from "../../src/engine/config.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";

type Json = Record<string, any>;

const CLI = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

/** How an MCP server is started: by default this checkout's `self-starter mcp`. */
interface ServerCommand {
  command: string;
  args: string[];
  cwd?: string;
  env_vars?: string[];
}

/** What Codex passes to an MCP server: a few variables of its own environment, certificate settings, and those the server's config names. */
const CODEX_MCP_ENV = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
const CODEX_CA_ENV = ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO", "CARGO_HTTP_CAINFO", "PIP_CERT", "BUNDLE_SSL_CA_CERT", "npm_config_cafile", "NPM_CONFIG_CAFILE"];

/** Runs the CLI as a user would in a terminal, with `input` typed at its prompt. */
export function cli(env: NodeJS.ProcessEnv, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`self-starter ${args.join(" ")} exited with ${code}: ${output.trim()}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Talks to `self-starter mcp` over stdio, the way Codex does, from a user's turn in a thread. */
class Mcp {
  private readonly child;
  private readonly waiting = new Map<number, { resolve: (message: Json) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readonly meta;

  constructor(env: NodeJS.ProcessEnv, threadId: string, server: ServerCommand = { command: process.execPath, args: [CLI, "mcp"] }) {
    this.meta = { threadId, "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: `${threadId}/user-turn`, turn_trigger: "user" }) };
    const serverEnv = server.env_vars ? Object.fromEntries([...CODEX_MCP_ENV, ...CODEX_CA_ENV, ...server.env_vars].filter((name) => env[name] !== undefined).map((name) => [name, env[name]])) : env;
    this.child = spawn(server.command, server.args, { env: serverEnv, cwd: server.cwd, stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Json;
      if (typeof message.id !== "number") return;
      this.waiting.get(message.id)?.resolve(message);
      this.waiting.delete(message.id);
    });
    this.child.on("close", (code) => {
      for (const { reject } of this.waiting.values()) reject(new Error(`self-starter mcp exited with ${code}`));
      this.waiting.clear();
    });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async tool(name: string, args: Json): Promise<string> {
    const { result, error } = await this.request("tools/call", { name, arguments: args, _meta: this.meta });
    const text: string = result?.content?.[0]?.text ?? error?.message ?? "no answer";
    if (error || result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  }

  close(): void {
    this.child.stdin.end();
  }
}

/** Drafts a trigger and turns it on, as Codex does in a user's thread; returns the first line of each answer. */
export async function createTrigger(env: NodeJS.ProcessEnv, definition: Json, code: string, threadId = "e2e-thread"): Promise<string> {
  const mcp = new Mcp(env, threadId);
  try {
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    const draft = await mcp.tool("trigger_draft", { definition, code });
    const draftId = /Draft (\S+) saved/.exec(draft)?.[1];
    if (!draftId) throw new Error(`trigger_draft returned no draft id: ${draft}`);
    const activated = await mcp.tool("trigger_activate", { draft_id: draftId });
    return [draft, activated].map((text) => text.split("\n")[0]).join("\n");
  } finally {
    mcp.close();
  }
}

/** Packs this checkout as npm would publish it: the runtime that the plugin's launcher installs in tests (SELF_STARTER_RUNTIME). */
export function packRuntime(dir: string): string {
  const out = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: PACKAGE_ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`npm pack failed: ${out.stderr}`);
  return join(dir, out.stdout.trim().split("\n").at(-1)!);
}

/** Runs the codex CLI; what it prints on stdout, and its warnings on stderr. */
function codex(env: NodeJS.ProcessEnv, args: string[]): { stdout: string; stderr: string } {
  const out = spawnSync(findCodex() ?? "codex", args, { env, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`codex ${args.join(" ")} failed: ${out.stdout}${out.stderr}`);
  return { stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

/** The two commands of the README's install, with this checkout as the marketplace instead of the GitHub repository. */
export function installFromMarketplace(env: NodeJS.ProcessEnv): string {
  return [["plugin", "marketplace", "add", PACKAGE_ROOT], ["plugin", "add", PLUGIN_ID]]
    .map((args) => `$ codex ${args.join(" ")}\n${codex(env, args).stdout}`)
    .join("\n");
}

/** How Codex starts the installed plugin's MCP server, as `codex mcp list` reports it. */
export function pluginServer(env: NodeJS.ProcessEnv): ServerCommand {
  const servers = JSON.parse(codex(env, ["mcp", "list", "--json"]).stdout) as Array<{ name: string; transport: ServerCommand }>;
  const server = servers.find((candidate) => candidate.name === MCP_SERVER_NAME);
  if (!server) throw new Error(`Codex lists no ${MCP_SERVER_NAME} MCP server`);
  return server.transport;
}

/** Starts the installed plugin's MCP server the way Codex does, and calls one tool. */
export async function callPluginTool(env: NodeJS.ProcessEnv, name: string, args: Json = {}): Promise<string> {
  const mcp = new Mcp(env, "e2e-thread", pluginServer(env));
  try {
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    return await mcp.tool(name, args);
  } finally {
    mcp.close();
  }
}

export interface WaitOptions {
  timeoutMs: number;
  everyMs?: number;
  /** What to add to the error on timeout, such as the state of things. */
  explain?: () => Promise<string>;
}

/** Calls `check` until it returns something. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, options: WaitOptions): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${options.explain ? `\n${await options.explain()}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, options.everyMs ?? 1000));
  }
}

/** Prints a command and what it printed, the way it looks in a terminal. */
export function show(command: string, output: string): void {
  console.log(`\n$ ${command}\n${output}`);
}
