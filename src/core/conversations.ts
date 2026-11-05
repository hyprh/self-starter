// Conversation references and declarative host metadata: bare Codex thread ids,
// "cc:" for Claude Code, "agy:" for Antigravity, "zc:" for ZCode and "oc:" for OpenCode sessions.

import type { Sandbox, TriggerDefinition } from "./definition.js";

export const HOSTS = ["codex", "claude-code", "antigravity", "zcode", "opencode"] as const;

export type Host = (typeof HOSTS)[number];

export interface HostSpec {
  readonly host: Host;
  /** Conversation reference prefix; "" for bare Codex thread ids. */
  readonly prefix: string;
  /** Display name as the user knows it. */
  readonly agentName: string;
  /** Default CLI executable name. */
  readonly cliName: string;
  /** User-facing noun for a conversation on this host. */
  readonly noun: "thread" | "session";
  /** Whether fires can be delivered back to the origin conversation where the trigger was created. */
  readonly supportsOrigin: boolean;
  /** Plain-language phrase for a dedicated conversation in trigger descriptions. */
  readonly dedicatedTargetPhrase: string;
  /** Plain-language explanation of how background delivery into the origin conversation works. */
  originBackgroundNote(access: string): string;
  /** Plain-language explanation of what each sandbox level allows in background turns. */
  readonly sandboxDescriptions: Readonly<Record<Sandbox, string>>;
  /** Terminal command (and optional app deep-link URL) to reopen a conversation by its raw host id. */
  reopen(id: string): { command: string; url?: string };
}

const sessionOriginBackgroundNote = (access: string): string =>
  `if no terminal has it open, Self-Starter resumes it in the background: ${access}`;

export const HOST_SPECS: Readonly<Record<Host, HostSpec>> = {
  codex: {
    host: "codex",
    prefix: "",
    agentName: "Codex",
    cliName: "codex",
    noun: "thread",
    supportsOrigin: true,
    dedicatedTargetPhrase: "a dedicated thread",
    originBackgroundNote: (access) => `if no Codex app has it open, it runs there in the background: ${access}`,
    sandboxDescriptions: {
      "read-only": "read-only",
      "workspace-write": "can change files and run commands in its folder",
      "danger-full-access": "full access, no sandbox",
    },
    reopen: (id) => ({ command: `codex resume ${id}`, url: `codex://threads/${id}` }),
  },
  "claude-code": {
    host: "claude-code",
    prefix: "cc:",
    agentName: "Claude",
    cliName: "claude",
    noun: "session",
    supportsOrigin: true,
    dedicatedTargetPhrase: "a session of its own",
    originBackgroundNote: sessionOriginBackgroundNote,
    sandboxDescriptions: {
      "read-only": "only what needs no approval, such as reading",
      "workspace-write": "can edit files in its folder",
      "danger-full-access": "no permission checks",
    },
    reopen: (id) => ({ command: `claude --resume ${id}` }),
  },
  antigravity: {
    host: "antigravity",
    prefix: "agy:",
    agentName: "Antigravity",
    cliName: "agy",
    noun: "session",
    supportsOrigin: false,
    dedicatedTargetPhrase: "a session of its own",
    originBackgroundNote: sessionOriginBackgroundNote,
    sandboxDescriptions: {
      "read-only": "read tools only; writes and commands blocked by hook; no OS sandbox",
      "workspace-write": "can edit workspace files; commands blocked by hook; no OS sandbox",
      "danger-full-access": "no permission prompts; no OS sandbox",
    },
    reopen: (id) => ({ command: `agy --conversation ${id}` }),
  },
  zcode: {
    host: "zcode",
    prefix: "zc:",
    agentName: "ZCode",
    cliName: "zcode",
    noun: "session",
    supportsOrigin: false,
    dedicatedTargetPhrase: "a session of its own",
    originBackgroundNote: sessionOriginBackgroundNote,
    sandboxDescriptions: {
      "read-only": "plan mode: restricts writes and commands; no OS sandbox",
      "workspace-write": "edit mode: permits workspace edits; other tools may need approval; no OS sandbox",
      "danger-full-access": "yolo mode: skips ordinary tool approvals; no OS sandbox",
    },
    reopen: (id) => ({ command: `zcode --resume ${id}` }),
  },
  opencode: {
    host: "opencode",
    prefix: "oc:",
    agentName: "OpenCode",
    cliName: "opencode",
    noun: "session",
    supportsOrigin: false,
    dedicatedTargetPhrase: "a session of its own",
    originBackgroundNote: sessionOriginBackgroundNote,
    sandboxDescriptions: {
      "read-only": "read tools only; no OS sandbox",
      "workspace-write": "can edit workspace files; commands are not approved automatically; no OS sandbox",
      "danger-full-access": "no ordinary tool permission checks; no OS sandbox",
    },
    reopen: (id) => ({ command: `opencode --session ${id}` }),
  },
};

const PREFIXED_SPECS: readonly HostSpec[] = HOSTS.map((host) => HOST_SPECS[host]).filter((spec) => spec.prefix !== "");

export function hostSpec(host: Host): HostSpec {
  return HOST_SPECS[host];
}

export function supportsOrigin(host: Host): boolean {
  return HOST_SPECS[host].supportsOrigin;
}

export function formatRef(host: Host, id: string): string {
  return `${HOST_SPECS[host].prefix}${id}`;
}

export function parseRef(ref: string | null | undefined): { host: Host; id: string } | undefined {
  if (ref === null || ref === undefined) return undefined;
  for (const spec of PREFIXED_SPECS) {
    if (ref.startsWith(spec.prefix)) {
      return { host: spec.host, id: ref.slice(spec.prefix.length) };
    }
  }
  return { host: "codex", id: ref };
}

function idForHost(host: Host, ref: string | null | undefined): string | undefined {
  const parsed = parseRef(ref);
  return parsed?.host === host ? parsed.id : undefined;
}

export function antigravityRef(sessionId: string): string {
  return formatRef("antigravity", sessionId);
}

export function antigravitySessionIdOf(ref: string | null | undefined): string | undefined {
  return idForHost("antigravity", ref);
}

export function opencodeRef(sessionId: string): string {
  return formatRef("opencode", sessionId);
}

export function opencodeSessionIdOf(ref: string | null | undefined): string | undefined {
  return idForHost("opencode", ref);
}

export function zcodeRef(sessionId: string): string {
  return formatRef("zcode", sessionId);
}

export function zcodeSessionIdOf(ref: string | null | undefined): string | undefined {
  return idForHost("zcode", ref);
}

export function sessionRef(sessionId: string): string {
  return formatRef("claude-code", sessionId);
}

/** The Claude Code session id, or undefined for another host. */
export function sessionIdOf(ref: string | null | undefined): string | undefined {
  return idForHost("claude-code", ref);
}

export function hostOf(ref: string | null | undefined): Host {
  return parseRef(ref)?.host ?? "codex";
}

/** The agent a trigger's fires go to: the one it was made in. */
export function hostFor(def: TriggerDefinition): Host {
  const own = def.target.kind === "dedicated" ? def.target.thread_id : undefined;
  return hostOf(own ?? def.meta.origin_thread_id);
}

/** What the user calls a conversation there. */
export function conversationNoun(host: Host): "thread" | "session" {
  return HOST_SPECS[host].noun;
}

/** The agent's name, as the user knows it. */
export function agentName(host: Host): string {
  return HOST_SPECS[host].agentName;
}

/** How to get back to a conversation: a command for a terminal, and a link where the app has one. */
export function reopen(ref: string): { command: string; url?: string } {
  const parsed = parseRef(ref)!;
  return HOST_SPECS[parsed.host].reopen(parsed.id);
}
