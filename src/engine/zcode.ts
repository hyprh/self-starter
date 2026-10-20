// ZCode's documented headless prompt interface. These are dedicated CLI sessions;
// this adapter does not inject messages into conversations open in the desktop app.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "../core/definition.js";
import { isRecord } from "../core/patch.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";

/** Native tool policies, not OS sandboxes. Prompt mode otherwise defaults to yolo. */
const MODES: Record<Sandbox, string> = {
  "read-only": "plan",
  "workspace-write": "edit",
  "danger-full-access": "yolo",
};
const OUTPUT_LIMIT = 1024 * 1024;
const ERROR_LIMIT = 16 * 1024;
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

export type ZCodeTurnResult = TurnResult & { sessionId?: string; busy?: boolean };

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

  run(options: ZCodeRunOptions): Promise<ZCodeTurnResult> {
    if (options.sessionId !== undefined && !isSessionId(options.sessionId)) {
      return Promise.resolve({ ok: false, error: "zcode --prompt: invalid sessionId to resume" });
    }
    const args = ["--prompt", options.message, "--cwd", options.cwd, "--mode", MODES[options.sandbox], "--output-format", "json"];
    if (options.sessionId) args.push("--resume", options.sessionId);
    return new Promise((resolve) => {
      // The wrapper owns the deadline even after a daemon crash, and a resumed
      // turn also owns a lease until the CLI finishes.
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("./zcode-process.js", import.meta.url)),
        this.sessionsDir, options.sessionId ?? "", String(options.timeoutMs), this.command, ...this.prefix, ...args,
      ], {
        cwd: options.cwd,
        env: { ...process.env, SELF_STARTER_HOST: "zcode", SELF_STARTER_TRIGGER_TURN: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      let stopped: string | undefined;
      let settled = false;
      let busy = false;
      let started = false;
      const finish = (result: ZCodeTurnResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (reason: string) => finish({ ok: false, error: `zcode --prompt: ${brief(reason)}` });
      const stop = (reason: string) => {
        if (stopped || settled) return;
        stopped = reason;
        // The owner kills the CLI's process group, including tools holding stdout.
        try {
          if (child.pid) process.kill(child.pid, "SIGTERM");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => stop(`timed out after ${Math.ceil(options.timeoutMs / 1000)}s`), options.timeoutMs);
      const start = () => {
        if (started || stopped || settled) return;
        started = true;
        try {
          options.onStart?.();
        } catch (error) {
          // The receipt was not saved. A waiting wrapper must not launch a turn.
          stop(`could not record turn start: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        child.send({ type: "go" }, (error) => {
          if (error) stop(`could not start owned session: ${error.message}`);
        });
      };
      child.on("message", (message: unknown) => {
        if (!isRecord(message) || started) return;
        if (message.type === "ready") start();
        else if (message.type === "busy") busy = true;
      });
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > OUTPUT_LIMIT) stop(`output exceeded ${OUTPUT_LIMIT} bytes`);
        else stdout += chunk;
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk.slice(0, Math.max(0, ERROR_LIMIT - stderr.length));
      });
      child.on("error", (error) => fail(`could not start ZCode: ${error.message}`));
      child.on("close", (code, signal) => {
        if (busy) return finish({ ok: false, busy: true, error: "zcode --prompt: session is already running" });
        if (stopped) return fail(stopped);
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
        finish({ ok: true, sessionId: result.sessionId, lastMessage: result.response });
      });
    });
  }
}

/** ZCode's CLI: an explicit executable, PATH, then its usual local installation. */
export function findZCode(): string | undefined {
  const fromEnv = process.env.ZCODE_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const local = join(homedir(), ".local", "bin", "zcode");
  return which("zcode") ?? (isExecutable(local) ? local : undefined);
}
