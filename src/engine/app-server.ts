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

/**
 * The notifications that match, kept in order from the moment it was created,
 * so none is missed between two awaits. One `next` at a time.
 */
export class Inbox {
  private readonly kept: RpcMessage[] = [];
  private waiting: { resolve: (message: RpcMessage | undefined) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private error: Error | undefined;

  constructor(readonly match: (message: RpcMessage) => boolean) {}

  /** The next matching notification, or undefined when none arrives within `timeoutMs`. */
  next(timeoutMs: number): Promise<RpcMessage | undefined> {
    const kept = this.kept.shift();
    if (kept) return Promise.resolve(kept);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
    });
  }

  deliver(message: RpcMessage): void {
    const waiting = this.take();
    if (waiting) waiting.resolve(message);
    else this.kept.push(message);
  }

  fail(error: Error): void {
    this.error ??= error;
    this.take()?.reject(error);
  }

  private take() {
    const waiting = this.waiting;
    if (waiting) clearTimeout(waiting.timer);
    this.waiting = undefined;
    return waiting;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AppServerSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies = new Map<number, (message: RpcMessage) => void>();
  private readonly inboxes = new Set<Inbox>();
  private nextId = 1;
  private stderr = "";
  private exitError: Error | undefined;

  private constructor(command: string, args: string[], cwd: string | undefined, private readonly requestTimeoutMs: number) {
    this.child = spawn(command, [...args, "app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => this.fail(new Error(`could not start codex app-server: ${error.message}`)));
    this.child.on("close", () => this.fail(new Error(`codex app-server exited: ${shortError(this.stderr)}`)));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }

  /** Starts `codex app-server` and completes the initialize handshake; `experimental` opts into the API's experimental methods. */
  static async open(
    command: string,
    args: string[],
    options: { cwd?: string; experimental?: boolean; requestTimeoutMs?: number } = {},
  ): Promise<AppServerSession> {
    const session = new AppServerSession(command, args, options.cwd, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const capabilities = options.experimental ? { capabilities: { experimentalApi: true } } : {};
      await session.request("initialize", { clientInfo: { name: "self-starter", version: "1" }, ...capabilities });
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
      for (const inbox of this.inboxes) if (inbox.match(message)) inbox.deliver(message);
    }
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const reply of this.replies.values()) reply({ error: { message: error.message } });
    this.replies.clear();
    for (const inbox of this.inboxes) inbox.fail(error);
  }

  /** Sends a request and returns its result; a JSON-RPC error or timeout becomes an exception. */
  request(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<Record<string, any>> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.replies.delete(id);
        const error = new Error(`timed out after ${Math.ceil(timeoutMs / 1000)}s waiting for ${method}`);
        this.fail(error);
        this.close();
        reject(error);
      }, timeoutMs);
      this.replies.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? `${method} failed`));
        else resolve(message.result ?? {});
      });
      this.send({ id, method, params });
    });
  }

  /** Keeps the notifications that match from now on. Create it before the request that causes them. */
  listen(match: (message: RpcMessage) => boolean): Inbox {
    const inbox = new Inbox(match);
    if (this.exitError) inbox.fail(this.exitError);
    this.inboxes.add(inbox);
    return inbox;
  }

  close(): void {
    for (const inbox of this.inboxes) inbox.fail(new Error("the app server session was closed"));
    this.child.kill("SIGTERM");
    setTimeout(() => this.child.kill("SIGKILL"), 3000).unref();
  }
}

/** The first lines of a command's error output, without Codex's sandbox warning. */
export function shortError(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING: proceeding"));
  return lines.slice(0, 3).join(" | ").slice(0, 500) || "no error output";
}
