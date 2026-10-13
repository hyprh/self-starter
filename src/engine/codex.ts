// Thin wrappers around the codex CLI: `codex queue` to deliver a message into a
// thread, and `codex app-server` to create, inspect and wake threads the way the
// Codex app does. Arguments are passed as an array, never through a shell.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Sandbox } from "../core/definition.js";
import { MESSAGE_PREFIX } from "../core/envelope.js";
import { AppServerSession, shortError, type RpcMessage } from "./app-server.js";

export interface TurnResult {
  ok: boolean;
  threadId?: string;
  /** The turn's last agent message. */
  lastMessage?: string;
  error?: string;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
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

type TurnLike = { status?: string; completedAt?: number | null; items?: unknown; error?: { message?: string } } | undefined;

/** The outcome of an app-server turn: whether it completed, and its last agent message. */
function turnResult(turn: TurnLike): TurnResult {
  const items: Array<{ type?: string; text?: string }> = Array.isArray(turn?.items) ? turn.items : [];
  const last = [...items].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string");
  const result: TurnResult = { ok: turn?.status === "completed" };
  if (last?.text !== undefined) result.lastMessage = last.text;
  if (!result.ok) result.error = turn?.error?.message ?? `the turn ended as ${String(turn?.status)}`;
  return result;
}

/** Whether a turn, as listed with `itemsView: "full"`, was started by a message containing the marker, such as a fire id. */
function startedBy(turn: TurnLike, marker: string): boolean {
  const items: Array<{ type?: string }> = Array.isArray(turn?.items) ? turn.items : [];
  return items.some((item) => item.type === "userMessage" && JSON.stringify(item).includes(marker));
}

/**
 * Whether a listed turn is still running. A turn running in another process is
 * listed as interrupted, but without an end time, unlike one that was stopped.
 */
function stillRunning(turn: TurnLike): boolean {
  return turn?.status === "inProgress" || (turn?.status === "interrupted" && turn.completedAt === null);
}

/**
 * Whether a listed turn was stopped (it has an end time); Codex then holds the
 * thread's queued messages until the user sends one. Pressing Stop, closing the
 * app in the middle of a turn and a crash all look the same.
 */
function stopped(turn: TurnLike): boolean {
  return turn?.status === "interrupted" && typeof turn.completedAt === "number";
}

/** Whether a message other than Self-Starter's waits in the thread's queue; when the queue cannot be read, assume one does. */
async function holdsOtherMessages(session: AppServerSession, threadId: string): Promise<boolean> {
  try {
    const page = await session.request("thread/queue/list", { threadId });
    const queued: Array<{ input?: Array<{ text?: string }> }> = Array.isArray(page.data) ? page.data : [];
    return queued.some((submission) => !submission.input?.some((part) => part.text?.startsWith(MESSAGE_PREFIX)));
  } catch {
    return true;
  }
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
  timeoutMs: number;
}

/** A thread as seen from outside, without loading it. */
export interface ThreadView {
  /** Whether one of its recent turns was started by a message containing the marker, such as a fire id. */
  mentions: boolean;
  /** Whether its latest turn is still running somewhere. */
  busy: boolean;
  /** Whether its latest turn was stopped, so Codex holds the messages queued for it until the user sends one. */
  paused: boolean;
  /** In a paused thread, whether messages other than Self-Starter's are held there, such as the user's own. */
  holdsOthers: boolean;
}

export interface WakeOptions {
  threadId: string;
  /** Text in the queued message, such as a fire id: the answer of the turn it started is returned. */
  marker: string;
  /** For these turns only; the thread keeps its own approval policy. */
  sandbox: Sandbox;
  /** Moves the thread to this folder for good, so only for a thread of the trigger's own; others keep their folder. */
  cwd?: string;
  /** In a paused thread, start this queued message (its id from `codex queue`) instead of waiting for Codex to. */
  startQueued?: string;
  /** Called once the thread is open here, before its queued messages run. */
  onOpen?: () => void;
  /** For each turn. */
  timeoutMs: number;
  /** How long to wait for the first queued message to start running (one minute by default). */
  startTimeoutMs?: number;
}

export interface CodexRunner {
  queue(threadId: string, message: string): Promise<{ submissionId?: string }>;
  startThread(options: StartThreadOptions): Promise<TurnResult>;
  inspectThread(threadId: string, marker: string): Promise<ThreadView>;
  wakeThread(options: WakeOptions): Promise<TurnResult>;
}

/**
 * How to run a codex binary. The npm package's `codex` is a node script; it runs
 * with this node, so that it works even when node is not on the daemon's PATH.
 */
export function codexCommand(bin: string): { command: string; prefix: string[] } {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    // keep the path as given
  }
  return /\.[cm]?js$/.test(real) ? { command: process.execPath, prefix: [real] } : { command: bin, prefix: [] };
}

export class CodexCli implements CodexRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string) {
    ({ command: this.command, prefix: this.prefix } = codexCommand(bin));
  }

  async queue(threadId: string, message: string): Promise<{ submissionId?: string }> {
    const out = await run(this.command, [...this.prefix, "queue", "--thread", threadId, "--message", message], 60_000);
    if (out.code !== 0 || out.timedOut) {
      throw new Error(`codex queue failed: ${out.timedOut ? "timed out" : shortError(out.stderr || out.stdout)}`);
    }
    const match = /Queued message (\S+) for thread/.exec(out.stdout);
    return match ? { submissionId: match[1]! } : {};
  }

  private appServer(options: { cwd?: string; experimental?: boolean } = {}): Promise<AppServerSession> {
    return AppServerSession.open(this.command, this.prefix, options);
  }

  /**
   * Creates a thread through `codex app-server`, names it and runs its first
   * turn. Threads made this way are listed by the Codex app like the user's
   * own; threads made by `codex exec` are left out of its default list.
   */
  async startThread(options: StartThreadOptions): Promise<TurnResult> {
    let session: AppServerSession | undefined;
    let threadId: string | undefined;
    try {
      session = await this.appServer({ cwd: options.cwd });
      threadId = (await session.request("thread/start", { cwd: options.cwd })).thread?.id as string | undefined;
      if (!threadId) throw new Error("thread/start returned no thread");
      await session.request("thread/name/set", { threadId, name: options.name });
      const completed = session.listen(turnEvent("turn/completed", threadId));
      await session.request("turn/start", { threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }] });
      const turn = await completed.next(options.timeoutMs);
      if (!turn) throw timedOut(options.timeoutMs, "the first turn");
      return { ...turnResult(turn.params?.turn), threadId };
    } catch (error) {
      return { ok: false, ...(threadId ? { threadId } : {}), error: `codex app-server: ${(error as Error).message}` };
    } finally {
      session?.close();
    }
  }

  /** Reads a thread's recent turns and held messages without loading it, so a Codex app that has it open is not disturbed. */
  async inspectThread(threadId: string, marker: string): Promise<ThreadView> {
    const session = await this.appServer({ experimental: true });
    try {
      const page = await session.request("thread/turns/list", { threadId, limit: 5, itemsView: "full" });
      const turns: TurnLike[] = Array.isArray(page.data) ? page.data : [];
      const paused = stopped(turns[0]);
      return {
        mentions: turns.some((turn) => startedBy(turn, marker)),
        busy: stillRunning(turns[0]),
        paused,
        holdsOthers: paused && (await holdsOtherMessages(session, threadId)),
      };
    } finally {
      session.close();
    }
  }

  /**
   * Loads a thread that no Codex process has open. The messages queued for it
   * are then picked up here and run as turns in that same thread, one after
   * another, as they would in the Codex app. This returns when the last one
   * has ended (closing earlier would cut the next one off), with the answer of
   * the turn that the marker's message started. The turns run under the
   * thread's own approval policy (an override would stick to the thread) and in
   * the given sandbox, in the thread's own folder unless `cwd` moves it.
   * Requests for approval are declined, since nobody is there to answer them.
   * In a thread paused by a stopped turn, `startQueued` starts that message.
   */
  async wakeThread(options: WakeOptions): Promise<TurnResult> {
    const { threadId } = options;
    const session = await this.appServer({ experimental: options.startQueued !== undefined });
    try {
      const started = session.listen(turnEvent("turn/started", threadId));
      const completed = session.listen(turnEvent("turn/completed", threadId));
      await session.request("thread/resume", { threadId, sandbox: options.sandbox, excludeTurns: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
      options.onOpen?.();
      if (options.startQueued) await session.request("thread/queue/start", { threadId, queuedSubmissionId: options.startQueued });
      const startTimeoutMs = options.startTimeoutMs ?? 60_000;
      let ran = 0;
      for (let start = await started.next(startTimeoutMs); start; start = await started.next(NEXT_TURN_MS)) {
        if (!(await completed.next(options.timeoutMs))) {
          // Stopped, rather than cut off when the server closes, it is recorded as over and does not look busy later.
          await session.request("turn/interrupt", { threadId, turnId: start.params?.turn?.id }).catch(() => undefined);
          throw timedOut(options.timeoutMs, "the turn to finish");
        }
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
}
