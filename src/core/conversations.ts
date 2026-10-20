// Conversation references keep each host's ids separate: bare Codex thread ids,
// "cc:" for Claude Code sessions and "zc:" for ZCode sessions.

import type { TriggerDefinition } from "./definition.js";

const SESSION_PREFIX = "cc:";

export type Host = "codex" | "claude-code" | "zcode";

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
  return { codex: "Codex", "claude-code": "Claude", zcode: "ZCode" }[host];
}

/** How to get back to a conversation: a command for a terminal, and a link where the app has one. */
export function reopen(ref: string): { command: string; url?: string } {
  const zcode = zcodeSessionIdOf(ref);
  if (zcode !== undefined) return { command: `zcode --resume ${zcode}` };
  const sessionId = sessionIdOf(ref);
  if (sessionId !== undefined) return { command: `claude --resume ${sessionId}` };
  return { command: `codex resume ${ref}`, url: `codex://threads/${ref}` };
}
