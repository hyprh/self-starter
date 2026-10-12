// A short-lived `codex app-server` session: JSON-RPC over stdio, the protocol the
// Codex app itself speaks. Requests the server sends to us (approvals,
// questions) are declined, since nobody is there to answer them.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
}

interface Waiter {
  match: (message: RpcMessage) => boolean;
  resolve: (message: RpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies = new Map<number, (message: RpcMessage) => void>();
  private readonly waiters = new Set<Waiter>();
  private nextId = 1;
  private stderr = "";
  private exitError: Error | undefined;

  private constructor(command: string, args: string[], cwd: string | undefined) {
    this.child = spawn(command, [...args, "app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => this.fail(new Error(`could not start codex app-server: ${error.message}`)));
    this.child.on("close", () => this.fail(new Error(`codex app-server exited: ${firstLines(this.stderr)}`)));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }

  /** Starts `codex app-server` and completes the initialize handshake. */
  static async open(command: string, args: string[], cwd?: string): Promise<AppServerSession> {
    const session = new AppServerSession(command, args, cwd);
    try {
      await session.request("initialize", { clientInfo: { name: "self-starter", version: "1" } });
      session.send({ method: "initialized" });
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      this.replies.get(Number(message.id))?.(message);
      this.replies.delete(Number(message.id));
    } else if (message.id !== undefined) {
      this.send({ id: message.id, error: { code: -32601, message: "self-starter does not answer this request" } });
    } else {
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(message)) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const reply of this.replies.values()) reply({ error: { message: error.message } });
    this.replies.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  /** Sends a request and returns its result; a JSON-RPC error becomes an exception. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.replies.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? `${method} failed`)) : resolve(message.result ?? {})));
      this.send({ id, method, params });
    });
  }

  /** Resolves with the first notification that matches. Register it before the request that causes it. */
  next(match: (message: RpcMessage) => boolean, timeoutMs: number, what: string): Promise<RpcMessage> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    this.child.kill("SIGTERM");
    setTimeout(() => this.child.kill("SIGKILL"), 3000).unref();
  }
}

function firstLines(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING: proceeding"));
  return lines.slice(0, 3).join(" | ").slice(0, 500) || "no error output";
}
