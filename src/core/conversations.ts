// Conversation references keep each host's ids separate: bare Codex thread ids,
// "cc:" for Claude Code, "agy:" for Antigravity, "zc:" for ZCode and "oc:" for OpenCode sessions.

import type { TriggerDefinition } from "./definition.js";

const SESSION_PREFIX = "cc:";

export type Host = "codex" | "claude-code" | "antigravity" | "zcode" | "opencode";

export function antigravityRef(sessionId: string): string {
  return `agy:${sessionId}`;
}

export function antigravitySessionIdOf(ref: string | null | undefined): string | undefined {
  return ref?.startsWith("agy:") ? ref.slice(4) : undefined;
}

export function opencodeRef(sessionId: string): string {
  return `oc:${sessionId}`;
}

export function opencodeSessionIdOf(ref: string | null | undefined): string | undefined {
  return ref?.startsWith("oc:") ? ref.slice(3) : undefined;
}

export function zcodeRef(sessionId: string): string {
  return `zc:${sessionId}`;
}

export function zcodeSessionIdOf(ref: string | null | undefined): string | undefined {
  return ref?.startsWith("zc:") ? ref.slice(3) : undefined;
}

export function sessionRef(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

/** The Claude Code session id, or undefined for another host. */
export function sessionIdOf(ref: string | null | undefined): string | undefined {
  return ref?.startsWith(SESSION_PREFIX) ? ref.slice(SESSION_PREFIX.length) : undefined;
}

export function hostOf(ref: string | null | undefined): Host {
  if (antigravitySessionIdOf(ref) !== undefined) return "antigravity";
  if (opencodeSessionIdOf(ref) !== undefined) return "opencode";
  if (zcodeSessionIdOf(ref) !== undefined) return "zcode";
  return sessionIdOf(ref) === undefined ? "codex" : "claude-code";
}

/** The agent a trigger's fires go to: the one it was made in. */
export function hostFor(def: TriggerDefinition): Host {
  const own = def.target.kind === "dedicated" ? def.target.thread_id : undefined;
  return hostOf(own ?? def.meta.origin_thread_id);
}

/** What the user calls a conversation there. */
export function conversationNoun(host: Host): "thread" | "session" {
  return host === "codex" ? "thread" : "session";
}

/** The agent's name, as the user knows it. */
export function agentName(host: Host): string {
  return { codex: "Codex", "claude-code": "Claude", antigravity: "Antigravity", zcode: "ZCode", opencode: "OpenCode" }[host];
}

/** How to get back to a conversation: a command for a terminal, and a link where the app has one. */
export function reopen(ref: string): { command: string; url?: string } {
  const agy = antigravitySessionIdOf(ref);
  if (agy !== undefined) return { command: `agy --conversation ${agy}` };
  const opencode = opencodeSessionIdOf(ref);
  if (opencode !== undefined) return { command: `opencode --session ${opencode}` };
  const zcode = zcodeSessionIdOf(ref);
  if (zcode !== undefined) return { command: `zcode --resume ${zcode}` };
  const sessionId = sessionIdOf(ref);
  if (sessionId !== undefined) return { command: `claude --resume ${sessionId}` };
  return { command: `codex resume ${ref}`, url: `codex://threads/${ref}` };
}
