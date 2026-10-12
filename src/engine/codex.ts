// Thin wrappers around the codex CLI: `codex queue` to deliver into a thread,
// `codex app-server` to create a dedicated thread the way the Codex app does,
// and `codex exec resume` to run a turn in one. Arguments are passed as an
// array, never through a shell.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Sandbox } from "../core/definition.js";

export interface ExecResult {
  ok: boolean;
  threadId?: string;
  /** Final agent message; JSON text when an output schema was given. */
  lastMessage?: string;
  error?: string;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(bin: string, args: string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start codex: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function shortError(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING: proceeding"));
  return lines.slice(0, 3).join(" | ").slice(0, 500) || "no error output";
}

/** Reads `codex exec --json` output: the thread id, the final agent message, and any error. */
export function parseExecJsonl(stdout: string): ExecResult {
  const result: ExecResult = { ok: false };
  let completed = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    switch (event.type) {
      case "thread.started":
        result.threadId = event.thread_id;
        break;
      case "item.completed":
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") result.lastMessage = event.item.text;
        break;
      case "turn.completed":
        completed = true;
        break;
      case "turn.failed":
        result.error = event.error?.message ?? "the turn failed";
        break;
      case "error":
        result.error = event.message ?? "codex reported an error";
        break;
    }
  }
  result.ok = completed && result.error === undefined;
  if (!completed && !result.error) result.error = "the turn did not complete";
  return result;
}

export interface StartThreadOptions {
  cwd: string;
  /** Title shown in the Codex app. */
  name: string;
  /** The first message; the thread exists for Codex once a turn ran. */
  prompt: string;
  outputSchema?: unknown;
  timeoutMs: number;
}

export interface CodexRunner {
  queue(threadId: string, message: string): Promise<{ submissionId?: string }>;
  startThread(options: StartThreadOptions): Promise<ExecResult>;
  exec(options: { cwd: string; prompt: string; sandbox: Sandbox; outputSchemaPath?: string; timeoutMs: number }): Promise<ExecResult>;
  resume(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    sandbox: Sandbox;
    outputSchemaPath?: string;
    timeoutMs: number;
  }): Promise<ExecResult>;
}

export class CodexCli implements CodexRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string) {
    // The npm package's `codex` is a node script; run it with this node so that
    // it works even when node is not on the daemon's PATH.
    let real = bin;
    try {
      real = realpathSync(bin);
    } catch {
      // keep the path as given
    }
    if (/\.[cm]?js$/.test(real)) {
      this.command = process.execPath;
      this.prefix = [real];
    } else {
      this.command = bin;
      this.prefix = [];
    }
  }

  private spawn(args: string[], options: { cwd?: string; timeoutMs: number }): Promise<Spawned> {
    return run(this.command, [...this.prefix, ...args], options);
  }

  async queue(threadId: string, message: string): Promise<{ submissionId?: string }> {
    const out = await this.spawn(["queue", "--thread", threadId, "--message", message], { timeoutMs: 60_000 });
    if (out.code !== 0 || out.timedOut) {
      throw new Error(`codex queue failed: ${out.timedOut ? "timed out" : shortError(out.stderr || out.stdout)}`);
    }
    const match = /Queued message (\S+) for thread/.exec(out.stdout);
    return match ? { submissionId: match[1]! } : {};
  }

  /**
   * Creates a thread through `codex app-server`, names it and runs its first
   * turn. Threads made this way are listed by the Codex app like the user's
   * own; threads made by `codex exec` are left out of its default list.
   */
  startThread(options: StartThreadOptions): Promise<ExecResult> {
    const child = spawn(this.command, [...this.prefix, "app-server"], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    return new Promise<ExecResult>((resolve) => {
      type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: Record<string, any>; error?: { message?: string } };
      const waiting = new Map<number | string, (message: Message) => void>();
      let nextId = 1;
      let threadId: string | undefined;
      let stderr = "";
      let settled = false;

      const finish = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        resolve(threadId && !result.threadId ? { ...result, threadId } : result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${Math.round(options.timeoutMs / 60_000)} min` }), options.timeoutMs);
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      const request = (method: string, params: Record<string, unknown>) =>
        new Promise<Message>((answer) => {
          const id = nextId++;
          waiting.set(id, answer);
          send({ id, method, params });
        });

      child.on("error", (error) => finish({ ok: false, error: `could not start codex app-server: ${error.message}` }));
      child.on("close", () => finish({ ok: false, error: `codex app-server exited: ${shortError(stderr)}` }));
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          return;
        }
        if (message.id !== undefined && message.method === undefined) {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        } else if (message.id !== undefined) {
          // Approvals and other questions: nobody is there to answer them.
          send({ id: message.id, error: { code: -32601, message: "self-starter does not answer this request" } });
        } else if (message.method === "turn/completed" && message.params?.threadId === threadId) {
          const turn = message.params?.turn ?? {};
          const items: Array<{ type?: string; text?: string }> = Array.isArray(turn.items) ? turn.items : [];
          const last = [...items].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string");
          const result: ExecResult = { ok: turn.status === "completed" };
          if (last?.text !== undefined) result.lastMessage = last.text;
          if (!result.ok) result.error = turn.error?.message ?? `the turn ended as ${String(turn.status)}`;
          finish(result);
        }
      });

      void (async () => {
        const init = await request("initialize", { clientInfo: { name: "self-starter", version: "1" } });
        if (init.error) return finish({ ok: false, error: `codex app-server: ${init.error.message ?? "initialize failed"}` });
        send({ method: "initialized" });
        const started = await request("thread/start", { cwd: options.cwd });
        threadId = started.result?.thread?.id;
        if (!threadId) return finish({ ok: false, error: `codex app-server: ${started.error?.message ?? "thread/start returned no thread"}` });
        await request("thread/name/set", { threadId, name: options.name });
        const params: Record<string, unknown> = { threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }] };
        if (options.outputSchema !== undefined) params.outputSchema = options.outputSchema;
        const turn = await request("turn/start", params);
        if (turn.error) finish({ ok: false, error: `codex app-server: ${turn.error.message ?? "turn/start failed"}` });
      })();
    });
  }

  async exec(options: { cwd: string; prompt: string; sandbox: Sandbox; outputSchemaPath?: string; timeoutMs: number }): Promise<ExecResult> {
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", options.sandbox, "-C", options.cwd];
    if (options.outputSchemaPath) args.push("--output-schema", options.outputSchemaPath);
    args.push(options.prompt);
    return this.execLike(args, options.cwd, options.timeoutMs);
  }

  async resume(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    sandbox: Sandbox;
    outputSchemaPath?: string;
    timeoutMs: number;
  }): Promise<ExecResult> {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${options.sandbox}"`];
    if (options.outputSchemaPath) args.push("--output-schema", options.outputSchemaPath);
    args.push(options.threadId, options.prompt);
    return this.execLike(args, options.cwd, options.timeoutMs);
  }

  private async execLike(args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
    const out = await this.spawn(args, { cwd, timeoutMs });
    const parsed = parseExecJsonl(out.stdout);
    if (out.timedOut) return { ...parsed, ok: false, error: `timed out after ${Math.round(timeoutMs / 60_000)} min` };
    if (out.code !== 0 && parsed.ok) return { ...parsed, ok: false, error: shortError(out.stderr) };
    if (!parsed.ok && parsed.error === "the turn did not complete" && out.stderr) {
      return { ...parsed, error: shortError(out.stderr) };
    }
    return parsed;
  }
}
