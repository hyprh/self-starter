// What the end-to-end checks share: the CLI, run the way a user runs it, and the
// MCP server, spoken to the way Codex speaks to it.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

const CLI = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

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

  constructor(env: NodeJS.ProcessEnv, threadId: string) {
    this.meta = { threadId, "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: `${threadId}/user-turn`, turn_trigger: "user" }) };
    this.child = spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
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
