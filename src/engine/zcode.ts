// ZCode's documented headless prompt interface. These are dedicated CLI sessions;
// this adapter does not inject messages into conversations open in the desktop app.

import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Sandbox } from "../core/definition.js";
import { isRecord } from "../core/patch.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";
import { runSessionProcess } from "./session-processes.js";

/** Native tool policies, not OS sandboxes. Prompt mode otherwise defaults to yolo. */
const MODES: Record<Sandbox, string> = {
  "read-only": "plan",
  "workspace-write": "edit",
  "danger-full-access": "yolo",
};
// The CLI creates sess_<uuid>; its mailbox accepts this same session-id alphabet.
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && value === value.trim() && /^sess_[A-Za-z0-9._-]+$/.test(value);

export interface ZCodeRunOptions {
  /** Omit to create a dedicated session; subsequent turns resume its returned id. */
  sessionId?: string;
  cwd: string;
  message: string;
  sandbox: Sandbox;
  timeoutMs: number;
  /** Called once the session is owned, before a resumed CLI is allowed to start. */
  onStart?: () => void;
}

export type ZCodeTurnResult = TurnResult & { sessionId?: string; busy?: boolean; sessionGone?: boolean };

export interface ZCodeRunner {
  run(options: ZCodeRunOptions): Promise<ZCodeTurnResult>;
}

const brief = (text: string) => text.trim().split("\n")[0]!.slice(0, 500);

export class ZCodeCli implements ZCodeRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string, private readonly sessionsDir: string) {
    ({ command: this.command, prefix: this.prefix } = cliCommand(bin));
  }

  async run(options: ZCodeRunOptions): Promise<ZCodeTurnResult> {
    if (options.sessionId !== undefined && !isSessionId(options.sessionId)) {
      return { ok: false, error: "zcode --prompt: invalid sessionId to resume" };
    }
    const fail = (reason: string): ZCodeTurnResult => ({ ok: false, error: `zcode --prompt: ${brief(reason)}` });
    const args = ["--prompt", options.message, "--cwd", options.cwd, "--mode", MODES[options.sandbox], "--output-format", "json"];
    if (options.sessionId) args.push("--resume", options.sessionId);
    const outcome = await runSessionProcess({
      host: "zcode",
      hostName: "ZCode",
      sessionsDir: this.sessionsDir,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cwd: options.cwd,
      command: this.command,
      args: [...this.prefix, ...args],
      timeoutMs: options.timeoutMs,
      ...(options.onStart ? { onStart: options.onStart } : {}),
    });
    if (outcome.kind === "busy") return { ok: false, busy: true, error: "zcode --prompt: session is already running" };
    if (outcome.kind === "failed") return fail(outcome.reason);
    const { code, signal, stdout, stderr } = outcome;
    // Native resume validation fails before a turn has produced output.
    // Include the requested id and only allow the CLI's optional trace id.
    const diagnostic = stripVTControlCharacters(stderr).trim()
      .replace(/ \(traceId: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/i, "");
    if (options.sessionId && code === 1 && !stdout.trim()
      && diagnostic === `Error: Session not found: ${options.sessionId}`) {
      return { ok: false, sessionGone: true, error: `zcode --prompt: Session not found: ${options.sessionId}` };
    }
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      return fail(stderr || (code === 0 ? "no valid JSON result" : `exit code ${code}${signal ? ` (${signal})` : ""}`));
    }
    if (!isRecord(result)) return fail("no JSON result object");
    const error = typeof result.error === "string" ? result.error : isRecord(result.error) && typeof result.error.message === "string" ? result.error.message : undefined;
    if (code !== 0) return fail(error || stderr || `exit code ${code}${signal ? ` (${signal})` : ""}`);
    if (result.error) return fail(error || "the result contains an error");
    // Native command-center results can omit projection; ordinary prompts include it.
    if (isRecord(result.projection) && result.projection.status !== "idle") return fail(`session did not finish (status: ${String(result.projection.status)})`);
    if (!isSessionId(result.sessionId)) return fail("the result has no valid sessionId");
    if (options.sessionId && result.sessionId !== options.sessionId) return fail("the result belongs to a different session than requested");
    if (typeof result.response !== "string" || !result.response.trim()) return fail("the result has no response");
    // An idle result is a completed model turn, not proof that its tools or
    // the requested task succeeded. trigger_report carries the task outcome.
    return { ok: true, sessionId: result.sessionId, lastMessage: result.response };
  }
}

/** ZCode's CLI: an explicit executable, PATH, then its usual local installation. */
export function findZCode(): string | undefined {
  const fromEnv = process.env.ZCODE_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const local = join(homedir(), ".local", "bin", "zcode");
  return which("zcode") ?? (isExecutable(local) ? local : undefined);
}
