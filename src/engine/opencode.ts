// OpenCode's headless runner. Dedicated sessions keep background turns separate
// from conversations the user is working in.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Sandbox } from "../core/definition.js";
import { isRecord } from "../core/patch.js";
import type { TurnResult } from "./codex.js";
import { cliCommand, isExecutable, which } from "./config.js";
import { runSessionProcess } from "./session-processes.js";

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

  async run(options: OpenCodeRunOptions): Promise<OpenCodeTurnResult> {
    if (options.sessionId !== undefined && !isSessionId(options.sessionId)) return { ok: false, error: "opencode run: invalid sessionId to resume" };
    // A fresh name prevents project or global agents from contributing extra
    // permissions when OpenCode deep-merges its configuration.
    const agent = `self-starter-${randomUUID()}`;
    let config: string;
    try { config = configuration(options.sandbox, agent, this.configDir); }
    catch (error) { return { ok: false, error: `opencode run: ${error instanceof Error ? error.message : String(error)}` }; }
    const fail = (reason: string): OpenCodeTurnResult => ({ ok: false, error: `opencode run: ${brief(reason)}` });
    const args = ["run", "--dir", options.cwd, "--format", "json", "--agent", agent];
    if (options.sessionId) args.push("--session", options.sessionId);
    const outcome = await runSessionProcess({
      host: "opencode",
      hostName: "OpenCode",
      sessionsDir: this.sessionsDir,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cwd: options.cwd,
      command: this.command,
      args: [...this.prefix, ...args],
      env: { OPENCODE_CONFIG_CONTENT: config },
      stdin: options.message,
      timeoutMs: options.timeoutMs,
      ...(options.onStart ? { onStart: options.onStart } : {}),
    });
    if (outcome.kind === "busy") return { ok: false, busy: true, error: "opencode run: session is already running" };
    if (outcome.kind === "failed") return fail(outcome.reason);
    const { code, signal, stdout, stderr } = outcome;
    // OpenCode 1.x rejects a missing resume target before emitting any
    // model events. Never infer this from a provider or tool's error text.
    if (options.sessionId && code === 1 && !stdout.trim()
      && stripVTControlCharacters(stderr).trim() === "Error: Session not found") {
      return { ok: false, sessionGone: true, error: "opencode run: Session not found" };
    }
    const result = resultFrom(stdout, options.sessionId);
    if (code !== 0) return fail(!result.ok && result.error !== "no valid JSON event stream" ? result.error! : stderr || `exit code ${code}${signal ? ` (${signal})` : ""}`);
    if (!result.ok) return fail(result.error!);
    return result;
  }
}

/** An explicit executable, PATH, then OpenCode's shell installer location. */
export function findOpenCode(): string | undefined {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit && isExecutable(explicit)) return explicit;
  const local = join(homedir(), ".opencode", "bin", "opencode");
  return which("opencode") ?? (isExecutable(local) ? local : undefined);
}
