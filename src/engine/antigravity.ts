// Google Antigravity (`agy`) headless prompt interface. These are dedicated CLI
// sessions (`agy --conversation <id>`); this adapter does not inject messages
// into open Antigravity 2.0 desktop or IDE conversations.

import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Sandbox } from "../core/definition.js";
import { isRecord } from "../core/patch.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";
import { runSessionProcess } from "./session-processes.js";

/**
 * Environment variables that an active Antigravity session sets for its child
 * processes. A daemon started from inside Antigravity must strip them so each
 * headless `agy --print` invocation runs as an independent CLI session.
 */
export const ANTIGRAVITY_SESSION_VARIABLES = [
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_SOURCE_METADATA",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_TRAJECTORY_ID",
  "ANTIGRAVITY_PROJECT_ID",
  "ANTIGRAVITY_APP_DATA_DIR",
  "AGY_BROWSER_WS_URL",
  "AGY_BROWSER_ACTIVE_PORT_FILE",
];

// `agy` creates UUID conversation ids; disallow dots and path separators for lock safety.
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export interface AntigravityRunOptions {
  /** Omit to create a dedicated session; subsequent turns resume its returned conversation_id. */
  sessionId?: string;
  cwd: string;
  message: string;
  sandbox: Sandbox;
  timeoutMs: number;
  /** Called once the session is owned, before a resumed CLI is allowed to start. */
  onStart?: () => void;
}

export type AntigravityTurnResult = TurnResult & { sessionId?: string; busy?: boolean; sessionGone?: boolean };

export interface AntigravityRunner {
  run(options: AntigravityRunOptions): Promise<AntigravityTurnResult>;
}

const brief = (text: string) => text.trim().split("\n")[0]!.slice(0, 500);

export class AntigravityCli implements AntigravityRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string, private readonly sessionsDir: string) {
    ({ command: this.command, prefix: this.prefix } = cliCommand(bin));
  }

  async run(options: AntigravityRunOptions): Promise<AntigravityTurnResult> {
    if (options.sessionId !== undefined && !isSessionId(options.sessionId)) {
      return { ok: false, error: "agy --print: invalid sessionId to resume" };
    }
    const fail = (reason: string): AntigravityTurnResult => ({ ok: false, error: `agy --print: ${brief(reason)}` });
    // Headless `agy -p` denies MCP tools unless permissions are bypassed; the
    // plugin's PreToolUse guard hook (`agy-plugin/bin/guard.mjs`) still runs and
    // enforces SELF_STARTER_SANDBOX + blocks trigger mutations.
    const args = ["--print", options.message, "--dangerously-skip-permissions", "--output-format", "json"];
    if (options.sessionId) args.push("--conversation", options.sessionId);
    const outcome = await runSessionProcess({
      host: "antigravity",
      hostName: "Antigravity",
      sessionsDir: this.sessionsDir,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cwd: options.cwd,
      command: this.command,
      args: [...this.prefix, ...args],
      env: {
        SELF_STARTER_SANDBOX: options.sandbox,
        SELF_STARTER_WORKSPACE: options.cwd,
      },
      unsetEnv: ANTIGRAVITY_SESSION_VARIABLES,
      timeoutMs: options.timeoutMs,
      ...(options.onStart ? { onStart: options.onStart } : {}),
    });
    if (outcome.kind === "busy") return { ok: false, busy: true, error: "agy --print: session is already running" };
    if (outcome.kind === "failed") return fail(outcome.reason);
    const { code, signal, stdout, stderr } = outcome;
    const stderrLines = stripVTControlCharacters(stderr).split("\n").map((line) => line.trim()).filter(Boolean);
    const missingTarget = options.sessionId !== undefined && stderrLines.some((line) =>
      line === `warning: conversation "${options.sessionId}" not found`
      || line === `Error: conversation "${options.sessionId}" not found`
      || line === `Error: Session not found: ${options.sessionId}`,
    );
    if (missingTarget && !stdout.trim()) {
      return { ok: false, sessionGone: true, error: `agy --print: conversation "${options.sessionId}" not found` };
    }
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      return fail(stderr || (code === 0 ? "no valid JSON result" : `exit code ${code}${signal ? ` (${signal})` : ""}`));
    }
    if (!isRecord(result)) return fail("no JSON result object");
    // Real `agy --conversation <missing>` warns on stderr and starts a new conversation_id.
    if (missingTarget && result.conversation_id !== options.sessionId) {
      return { ok: false, sessionGone: true, error: `agy --print: conversation "${options.sessionId}" not found` };
    }
    const error = typeof result.error === "string"
      ? result.error
      : isRecord(result.error) && typeof result.error.message === "string"
        ? result.error.message
        : undefined;
    if (code !== 0) return fail(error || stderr || `exit code ${code}${signal ? ` (${signal})` : ""}`);
    if (result.error) return fail(error || "the result contains an error");
    if (result.status !== undefined && result.status !== "SUCCESS") {
      return fail(error || `session did not finish (status: ${String(result.status)})`);
    }
    if (!isSessionId(result.conversation_id)) return fail("the result has no valid conversation_id");
    if (options.sessionId && result.conversation_id !== options.sessionId) {
      return fail("the result belongs to a different session than requested");
    }
    if (typeof result.response !== "string" || !result.response.trim()) return fail("the result has no response");
    return { ok: true, sessionId: result.conversation_id, lastMessage: result.response };
  }
}

/** Antigravity's CLI: an explicit executable, PATH, then its usual local installation paths. */
export function findAntigravity(): string | undefined {
  const fromEnv = process.env.AGY_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const home = homedir();
  const known = [join(home, ".local", "bin", "agy"), join(home, ".antigravity", "bin", "agy")];
  return which("agy") ?? known.find(isExecutable);
}
