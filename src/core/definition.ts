// Trigger definitions: the YAML a user can read and edit, its validation and defaults.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseDuration } from "./duration.js";

export type Mode = "state" | "event";
export type Concurrency = "skip" | "queue" | "coalesce";
export type ActionType = "notify" | "agent";
export type TargetKind = "origin" | "dedicated";
export type NotifyWhen = "always" | "receipt" | "never";
/** How Codex runs when it handles a fire in a dedicated thread (Codex's own sandbox modes). */
export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
/** What a probe may do: what the user can ("full"), or only reach the hosts it lists ("sandbox"). */
export type ProbeAccess = "full" | "sandbox";
export type Channel = "desktop" | "email";

export interface QuietHours {
  from: string;
  to: string;
  tz: string;
}

export interface TriggerDefinition {
  version: 1;
  id: string;
  name: string;
  intent: string;
  probe: {
    runtime: "deno";
    entry: string;
    access: ProbeAccess;
    params: Record<string, unknown>;
    /** env: secrets passed in as environment variables. net: the only hosts a sandboxed probe can reach. */
    permissions: { net: string[]; env: string[] };
    interval: { min: string; max: string; default: string };
    timeout: string;
  };
  mode: Mode;
  for?: string;
  policy: {
    cooldown?: string;
    max_fires?: number;
    expires_at?: string;
    concurrency: Concurrency;
    quiet_hours?: QuietHours;
  };
  action: { type: ActionType; prompt?: string; sandbox: Sandbox };
  target: { kind: TargetKind; cwd?: string; thread_id?: string | null };
  notify: { when: NotifyWhen; channels?: Channel[] };
  meta: {
    created_at: string;
    origin_thread_id?: string | null;
    activated_at?: string | null;
    revision: number;
    /** The ready-made recipe the probe comes from, such as "ibkr-account@1". */
    recipe?: string;
  };
}

export type ValidationResult =
  | { ok: true; definition: TriggerDefinition }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENTRY_PATTERN = /^[A-Za-z0-9_.-]+\.(?:ts|js|mjs)$/;
const HOST_PATTERN = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const TOP_LEVEL_KEYS = new Set([
  "version", "id", "name", "intent", "probe", "mode", "for", "policy", "action", "target", "notify", "meta",
]);

export const LIMITS = {
  intervalMinMs: 10_000,
  intervalMaxMs: 7 * 86_400_000,
  timeoutMaxMs: 5 * 60_000,
  forMaxMs: 86_400_000,
  cooldownMaxMs: 30 * 86_400_000,
  paramsBytes: 16 * 1024,
  promptChars: 4000,
  intentChars: 2000,
  nameChars: 120,
};

export const DEFAULT_INTERVAL = { min: "30s", max: "1h", default: "5m" };
export const DEFAULT_TIMEOUT = "20s";

/** Returns true when tz is an IANA time zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function stringList(value: unknown, pattern: RegExp, path: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a list`);
    return [];
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string" || !pattern.test(item)) {
      errors.push(`${path}[${i}] is not valid: ${JSON.stringify(item)}`);
    } else {
      out.push(item);
    }
  }
  return out;
}

function duration(
  value: unknown,
  path: string,
  errors: string[],
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const ms = parseDuration(value);
  if (ms === undefined) {
    errors.push(`${path} must be a duration such as "30s", "5m" or "2h"`);
    return undefined;
  }
  if (bounds.min !== undefined && ms < bounds.min) errors.push(`${path} must be at least ${bounds.min / 1000}s`);
  if (bounds.max !== undefined && ms > bounds.max) errors.push(`${path} is too long`);
  return ms;
}

function text(value: unknown, path: string, maxChars: number, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} is required`);
    return "";
  }
  if (value.length > maxChars) errors.push(`${path} must be at most ${maxChars} characters`);
  return value;
}

/**
 * Validates a parsed definition and fills in defaults. Unknown top-level keys are
 * rejected so that typos in hand edits or agent output surface early.
 */
export function validateDefinition(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["definition must be a mapping"] };

  for (const key of Object.keys(raw)) {
    if (key === "judge") errors.push("judge (model-evaluated conditions) is not supported yet");
    else if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown key: ${key}`);
  }

  if (raw.version !== undefined && raw.version !== 1) errors.push("version must be 1");

  const id = typeof raw.id === "string" ? raw.id : "";
  if (!ID_PATTERN.test(id)) errors.push("id must use lowercase letters, digits and dashes (at most 64 characters)");

  const name = text(raw.name, "name", LIMITS.nameChars, errors);
  const intent = text(raw.intent, "intent", LIMITS.intentChars, errors);

  // probe
  const probeRaw = isRecord(raw.probe) ? raw.probe : {};
  if (!isRecord(raw.probe)) errors.push("probe is required");
  if (probeRaw.runtime !== undefined && probeRaw.runtime !== "deno") errors.push('probe.runtime must be "deno"');
  const entry = probeRaw.entry === undefined ? "probe.ts" : probeRaw.entry;
  if (typeof entry !== "string" || !ENTRY_PATTERN.test(entry)) {
    errors.push("probe.entry must be a file name ending in .ts, .js or .mjs");
  }
  const access = probeRaw.access ?? "full";
  if (access !== "full" && access !== "sandbox") errors.push('probe.access must be "full" or "sandbox"');
  const params = probeRaw.params ?? {};
  if (!isRecord(params)) {
    errors.push("probe.params must be a mapping");
  } else if (JSON.stringify(params).length > LIMITS.paramsBytes) {
    errors.push("probe.params is too large");
  }
  const permsRaw = isRecord(probeRaw.permissions) ? probeRaw.permissions : {};
  const net = stringList(permsRaw.net, HOST_PATTERN, "probe.permissions.net", errors);
  const env = stringList(permsRaw.env, ENV_PATTERN, "probe.permissions.env", errors);

  const intervalRaw = isRecord(probeRaw.interval) ? probeRaw.interval : {};
  const interval = {
    min: (intervalRaw.min as string | undefined) ?? DEFAULT_INTERVAL.min,
    max: (intervalRaw.max as string | undefined) ?? DEFAULT_INTERVAL.max,
    default: (intervalRaw.default as string | undefined) ?? DEFAULT_INTERVAL.default,
  };
  const bounds = { min: LIMITS.intervalMinMs, max: LIMITS.intervalMaxMs };
  const minMs = duration(interval.min, "probe.interval.min", errors, bounds);
  const maxMs = duration(interval.max, "probe.interval.max", errors, bounds);
  const defaultMs = duration(interval.default, "probe.interval.default", errors, bounds);
  if (minMs !== undefined && maxMs !== undefined && minMs > maxMs) {
    errors.push("probe.interval.min must not exceed probe.interval.max");
  }
  if (defaultMs !== undefined && minMs !== undefined && maxMs !== undefined && (defaultMs < minMs || defaultMs > maxMs)) {
    errors.push("probe.interval.default must lie between min and max");
  }
  const timeout = (probeRaw.timeout as string | undefined) ?? DEFAULT_TIMEOUT;
  duration(timeout, "probe.timeout", errors, { min: 1000, max: LIMITS.timeoutMaxMs });

  // mode and minimum duration
  const mode = raw.mode ?? "state";
  if (mode !== "state" && mode !== "event") errors.push('mode must be "state" or "event"');
  if (raw.for !== undefined) {
    if (mode === "event") errors.push("for only applies to state mode");
    duration(raw.for, "for", errors, { max: LIMITS.forMaxMs });
  }

  // policy
  const policyRaw = isRecord(raw.policy) ? raw.policy : {};
  const policy: TriggerDefinition["policy"] = {
    concurrency: (policyRaw.concurrency as Concurrency | undefined) ?? "coalesce",
  };
  if (!["skip", "queue", "coalesce"].includes(policy.concurrency)) {
    errors.push('policy.concurrency must be "skip", "queue" or "coalesce"');
  }
  if (policyRaw.cooldown !== undefined) {
    duration(policyRaw.cooldown, "policy.cooldown", errors, { max: LIMITS.cooldownMaxMs });
    policy.cooldown = policyRaw.cooldown as string;
  }
  if (policyRaw.max_fires !== undefined) {
    if (!Number.isInteger(policyRaw.max_fires) || (policyRaw.max_fires as number) < 1) {
      errors.push("policy.max_fires must be a positive integer");
    }
    policy.max_fires = policyRaw.max_fires as number;
  }
  if (policyRaw.expires_at !== undefined) {
    const expires = policyRaw.expires_at instanceof Date ? policyRaw.expires_at.toISOString() : policyRaw.expires_at;
    if (!isIsoDate(expires)) errors.push("policy.expires_at must be a date and time");
    policy.expires_at = expires as string;
  }
  if (policyRaw.quiet_hours !== undefined) {
    const qh = policyRaw.quiet_hours;
    if (!isRecord(qh) || typeof qh.from !== "string" || typeof qh.to !== "string" || typeof qh.tz !== "string") {
      errors.push("policy.quiet_hours needs from, to and tz");
    } else {
      if (!CLOCK_PATTERN.test(qh.from) || !CLOCK_PATTERN.test(qh.to)) errors.push('policy.quiet_hours times must look like "23:00"');
      if (!isValidTimeZone(qh.tz)) errors.push(`policy.quiet_hours.tz is not a known time zone: ${qh.tz}`);
      policy.quiet_hours = { from: qh.from, to: qh.to, tz: qh.tz };
    }
  }

  // action
  const actionRaw = isRecord(raw.action) ? raw.action : {};
  const action: TriggerDefinition["action"] = {
    type: (actionRaw.type as ActionType | undefined) ?? "agent",
    sandbox: (actionRaw.sandbox as Sandbox | undefined) ?? "workspace-write",
  };
  if (action.type !== "notify" && action.type !== "agent") errors.push('action.type must be "notify" or "agent"');
  if (!["read-only", "workspace-write", "danger-full-access"].includes(action.sandbox)) {
    errors.push('action.sandbox must be "read-only", "workspace-write" or "danger-full-access"');
  }
  if (action.type === "agent") action.prompt = text(actionRaw.prompt, "action.prompt", LIMITS.promptChars, errors);
  else if (typeof actionRaw.prompt === "string") action.prompt = actionRaw.prompt;

  // target
  const targetRaw = isRecord(raw.target) ? raw.target : {};
  const defaultKind: TargetKind = policy.max_fires === 1 ? "origin" : "dedicated";
  const target: TriggerDefinition["target"] = {
    kind: (targetRaw.kind as TargetKind | undefined) ?? defaultKind,
    thread_id: (targetRaw.thread_id as string | null | undefined) ?? null,
  };
  if (target.kind !== "origin" && target.kind !== "dedicated") errors.push('target.kind must be "origin" or "dedicated"');
  if (targetRaw.cwd !== undefined) {
    if (typeof targetRaw.cwd !== "string" || !targetRaw.cwd.startsWith("/")) errors.push("target.cwd must be an absolute path");
    else target.cwd = targetRaw.cwd;
  }

  // notify
  const notifyRaw = isRecord(raw.notify) ? raw.notify : {};
  const notify: TriggerDefinition["notify"] = { when: (notifyRaw.when as NotifyWhen | undefined) ?? "receipt" };
  if (!["always", "receipt", "never"].includes(notify.when)) errors.push('notify.when must be "always", "receipt" or "never"');
  if (notifyRaw.channels !== undefined && notifyRaw.channels !== null) {
    const list = notifyRaw.channels;
    if (!Array.isArray(list) || list.length === 0 || !list.every((c) => c === "desktop" || c === "email")) {
      errors.push('notify.channels must be a non-empty list of "desktop" and "email"');
    } else {
      notify.channels = [...new Set(list as Channel[])];
    }
  }

  // meta
  const metaRaw = isRecord(raw.meta) ? raw.meta : {};
  const createdAt = metaRaw.created_at instanceof Date ? metaRaw.created_at.toISOString() : metaRaw.created_at;
  const activatedAt = metaRaw.activated_at instanceof Date ? metaRaw.activated_at.toISOString() : metaRaw.activated_at;
  const meta: TriggerDefinition["meta"] = {
    created_at: isIsoDate(createdAt) ? createdAt : new Date().toISOString(),
    origin_thread_id: (metaRaw.origin_thread_id as string | null | undefined) ?? null,
    activated_at: isIsoDate(activatedAt) ? activatedAt : null,
    revision: Number.isInteger(metaRaw.revision) ? (metaRaw.revision as number) : 1,
  };
  if (typeof metaRaw.recipe === "string" && metaRaw.recipe) meta.recipe = metaRaw.recipe;

  if (errors.length > 0) return { ok: false, errors };

  const definition: TriggerDefinition = {
    version: 1,
    id,
    name,
    intent,
    probe: {
      runtime: "deno",
      entry: entry as string,
      access: access as ProbeAccess,
      params: params as Record<string, unknown>,
      permissions: { net, env },
      interval,
      timeout,
    },
    mode: mode as Mode,
    policy,
    action,
    target,
    notify,
    meta,
  };
  if (raw.for !== undefined) definition.for = raw.for as string;
  return { ok: true, definition };
}

export function parseDefinitionYaml(source: string): ValidationResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { ok: false, errors: [`invalid YAML: ${(error as Error).message}`] };
  }
  return validateDefinition(raw);
}

export function definitionToYaml(definition: TriggerDefinition): string {
  return stringifyYaml(definition, { lineWidth: 0 });
}

/** Interval bounds and timeout of a validated definition, in milliseconds. */
export function probeTimings(definition: TriggerDefinition) {
  return {
    minMs: parseDuration(definition.probe.interval.min)!,
    maxMs: parseDuration(definition.probe.interval.max)!,
    defaultMs: parseDuration(definition.probe.interval.default)!,
    timeoutMs: parseDuration(definition.probe.timeout)!,
    forMs: definition.for ? parseDuration(definition.for)! : 0,
    cooldownMs: definition.policy.cooldown ? parseDuration(definition.policy.cooldown)! : 0,
  };
}
