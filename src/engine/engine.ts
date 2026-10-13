// The watcher: runs each trigger's probe on schedule, applies the firing rules,
// and hands fires to the executor.
//
// Definitions and probe code are read from disk before every run, so hand edits
// take effect at the next check.

import { existsSync, renameSync, statSync } from "node:fs";
import { probeTimings, type TriggerDefinition } from "../core/definition.js";
import {
  evaluate,
  FAILURES_BEFORE_DEGRADED,
  initialRuntime,
  nextRunDelayMs,
  type RuntimeState,
} from "../core/state-machine.js";
import type { Config } from "./config.js";
import type { Executor } from "./executor.js";
import { appendJsonLine, readJsonLines } from "./fs-util.js";
import type { Paths } from "./paths.js";
import { runProbe, type ProbeInput, type ProbeRunResult } from "./probe-runner.js";
import type { Secrets } from "./secrets.js";
import type { Store } from "./store.js";

export const USER_PAUSE = "paused by the user";

const RUNS_LOG_MAX_BYTES = 5 * 1024 * 1024;
const RECENT_RUNS = 20;
const TICK_MIN_MS = 250;
const TICK_MAX_MS = 30_000;
const EXECUTOR_TICK_MS = 15_000;
const INVALID_RETRY_MS = 5 * 60_000;

export interface RunRecord {
  triggerId: string;
  revision: number;
  ranAt: string;
  durationMs: number;
  ok: boolean;
  summary?: string;
  fire?: boolean;
  events?: number;
  fireId?: string;
  error?: string;
  stderr?: string;
}

export interface EngineDeps {
  store: Store;
  executor: Executor;
  secrets: Secrets;
  paths: Paths;
  config: Config;
  /** Returns undefined when no deno binary is available. */
  deno: () => string | undefined;
  log: (line: string) => void;
  now?: () => Date;
}

/** The JSON a probe reads on stdin. */
export function probeInput(definition: TriggerDefinition, runtime: RuntimeState | undefined, now: Date): ProbeInput {
  const last = runtime?.last?.ok ? runtime.last : undefined;
  return {
    version: 1,
    trigger_id: definition.id,
    now: now.toISOString(),
    params: definition.probe.params,
    state: runtime?.probeState ?? null,
    last: last ? { fire: last.fire, summary: last.summary, ran_at: last.ranAt } : null,
  };
}

function failure(error: string): ProbeRunResult {
  return { ok: false, error, durationMs: 0, stderr: "" };
}

export class Engine {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly running = new Set<string>();
  private readonly recent = new Map<string, RunRecord[]>();
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private lastExecutorTick = 0;
  private appendsSinceSizeCheck = 0;

  constructor(private readonly deps: EngineDeps) {
    for (const record of readJsonLines<RunRecord>(deps.paths.runs)) this.remember(record);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    this.deps.log(line);
  }

  start(): void {
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick().catch((error: Error) => this.log(`tick failed: ${error.stack ?? error.message}`));
    }, Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, delayMs)));
  }

  /** Starts the runs that are due, and returns when the next one is due. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    const ids = this.deps.store.listTriggerIds();
    for (const id of [...this.runtimes.keys()]) if (!ids.includes(id)) this.runtimes.delete(id);

    let nextDue = now + TICK_MAX_MS;
    const due: Array<{ id: string; at: number }> = [];
    for (const id of ids) {
      const runtime = this.runtime(id);
      if (runtime.lifecycle !== "active" || this.running.has(id)) continue;
      const at = runtime.nextRunAt ? Date.parse(runtime.nextRunAt) : 0;
      if (at <= now) due.push({ id, at });
      else nextDue = Math.min(nextDue, at);
    }
    due.sort((a, b) => a.at - b.at);
    for (const { id } of due) {
      if (this.running.size >= this.deps.config.maxConcurrentProbes) break;
      void this.runNow(id);
    }

    if (now - this.lastExecutorTick >= EXECUTOR_TICK_MS) {
      this.lastExecutorTick = now;
      await this.deps.executor.tick().catch((error: Error) => this.log(`executor tick failed: ${error.message}`));
    }
    this.schedule(nextDue - this.now().getTime());
  }

  /** The runtime state of a trigger, loaded from disk on first use. */
  runtime(id: string): RuntimeState {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = this.deps.store.loadRuntime(id);
      if (!runtime) {
        // Revision 0 never matches a definition, so the first run starts from a clean state.
        runtime = initialRuntime(0);
        runtime.nextRunAt = this.now().toISOString();
      }
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private save(id: string, runtime: RuntimeState): void {
    this.runtimes.set(id, runtime);
    this.deps.store.saveRuntime(id, runtime);
  }

  /** Starts over when the definition has a new revision, keeping a pause. */
  private syncRevision(id: string, definition: TriggerDefinition): RuntimeState {
    const current = this.runtime(id);
    if (current.revision === definition.meta.revision) return current;
    const fresh = initialRuntime(definition.meta.revision);
    if (current.lifecycle === "paused") {
      fresh.lifecycle = "paused";
      fresh.pausedReason = USER_PAUSE;
    }
    fresh.nextRunAt = this.now().toISOString();
    this.save(id, fresh);
    return fresh;
  }

  /** Picks up a definition that was activated, changed or deleted. */
  reload(id: string): void {
    if (!this.deps.store.hasTrigger(id)) {
      this.runtimes.delete(id);
      this.recent.delete(id);
    } else {
      try {
        this.syncRevision(id, this.deps.store.loadTrigger(id).definition);
      } catch (error) {
        this.log(`could not load ${id}: ${(error as Error).message}`);
      }
    }
    this.schedule(0);
  }

  /**
   * Takes a revision that only makes the trigger quieter (trigger_tune) without
   * starting over, so that it keeps its baseline and does not fire again for a
   * condition that already held. A longer cooldown counts from the last fire, a
   * lower max_fires can end the trigger now, and the next check moves out to
   * the new interval.
   */
  retune(id: string, definition: TriggerDefinition): RuntimeState {
    const runtime: RuntimeState = { ...this.runtime(id), revision: definition.meta.revision };
    const { cooldownMs, defaultMs } = probeTimings(definition);
    const later = (current: string | undefined, candidate: number) =>
      current === undefined || candidate > Date.parse(current) ? new Date(candidate).toISOString() : current;
    if (cooldownMs > 0 && runtime.lastFireAt) runtime.cooldownUntil = later(runtime.cooldownUntil, Date.parse(runtime.lastFireAt) + cooldownMs);
    if (runtime.last) runtime.nextRunAt = later(runtime.nextRunAt, Date.parse(runtime.last.ranAt) + defaultMs);
    const maxFires = definition.policy.max_fires;
    if (maxFires !== undefined && runtime.fireCount >= maxFires && runtime.lifecycle === "active") {
      runtime.lifecycle = "exhausted";
      delete runtime.nextRunAt;
    }
    this.save(id, runtime);
    this.schedule(0);
    return runtime;
  }

  pause(id: string): RuntimeState {
    const runtime = { ...this.runtime(id), lifecycle: "paused" as const, pausedReason: USER_PAUSE };
    this.save(id, runtime);
    return runtime;
  }

  resume(id: string): RuntimeState {
    const current = this.runtime(id);
    if (current.lifecycle === "active") return current;
    if (current.lifecycle === "expired") throw new Error(`${id} has expired; change policy.expires_at with trigger_update to use it again`);
    if (current.lifecycle === "exhausted") throw new Error(`${id} reached policy.max_fires; raise it with trigger_update to use it again`);
    const runtime: RuntimeState = { ...current, lifecycle: "active", nextRunAt: this.now().toISOString() };
    delete runtime.pausedReason;
    this.save(id, runtime);
    this.schedule(0);
    return runtime;
  }

  recentRuns(id: string): RunRecord[] {
    return [...(this.recent.get(id) ?? [])];
  }

  private remember(record: RunRecord): void {
    const list = this.recent.get(record.triggerId) ?? [];
    list.push(record);
    if (list.length > RECENT_RUNS) list.splice(0, list.length - RECENT_RUNS);
    this.recent.set(record.triggerId, list);
  }

  private appendRun(record: RunRecord): void {
    this.remember(record);
    appendJsonLine(this.deps.paths.runs, record);
    this.appendsSinceSizeCheck += 1;
    if (this.appendsSinceSizeCheck < 100) return;
    this.appendsSinceSizeCheck = 0;
    if (existsSync(this.deps.paths.runs) && statSync(this.deps.paths.runs).size > RUNS_LOG_MAX_BYTES) {
      renameSync(this.deps.paths.runs, `${this.deps.paths.runs}.1`);
    }
  }

  /** Runs a trigger's probe now and applies the result. Returns undefined when it did not run. */
  async runNow(id: string): Promise<RunRecord | undefined> {
    if (this.running.has(id)) return undefined;
    this.running.add(id);
    try {
      return await this.runOnce(id);
    } catch (error) {
      this.log(`run of ${id} crashed: ${(error as Error).stack ?? error}`);
      return undefined;
    } finally {
      this.running.delete(id);
      this.schedule(0);
    }
  }

  private async runOnce(id: string): Promise<RunRecord | undefined> {
    let loaded;
    try {
      loaded = this.deps.store.loadTrigger(id);
    } catch (error) {
      return this.recordInvalid(id, (error as Error).message);
    }
    const { definition, dir } = loaded;
    const runtime = this.syncRevision(id, definition);
    if (runtime.lifecycle !== "active") return undefined;

    const startedAt = this.now();
    if (definition.policy.expires_at && Date.parse(definition.policy.expires_at) <= startedAt.getTime()) {
      const expired: RuntimeState = { ...runtime, lifecycle: "expired" };
      delete expired.nextRunAt;
      this.save(id, expired);
      this.log(`${id} expired`);
      return undefined;
    }

    const result = await this.execute(definition, dir, runtime);

    // The trigger may have been paused, changed or deleted while the probe ran.
    const current = this.runtimes.get(id);
    if (!current || !this.deps.store.hasTrigger(id) || current.revision !== definition.meta.revision) return undefined;

    const now = this.now();
    const evaluation = evaluate(definition, current, result, now);
    const next = evaluation.runtime;
    next.nextRunAt = new Date(now.getTime() + nextRunDelayMs(definition, next, result, now)).toISOString();

    const record: RunRecord = { triggerId: id, revision: definition.meta.revision, ranAt: now.toISOString(), durationMs: result.durationMs, ok: result.ok };
    if (result.ok) {
      record.summary = result.output.summary;
      if (result.output.mode === "state") record.fire = result.output.fire;
      else record.events = result.output.events.length;
    } else {
      record.error = result.error;
    }
    if (result.stderr) record.stderr = result.stderr.slice(0, 2000);

    // Record first, then act: the fire is logged before the new state is saved.
    if (evaluation.fire) record.fireId = this.deps.executor.submit(definition, evaluation.fire, next.fireCount).fireId;
    this.save(id, next);
    this.appendRun(record);

    if (evaluation.health === "degraded") {
      await this.deps.executor.notifyAbout(definition, {
        title: `${definition.name}: the probe keeps failing`,
        body: `${record.error ?? "unknown error"} (checks continue; see: self-starter show ${id})`,
      });
    } else if (evaluation.health === "recovered") {
      await this.deps.executor.notifyAbout(definition, {
        title: `${definition.name}: working again`,
        body: record.summary ?? "The probe succeeded.",
      });
    }
    if (next.lifecycle === "exhausted" && current.lifecycle !== "exhausted") this.log(`${id} reached max_fires`);
    return record;
  }

  /** Runs the probe with the trigger's current state, without applying the result. */
  async test(id: string): Promise<ProbeRunResult> {
    const { definition, dir } = this.deps.store.loadTrigger(id);
    return this.execute(definition, dir, this.runtime(id));
  }

  /** Runs a probe that is not active yet (a draft), from an empty state. */
  dryRun(definition: TriggerDefinition, dir: string): Promise<ProbeRunResult> {
    return this.execute(definition, dir, undefined);
  }

  private async execute(definition: TriggerDefinition, dir: string, runtime: RuntimeState | undefined): Promise<ProbeRunResult> {
    const denoBin = this.deps.deno();
    if (!denoBin) return failure("deno was not found; run `self-starter doctor`");
    const { access, permissions } = definition.probe;
    const { values, problems } = this.deps.secrets.pick(permissions.env, access === "full" ? "any" : permissions.net);
    if (problems.length > 0) return failure(problems.join("; "));
    const cwd = definition.target.cwd;
    return runProbe({
      denoBin,
      denoDir: this.deps.paths.denoDir,
      dir,
      ...(cwd && existsSync(cwd) ? { cwd } : {}),
      definition,
      input: probeInput(definition, runtime, this.now()),
      env: values,
    });
  }

  /** A trigger.yaml that no longer loads counts as a failed run, so the user hears about it. */
  private async recordInvalid(id: string, message: string): Promise<RunRecord> {
    const now = this.now();
    const runtime: RuntimeState = structuredClone(this.runtime(id));
    runtime.consecutiveFailures += 1;
    runtime.last = { ok: false, ranAt: now.toISOString(), durationMs: 0, error: message };
    runtime.nextRunAt = new Date(now.getTime() + INVALID_RETRY_MS).toISOString();
    const degraded = runtime.health === "ok" && runtime.consecutiveFailures >= FAILURES_BEFORE_DEGRADED;
    if (degraded) runtime.health = "degraded";
    this.save(id, runtime);
    const record: RunRecord = { triggerId: id, revision: runtime.revision, ranAt: now.toISOString(), durationMs: 0, ok: false, error: message };
    this.appendRun(record);
    if (degraded) {
      await this.deps.executor.notifyAbout(undefined, { title: `${id}: cannot load the trigger`, body: message });
    }
    return record;
  }
}
