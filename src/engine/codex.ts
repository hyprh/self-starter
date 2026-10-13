// Thin wrappers around the codex CLI: `codex queue` to deliver into a thread,
// `codex app-server` to create, inspect and wake threads the way the Codex app
// does, and `codex exec resume` to run a turn in a dedicated thread. Arguments
// are passed as an array, never through a shell.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Sandbox } from "../core/definition.js";
import { AppServerSession, type RpcMessage } from "./app-server.js";

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

type TurnLike = { status?: string; items?: unknown; error?: { message?: string } } | undefined;

/** The outcome of an app-server turn: whether it completed, and its last agent message. */
function turnResult(turn: TurnLike): ExecResult {
  const items: Array<{ type?: string; text?: string }> = Array.isArray(turn?.items) ? turn.items : [];
  const last = [...items].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string");
  const result: ExecResult = { ok: turn?.status === "completed" };
  if (last?.text !== undefined) result.lastMessage = last.text;
  if (!result.ok) result.error = turn?.error?.message ?? `the turn ended as ${String(turn?.status)}`;
  return result;
}

/** Whether a turn, as listed with `itemsView: "full"`, was started by a message containing the marker, such as a fire id. */
function startedBy(turn: TurnLike, marker: string): boolean {
  const items: Array<{ type?: string }> = Array.isArray(turn?.items) ? turn.items : [];
  return items.some((item) => item.type === "userMessage" && JSON.stringify(item).includes(marker));
}

const turnEvent = (method: "turn/started" | "turn/completed", threadId: string) => (message: RpcMessage) =>
  message.method === method && message.params?.threadId === threadId;

const timedOut = (ms: number, what: string) => new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);

/** A queued message starts as soon as the previous turn in its thread ends; this long without one means none is left. */
const NEXT_TURN_MS = 3000;

export interface StartThreadOptions {
  cwd: string;
  /** Title shown in the Codex app. */
  name: string;
  /** The first message; the thread exists for Codex once a turn ran. */
  prompt: string;
  outputSchema?: unknown;
  timeoutMs: number;
}

/** A thread as seen from outside, without loading it. */
export interface ThreadView {
  /** Whether one of its recent turns was started by a message containing the marker, such as a fire id. */
  mentions: boolean;
  /** Whether its latest turn is still running somewhere. */
  busy: boolean;
}

export interface WakeOptions {
  threadId: string;
  /** Text in the queued message, such as a fire id: the answer of the turn it started is returned. */
  marker: string;
  /** For these turns only; the thread keeps its own folder and approval policy. */
  sandbox: Sandbox;
  /** For each turn. */
  timeoutMs: number;
  /** How long to wait for the first queued message to start running (one minute by default). */
  startTimeoutMs?: number;
}

export interface CodexRunner {
  queue(threadId: string, message: string): Promise<{ submissionId?: string }>;
  startThread(options: StartThreadOptions): Promise<ExecResult>;
  inspectThread(threadId: string, marker: string): Promise<ThreadView>;
  wakeThread(options: WakeOptions): Promise<ExecResult>;
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

  private appServer(cwd?: string): Promise<AppServerSession> {
    return AppServerSession.open(this.command, this.prefix, cwd);
  }

  /**
   * Creates a thread through `codex app-server`, names it and runs its first
   * turn. Threads made this way are listed by the Codex app like the user's
   * own; threads made by `codex exec` are left out of its default list.
   */
  async startThread(options: StartThreadOptions): Promise<ExecResult> {
    let session: AppServerSession | undefined;
    let threadId: string | undefined;
    try {
      session = await this.appServer(options.cwd);
      threadId = (await session.request("thread/start", { cwd: options.cwd })).thread?.id as string | undefined;
      if (!threadId) throw new Error("thread/start returned no thread");
      await session.request("thread/name/set", { threadId, name: options.name });
      const completed = session.listen(turnEvent("turn/completed", threadId));
      const params: Record<string, unknown> = { threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }] };
      if (options.outputSchema !== undefined) params.outputSchema = options.outputSchema;
      await session.request("turn/start", params);
      const turn = await completed.next(options.timeoutMs);
      if (!turn) throw timedOut(options.timeoutMs, "the first turn");
      return { ...turnResult(turn.params?.turn), threadId };
    } catch (error) {
      return { ok: false, ...(threadId ? { threadId } : {}), error: `codex app-server: ${(error as Error).message}` };
    } finally {
      session?.close();
    }
  }

  /** Reads a thread's recent turns without loading it, so a Codex app that has it open is not disturbed. */
  async inspectThread(threadId: string, marker: string): Promise<ThreadView> {
    const session = await this.appServer();
    try {
      const page = await session.request("thread/turns/list", { threadId, limit: 5, itemsView: "full" });
      const turns: TurnLike[] = Array.isArray(page.data) ? page.data : [];
      return { mentions: turns.some((turn) => startedBy(turn, marker)), busy: turns[0]?.status === "inProgress" };
    } finally {
      session.close();
    }
  }

  /**
   * Loads a thread that no Codex process has open. The messages queued for it
   * are then picked up here and run as turns in that same thread, one after
   * another, as they would in the Codex app. This returns when the last one
   * has ended (closing earlier would cut the next one off), with the answer of
   * the turn that the marker's message started. The turns run in the thread's
   * own folder, under its own approval policy (an override of either would
   * stick to the thread), and in the given sandbox. Requests for approval are
   * declined, since nobody is there to answer them.
   */
  async wakeThread(options: WakeOptions): Promise<ExecResult> {
    const { threadId } = options;
    const session = await this.appServer();
    try {
      const started = session.listen(turnEvent("turn/started", threadId));
      const completed = session.listen(turnEvent("turn/completed", threadId));
      await session.request("thread/resume", { threadId, sandbox: options.sandbox, excludeTurns: true });
      const startTimeoutMs = options.startTimeoutMs ?? 60_000;
      let ran = 0;
      while (await started.next(ran === 0 ? startTimeoutMs : NEXT_TURN_MS)) {
        if (!(await completed.next(options.timeoutMs))) throw timedOut(options.timeoutMs, "the turn to finish");
        ran += 1;
      }
      if (ran === 0) throw timedOut(startTimeoutMs, "the queued message to start");
      const page = await session.request("thread/turns/list", { threadId, limit: ran, itemsView: "full" });
      const turns: TurnLike[] = Array.isArray(page.data) ? page.data : [];
      const turn = turns.find((candidate) => startedBy(candidate, options.marker));
      if (!turn) return { ok: false, threadId, error: "the woken thread did not run the queued message" };
      return { ...turnResult(turn), threadId };
    } catch (error) {
      return { ok: false, threadId, error: (error as Error).message };
    } finally {
      session.close();
    }
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
