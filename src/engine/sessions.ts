// Claude Code sessions, as the Claude Code plugin sees them.
//
// The plugin's hooks (cc-plugin/bin/session-hook.mjs) record which session each
// running Claude Code process shows, with its inbox socket (inboxes/<key>.json),
// and where each session works and whether a turn runs there (sessions/<id>.json).
//
// A fire for a session that a process shows goes into that process's inbox once
// no turn runs there (the executor decides when, from the hooks' records and from
// when the session last wrote its transcript), and Claude Code starts a turn
// with it. It is posted by the plugin's MCP server in that process, through a
// small relay socket: as the session's own child, it is delivered in every
// permission mode, where a message from outside waits for the user's approval in
// a session that bypasses permission prompts. Without the relay it is posted
// straight to the inbox. A fire for a session that no process shows runs
// headless, with `claude -p --resume`, in the session's folder.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "../core/definition.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";
import { ensurePrivateDir } from "./fs-util.js";
import { socketPath, type Paths } from "./paths.js";

/** What the hooks record about a session. */
export interface SessionRecord {
  sessionId: string;
  /** The folder it works in. */
  cwd: string;
  /** Its transcript; gone when Claude Code has cleaned the session up. */
  transcript?: string;
  /** CLAUDE_CONFIG_DIR of the process that ran it, when one was set. */
  configDir?: string;
  /**
   * The session's latest turn: when it started or ended, whether it still runs, whether a Self-Starter
   * message started it, and that message's first line.
   */
  turn?: { at: string; running?: boolean; trigger: boolean; line?: string };
  startedAt: string;
  endedAt?: string;
}

/** What the hooks record about a running Claude Code process. */
export interface InboxRecord {
  /** The session it shows. */
  sessionId: string;
  /** Its inbox socket (CLAUDE_CODE_MESSAGING_SOCKET). */
  inbox: string;
  token?: string;
  /** false in a headless run (claude -p), where nobody reads along. */
  attended: boolean;
  /** The Claude Code process (CLAUDE_PID). */
  pid?: number;
  at: string;
}

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
const RELAY_MAX_BYTES = 1024 * 1024;

/** The name a process's files go under: a digest of its inbox socket's path. The hook computes it the same way. */
export function inboxKey(inbox: string): string {
  return createHash("sha256").update(inbox).digest("hex").slice(0, 16);
}

/** Where the plugin's MCP server in a process listens for fires to post into its inbox. */
export function relaySocket(paths: Paths, key: string): string {
  return socketPath(join(paths.inboxes, `${key}.sock`), `${paths.home}\0${key}`);
}

function readRecord<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readSession(paths: Paths, sessionId: string): SessionRecord | undefined {
  return SESSION_ID.test(sessionId) ? readRecord<SessionRecord>(join(paths.sessions, `${sessionId}.json`)) : undefined;
}

/**
 * When Claude Code last wrote to the session, in milliseconds (0 when unknown): its transcript, or the
 * transcript of one of its subagents, which Claude Code keeps beside it (<session id>/subagents/). A turn
 * writes there as it goes, so this tells a long turn from one that ended without a hook saying so.
 */
export function lastWritten(session: SessionRecord): number {
  if (!session.transcript) return 0;
  let latest = 0;
  const look = (path: string) => {
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) for (const name of readdirSync(path)) look(join(path, name));
      else if (path.endsWith(".jsonl")) latest = Math.max(latest, stat.mtimeMs);
    } catch {
      // not written yet, or cleaned up
    }
  };
  look(session.transcript);
  look(join(session.transcript.replace(/\.jsonl$/, ""), "subagents"));
  return latest;
}

/** When a Self-Starter message started the session's current turn: the fire it carries, if any (a new trigger session's first message carries none). */
export function triggerTurn(paths: Paths, sessionId: string): { fireId?: string } | undefined {
  const turn = readSession(paths, sessionId)?.turn;
  if (!turn?.trigger) return undefined;
  const fireId = /· (fire_[a-z0-9]+)\)\s*$/.exec(turn.line ?? "")?.[1];
  return fireId ? { fireId } : {};
}

/** The session a process shows now, from its inbox socket; it changes with /clear and /resume. */
export function currentSession(paths: Paths, inbox: string): string | undefined {
  return readRecord<InboxRecord>(join(paths.inboxes, `${inboxKey(inbox)}.json`))?.sessionId;
}

/** The processes that show a session, newest first. Headless runs are left out unless asked for. */
export function processesShowing(paths: Paths, sessionId: string, { headless = false } = {}): Array<InboxRecord & { key: string }> {
  let names: string[];
  try {
    names = readdirSync(paths.inboxes);
  } catch {
    return [];
  }
  const found: Array<InboxRecord & { key: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord<InboxRecord>(join(paths.inboxes, name));
    if (record?.sessionId === sessionId && (record.attended || headless)) found.push({ ...record, key: name.slice(0, -".json".length) });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

/** Sends a payload on a Unix socket, then waits for the other side to close; resolves with its answer. */
function exchange(path: string, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let answer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${path} within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/** Posts a message into a Claude Code process's inbox, the way one session messages another. */
export async function postToInbox(inbox: string, text: string, token?: string): Promise<void> {
  const lines = token ? [JSON.stringify({ type: "auth", token })] : [];
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  await exchange(inbox, `${lines.join("\n")}\n`, 10_000);
}

/** Asks the plugin's MCP server in a process to post a message into its own inbox. */
export async function relay(paths: Paths, key: string, text: string): Promise<void> {
  const answer = await exchange(relaySocket(paths, key), `${JSON.stringify({ text })}\n`, 15_000);
  let reply: { ok?: boolean; error?: string } = {};
  try {
    reply = JSON.parse(answer) as typeof reply;
  } catch {
    // no answer: the server went away
  }
  if (reply.ok !== true) throw new Error(reply.error ?? "the relay closed without posting the message");
}

/** In the plugin's MCP server: posts what the daemon sends into this process's inbox, as one of its children. */
export async function startRelay(paths: Paths, inbox: string, token: string | undefined): Promise<{ close(): void }> {
  ensurePrivateDir(paths.inboxes);
  const path = relaySocket(paths, inboxKey(inbox));
  rmSync(path, { force: true }); // left by a server that did not shut down
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > RELAY_MAX_BYTES) socket.destroy();
    });
    socket.on("end", () => {
      const answer = (reply: { ok: boolean; error?: string }) => socket.end(`${JSON.stringify(reply)}\n`);
      let text: unknown;
      try {
        text = (JSON.parse(body) as { text?: unknown }).text;
      } catch {
        // answered below
      }
      if (typeof text !== "string") return answer({ ok: false, error: "the request has no text" });
      postToInbox(inbox, text, token).then(
        () => answer({ ok: true }),
        (error: Error) => answer({ ok: false, error: `could not post into the inbox: ${error.message}` }),
      );
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return {
    close: () => {
      server.close();
      rmSync(path, { force: true });
    },
  };
}

/**
 * Hands a message to a running Claude Code process that shows the session, so
 * that it arrives in front of the user. Returns how it went in, or undefined
 * when no process shows the session. Records of processes that are gone are
 * removed on the way.
 */
export async function deliverToOpenSession(
  paths: Paths,
  sessionId: string,
  text: string,
  log: (line: string) => void,
): Promise<"relayed" | "posted" | undefined> {
  for (const shown of processesShowing(paths, sessionId)) {
    try {
      await relay(paths, shown.key, text);
      return "relayed";
    } catch (error) {
      log(`could not relay into session ${sessionId} (${(error as Error).message}); posting into its inbox`);
    }
    try {
      await postToInbox(shown.inbox, text, shown.token);
      return "posted";
    } catch {
      rmSync(join(paths.inboxes, `${shown.key}.json`), { force: true }); // the process is gone
    }
  }
  return undefined;
}

/**
 * How a fire runs headless, from the trigger's sandbox. Claude Code's permission
 * modes come closest: dontAsk only does what needs no approval (reading, and
 * what the user's allow rules permit), acceptEdits also edits files in the
 * folder, bypassPermissions skips every check. What would need approval is
 * declined, since nobody is there to give it.
 */
export const PERMISSION_MODE: Record<Sandbox, string> = {
  "read-only": "dontAsk",
  "workspace-write": "acceptEdits",
  "danger-full-access": "bypassPermissions",
};

/** The plugin's MCP server as Claude Code names it in permission rules: its tools may run in headless fires. */
export const PLUGIN_SERVER_RULE = "mcp__plugin_self-starter_self_starter";

export interface SessionRunOptions {
  sessionId: string;
  /** Start a new session with this id instead of resuming it. */
  start?: { name: string };
  cwd: string;
  message: string;
  sandbox: Sandbox;
  /** CLAUDE_CONFIG_DIR, when the session was made with one. */
  configDir?: string;
  timeoutMs: number;
}

/** Runs one turn of a session that no Claude Code process has open. */
export interface SessionRunner {
  run(options: SessionRunOptions): Promise<TurnResult>;
}

/**
 * What a Claude Code process sets for its children about itself and its session: the daemon may have been
 * started by one. A claude run with them would take itself for part of that session. The user's own
 * settings, such as CLAUDE_CODE_USE_BEDROCK or CLAUDE_CONFIG_DIR, stay.
 */
const SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
];

function outsideSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of SESSION_VARIABLES) delete clean[name];
  return clean;
}

/** `claude -p`: one headless turn, the message on stdin, the result as JSON. Arguments go as an array, never through a shell. */
export class ClaudeCli implements SessionRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string) {
    ({ command: this.command, prefix: this.prefix } = cliCommand(bin));
  }

  run(options: SessionRunOptions): Promise<TurnResult> {
    const args = ["-p", "--output-format", "json", "--permission-mode", PERMISSION_MODE[options.sandbox], "--allowedTools", PLUGIN_SERVER_RULE];
    args.push(...(options.start ? ["--session-id", options.sessionId, "--name", options.start.name] : ["--resume", options.sessionId]));
    const env = outsideSession(process.env);
    env.SELF_STARTER_TRIGGER_TURN = "1";
    if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
    return new Promise((resolve) => {
      const child = spawn(this.command, [...this.prefix, ...args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, options.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
      });
      child.stdin.on("error", () => undefined); // it exited before reading
      child.stdin.end(options.message);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `could not start claude: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let result: { result?: unknown; is_error?: boolean; subtype?: string } = {};
        try {
          result = JSON.parse(stdout) as typeof result;
        } catch {
          // reported below
        }
        const lastMessage = typeof result.result === "string" ? result.result : undefined;
        const ok = code === 0 && result.is_error === false;
        const turn: TurnResult = { ok };
        if (lastMessage !== undefined) turn.lastMessage = lastMessage;
        if (!ok) {
          const reason = timedOut ? `timed out after ${Math.round(options.timeoutMs / 1000)}s` : (stderr || lastMessage || stdout).trim().split("\n")[0] || `exit code ${code}`;
          turn.error = `claude -p: ${reason}`;
        }
        resolve(turn);
      });
    });
  }
}

/** The claude CLI: $CLAUDE_BIN, then PATH, then where its installers put it. */
export function findClaude(): string | undefined {
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const home = homedir();
  const known = [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return which("claude") ?? known.find(isExecutable);
}
