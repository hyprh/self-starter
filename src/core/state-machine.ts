// The engine's firing rules, as pure functions of (definition, runtime state, probe result, now).

import { probeTimings, type TriggerDefinition } from "./definition.js";
import type { ProbeEvent, ProbeOutput } from "./probe-output.js";

export type Lifecycle = "active" | "paused" | "expired" | "exhausted";
export type Phase = "armed" | "pending" | "wait_rearm";
export type Health = "ok" | "degraded";

export const FAILURES_BEFORE_DEGRADED = 3;
export const SEEN_KEYS_MAX = 5000;
export const SEEN_KEYS_TTL_MS = 30 * 86_400_000;
export const HELD_EVENTS_MAX = 100;

export interface LastRun {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  summary?: string;
  fire?: boolean;
  events?: number;
  error?: string;
}

export interface RuntimeState {
  /** Revision of the definition this state belongs to; a new revision resets the state. */
  revision: number;
  lifecycle: Lifecycle;
  pausedReason?: string;
  phase: Phase;
  pendingSince?: string;
  fireCount: number;
  lastFireAt?: string;
  cooldownUntil?: string;
  probeState?: unknown;
  /** Event mode: the first successful run only records the keys it sees. */
  hasBaseline: boolean;
  seenKeys: Record<string, string>;
  heldEvents: ProbeEvent[];
  health: Health;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  last?: LastRun;
  nextRunAt?: string;
}

export interface FireDraft {
  reason: string;
  summary: string;
  data?: unknown;
  events?: ProbeEvent[];
}

export type RunResult =
  | { ok: true; output: ProbeOutput; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export interface Evaluation {
  runtime: RuntimeState;
  fire?: FireDraft;
  health?: "degraded" | "recovered";
}

export function initialRuntime(revision: number): RuntimeState {
  return {
    revision,
    lifecycle: "active",
    phase: "armed",
    fireCount: 0,
    hasBaseline: false,
    seenKeys: {},
    heldEvents: [],
    health: "ok",
    consecutiveFailures: 0,
  };
}

function inCooldown(rt: RuntimeState, now: Date): boolean {
  return rt.cooldownUntil !== undefined && now.getTime() < Date.parse(rt.cooldownUntil);
}

function recordFire(def: TriggerDefinition, rt: RuntimeState, now: Date): void {
  const { cooldownMs } = probeTimings(def);
  rt.fireCount += 1;
  rt.lastFireAt = now.toISOString();
  rt.cooldownUntil = cooldownMs > 0 ? new Date(now.getTime() + cooldownMs).toISOString() : undefined;
  if (def.policy.max_fires !== undefined && rt.fireCount >= def.policy.max_fires) rt.lifecycle = "exhausted";
}

function pruneSeenKeys(seen: Record<string, string>, now: Date): Record<string, string> {
  const cutoff = now.getTime() - SEEN_KEYS_TTL_MS;
  const entries = Object.entries(seen)
    .filter(([, firstSeen]) => Date.parse(firstSeen) >= cutoff)
    .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - SEEN_KEYS_MAX)));
}

function evaluateState(
  def: TriggerDefinition,
  rt: RuntimeState,
  output: Extract<ProbeOutput, { mode: "state" }>,
  now: Date,
): FireDraft | undefined {
  const { forMs } = probeTimings(def);

  if (rt.phase === "wait_rearm") {
    const rearm = output.rearm ?? !output.fire;
    if (!rearm || inCooldown(rt, now)) return undefined;
    rt.phase = "armed";
    // Fall through: a condition that already holds again can fire in this same run.
  }

  if (!output.fire) {
    rt.phase = "armed";
    rt.pendingSince = undefined;
    return undefined;
  }

  if (rt.phase === "armed") {
    rt.phase = "pending";
    rt.pendingSince = now.toISOString();
  }
  const heldMs = now.getTime() - Date.parse(rt.pendingSince ?? now.toISOString());
  if (heldMs < forMs) return undefined;

  const reason = forMs > 0
    ? `the probe reported fire=true for ${Math.round(heldMs / 1000)}s (required: ${def.for})`
    : "the probe reported fire=true";
  rt.phase = "wait_rearm";
  rt.pendingSince = undefined;
  recordFire(def, rt, now);
  const fire: FireDraft = { reason, summary: output.summary };
  if (output.data !== undefined) fire.data = output.data;
  return fire;
}

function evaluateEvents(
  def: TriggerDefinition,
  rt: RuntimeState,
  output: Extract<ProbeOutput, { mode: "event" }>,
  now: Date,
): FireDraft | undefined {
  const seenAt = now.toISOString();
  const fresh = output.events.filter((event) => rt.seenKeys[event.key] === undefined);
  for (const event of fresh) rt.seenKeys[event.key] = seenAt;
  rt.seenKeys = pruneSeenKeys(rt.seenKeys, now);

  if (!rt.hasBaseline) {
    // Events that existed before the trigger was created do not fire it.
    rt.hasBaseline = true;
    return undefined;
  }

  const pool = [...rt.heldEvents, ...fresh];
  if (pool.length === 0) return undefined;
  if (inCooldown(rt, now)) {
    rt.heldEvents = pool.slice(-HELD_EVENTS_MAX);
    return undefined;
  }
  rt.heldEvents = [];
  recordFire(def, rt, now);
  const fire: FireDraft = {
    reason: pool.length === 1 ? "1 new event" : `${pool.length} new events`,
    summary: output.summary,
    events: pool,
  };
  if (output.data !== undefined) fire.data = output.data;
  return fire;
}

/** Applies one probe run to the runtime state. The input state is not modified. */
export function evaluate(def: TriggerDefinition, current: RuntimeState, result: RunResult, now: Date): Evaluation {
  const rt: RuntimeState = structuredClone(current);
  const ranAt = now.toISOString();

  if (!result.ok) {
    rt.consecutiveFailures += 1;
    rt.last = { ok: false, ranAt, durationMs: result.durationMs, error: result.error };
    if (rt.health === "ok" && rt.consecutiveFailures >= FAILURES_BEFORE_DEGRADED) {
      rt.health = "degraded";
      return { runtime: rt, health: "degraded" };
    }
    return { runtime: rt };
  }

  const { output } = result;
  let health: Evaluation["health"];
  rt.consecutiveFailures = 0;
  rt.lastSuccessAt = ranAt;
  if (rt.health === "degraded") {
    rt.health = "ok";
    health = "recovered";
  }
  if (output.state !== undefined) rt.probeState = output.state;
  rt.last = { ok: true, ranAt, durationMs: result.durationMs, summary: output.summary };
  if (output.mode === "state") rt.last.fire = output.fire;
  else rt.last.events = output.events.length;

  if (rt.lifecycle !== "active") return { runtime: rt, health };

  const fire = output.mode === "state" ? evaluateState(def, rt, output, now) : evaluateEvents(def, rt, output, now);
  const evaluation: Evaluation = { runtime: rt };
  if (fire) evaluation.fire = fire;
  if (health) evaluation.health = health;
  return evaluation;
}

/** How long to wait before the next probe run. */
export function nextRunDelayMs(def: TriggerDefinition, rt: RuntimeState, result: RunResult, now: Date): number {
  const { minMs, maxMs, defaultMs, forMs } = probeTimings(def);
  const clamp = (ms: number) => Math.min(maxMs, Math.max(minMs, ms));
  if (!result.ok) {
    const backoff = defaultMs * 2 ** Math.max(0, rt.consecutiveFailures - 1);
    return clamp(backoff);
  }
  let delay = clamp(result.output.nextCheckInMs ?? defaultMs);
  // While a condition is waiting out `for`, check again when it would be satisfied.
  if (rt.phase === "pending" && rt.pendingSince && forMs > 0) {
    const remaining = Date.parse(rt.pendingSince) + forMs - now.getTime();
    delay = Math.min(delay, Math.max(minMs, remaining));
  }
  return delay;
}
