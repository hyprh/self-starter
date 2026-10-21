// OpenCode's headless runner. Dedicated sessions keep background turns separate
// from conversations the user is working in.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Sandbox } from "../core/definition.js";
import { isRecord } from "../core/patch.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";

const OUTPUT_LIMIT = 1024 * 1024;
const ERROR_LIMIT = 16 * 1024;
const isSessionId = (value: unknown): value is string => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value);
const brief = (text: string) => text.trim().split("\n")[0]!.slice(0, 500);

export interface OpenCodeRunOptions {
  /** Omit to create a dedicated result session; subsequent turns resume it. */
  sessionId?: string;
  cwd: string;
  message: string;
  sandbox: Sandbox;
  timeoutMs: number;
  /** The session is owned, but no CLI has started yet. */
  onStart?: () => void;
}

export type OpenCodeTurnResult = TurnResult & { sessionId?: string; busy?: boolean; sessionGone?: boolean };

export interface OpenCodeRunner {
  run(options: OpenCodeRunOptions): Promise<OpenCodeTurnResult>;
}

/** Native tool permissions, not operating-system isolation. */
export function openCodePermission(sandbox: Sandbox): Record<string, string> {
  const permissions: Record<string, string> = { "*": sandbox === "danger-full-access" ? "allow" : "deny" };
  if (sandbox !== "danger-full-access") {
    for (const tool of ["read", "glob", "grep", "list", "skill"]) permissions[tool] = "allow";
    if (sandbox === "workspace-write") permissions.edit = "allow";
    permissions.external_directory = "deny";
  }
  permissions["trigger_*"] = "allow";
  permissions.service_status = "allow";
  return { ...permissions, question: "deny", plan_enter: "deny", plan_exit: "deny" };
}

function configuration(sandbox: Sandbox, agent: string, configDir: string | undefined): string {
  const errors: ParseError[] = [];
  const original: unknown = parseJsonc(process.env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true });
  if (errors[0]) throw new Error(`invalid OPENCODE_CONFIG_CONTENT: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  if (!isRecord(original)) throw new Error("OPENCODE_CONFIG_CONTENT must be an object");
  const plugins = original.plugin ?? [];
  if (!Array.isArray(plugins)) throw new Error("OPENCODE_CONFIG_CONTENT.plugin must be an array");
  return JSON.stringify({
    ...original,
    // Load our managed file explicitly without replacing the user's config directory.
    ...(configDir ? { plugin: [...plugins, pathToFileURL(join(configDir, "plugins", "self-starter.js")).href] } : {}),
    agent: {
      ...(isRecord(original.agent) ? original.agent : {}),
      [agent]: { description: "Handle an authorized Self-Starter event", mode: "primary", permission: openCodePermission(sandbox) },
    },
  });
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return undefined;
  if (typeof error.message === "string") return error.message;
  return isRecord(error.data) && typeof error.data.message === "string" ? error.data.message : undefined;
}

function resultFrom(output: string, expected: string | undefined): OpenCodeTurnResult {
  let sessionId: string | undefined;
  let answer = "";
  let reason: unknown;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { return { ok: false, error: "no valid JSON event stream" }; }
    if (!isRecord(event) || !isSessionId(event.sessionID)) return { ok: false, error: "event has no valid sessionID" };
    if (sessionId && event.sessionID !== sessionId || expected && event.sessionID !== expected) return { ok: false, error: "the result belongs to a different session than requested" };
    sessionId = event.sessionID;
    if (event.type === "error") return { ok: false, error: errorMessage(event.error) ?? "OpenCode reported an error" };
    const part = isRecord(event.part) ? event.part : {};
    if (event.type === "step_start") { answer = ""; reason = undefined; }
    if (event.type === "text" && typeof part.text === "string") answer += part.text;
    if (event.type === "step_finish") reason = part.reason;
  }
  if (!sessionId) return { ok: false, error: "no valid JSON event stream" };
  if (reason !== "stop") return { ok: false, error: `session did not finish (reason: ${String(reason ?? "missing")})` };
  if (!answer.trim()) return { ok: false, error: "the result has no final response" };
  return { ok: true, sessionId, lastMessage: answer };
}

export class OpenCodeCli implements OpenCodeRunner {
  private readonly command: string;
  private readonly prefix: string[];

  constructor(bin: string, private readonly sessionsDir: string, private readonly configDir?: string) {
    ({ command: this.command, prefix: this.prefix } = cliCommand(bin));
  }

  run(options: OpenCodeRunOptions): Promise<OpenCodeTurnResult> {
    if (options.sessionId !== undefined && !isSessionId(options.sessionId)) return Promise.resolve({ ok: false, error: "opencode run: invalid sessionId to resume" });
    // A fresh name prevents project or global agents from contributing extra
    // permissions when OpenCode deep-merges its configuration.
    const agent = `self-starter-${randomUUID()}`;
    let config: string;
    try { config = configuration(options.sandbox, agent, this.configDir); }
    catch (error) { return Promise.resolve({ ok: false, error: `opencode run: ${error instanceof Error ? error.message : String(error)}` }); }
    const args = ["run", "--dir", options.cwd, "--format", "json", "--agent", agent];
    if (options.sessionId) args.push("--session", options.sessionId);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("./session-process.js", import.meta.url)),
        this.sessionsDir, options.sessionId ?? "", String(options.timeoutMs), this.command, ...this.prefix, ...args,
      ], {
        cwd: options.cwd,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: config, SELF_STARTER_HOST: "opencode", SELF_STARTER_TRIGGER_TURN: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      let stopped: string | undefined;
      let settled = false;
      let started = false;
      let busy = false;
      const finish = (result: OpenCodeTurnResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (reason: string) => finish({ ok: false, error: `opencode run: ${brief(reason)}` });
      const stop = (reason: string) => {
        if (stopped || settled) return;
        stopped = reason;
        try { if (child.pid) process.kill(child.pid, "SIGTERM"); }
        catch { child.kill("SIGKILL"); }
      };
      const timer = setTimeout(() => stop(`timed out after ${Math.ceil(options.timeoutMs / 1000)}s`), options.timeoutMs);
      child.on("message", (message: unknown) => {
        if (!isRecord(message) || started || stopped || settled) return;
        if (message.type === "busy") { busy = true; return; }
        if (message.type !== "ready") return;
        started = true;
        try { options.onStart?.(); }
        catch (error) {
          stop(`could not record turn start: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        child.send({ type: "go", stdin: options.message }, (error) => { if (error) stop(`could not start owned session: ${error.message}`); });
      });
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > OUTPUT_LIMIT) stop(`output exceeded ${OUTPUT_LIMIT} bytes`);
        else stdout += chunk;
      });
      child.stderr!.on("data", (chunk: string) => { stderr += chunk.slice(0, Math.max(0, ERROR_LIMIT - stderr.length)); });
      child.on("error", (error) => fail(`could not start OpenCode: ${error.message}`));
      child.on("close", (code, signal) => {
        if (busy) return finish({ ok: false, busy: true, error: "opencode run: session is already running" });
        if (stopped) return fail(stopped);
        // OpenCode 1.x rejects a missing resume target before emitting any
        // model events. Never infer this from a provider or tool's error text.
        if (options.sessionId && code === 1 && !stdout.trim()
          && stripVTControlCharacters(stderr).trim() === "Error: Session not found") {
          return finish({ ok: false, sessionGone: true, error: "opencode run: Session not found" });
        }
        const result = resultFrom(stdout, options.sessionId);
        if (code !== 0) return fail(!result.ok && result.error !== "no valid JSON event stream" ? result.error! : stderr || `exit code ${code}${signal ? ` (${signal})` : ""}`);
        if (!result.ok) return fail(result.error!);
        finish(result);
      });
    });
  }
}

/** An explicit executable, PATH, then OpenCode's shell installer location. */
export function findOpenCode(): string | undefined {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit && isExecutable(explicit)) return explicit;
  const local = join(homedir(), ".opencode", "bin", "opencode");
  return which("opencode") ?? (isExecutable(local) ? local : undefined);
}
