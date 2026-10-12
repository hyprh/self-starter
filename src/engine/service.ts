// The operations behind the control API: drafts and approval, changes, queries
// and receipts. Requests come from the plugin's MCP server on behalf of a Codex
// thread, or from ctrig in a terminal.

import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { approvalText, describeState } from "../core/describe.js";
import { definitionToYaml, validateDefinition, type TriggerDefinition } from "../core/definition.js";
import { deepMerge, describeChanges, patchPaths } from "../core/patch.js";
import type { ProbeRunResult } from "./probe-runner.js";
import type { Config } from "./config.js";
import type { Engine, RunRecord } from "./engine.js";
import type { Executor } from "./executor.js";
import type { FireLog, FireRecord } from "./fires.js";
import type { Paths } from "./paths.js";
import { approvalProblem, fingerprint, type DryRun, type LoadedDraft, type LoadedTrigger, type Store } from "./store.js";

export type ErrorCode = "not_found" | "invalid" | "refused" | "conflict";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Who is asking. For requests from Codex, the ids come from the MCP call's _meta, which the model cannot set. */
export interface Caller {
  via: "mcp" | "cli";
  threadId?: string;
  turnId?: string;
  /** "queue" for turns started by a queued message, such as a trigger fire. */
  turnTrigger?: string;
}

const MAX_CODE_BYTES = 64 * 1024;
const MAX_TRIGGERS = 100;
const DRAFT_TTL_MS = 24 * 3_600_000;
const RECENT_FIRE_MS = 24 * 3_600_000;
const REPORTED_TURNS_MAX = 1000;
/** What trigger_update may not change: those changes get the full review of trigger_draft. */
const LOCKED_PATHS = ["version", "id", "meta", "mode", "probe.runtime", "probe.entry", "probe.sha256", "probe.permissions", "target.thread_id"];
/** Bookkeeping that is not part of what the user approves. */
const BOOKKEEPING = ["meta", "probe.sha256", "target.thread_id"];

export interface ServiceDeps {
  store: Store;
  fires: FireLog;
  engine: Engine;
  executor: Executor;
  paths: Paths;
  config: Config;
  version: string;
  deno: () => string | undefined;
  codex: () => string | undefined;
  log: (line: string) => void;
  now?: () => Date;
}

export interface DraftView {
  draftId: string;
  triggerId: string;
  replaces: string | null;
  codePath: string;
  definitionYaml: string;
  trial: DryRun | null;
  warnings: string[];
  changes: string[] | null;
  approvalText: string;
}

export interface TriggerSummary {
  id: string;
  name: string;
  state: string;
  lifecycle: string;
  health: string;
  action: string;
  target: string;
  threadId: string | null;
  fires: number;
  lastCheck: { at: string; ok: boolean; summary?: string; error?: string } | null;
  nextCheck: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function toTrial(result: ProbeRunResult): DryRun {
  const trial: DryRun = { ok: result.ok, durationMs: result.durationMs };
  if (result.ok) {
    trial.summary = result.output.summary;
    if (result.output.mode === "state") trial.fire = result.output.fire;
    else trial.events = result.output.events.length;
    if (result.output.nextCheckInMs !== undefined) trial.nextCheckIn = `${Math.round(result.output.nextCheckInMs / 1000)}s`;
  } else {
    trial.error = result.error;
  }
  if (result.stderr) trial.stderr = result.stderr.slice(0, 2000);
  return trial;
}

export function fireView(fire: FireRecord) {
  return {
    fireId: fire.fireId,
    triggerId: fire.triggerId,
    fireNumber: fire.fireNumber,
    firedAt: fire.createdAt,
    reason: fire.reason,
    summary: fire.summary,
    events: fire.events?.length ?? 0,
    status: fire.status,
    target: fire.target ?? null,
    deliveredAt: fire.deliveredAt ?? null,
    receipt: fire.receipt ?? null,
    error: fire.error ?? null,
    skippedBecause: fire.skippedBecause ?? null,
    mergedInto: fire.mergedInto ?? null,
    merged: fire.merged.length,
  };
}

export class TriggerService {
  private readonly reportedTurns = new Set<string>();
  readonly startedAt = new Date().toISOString();

  constructor(private readonly deps: ServiceDeps) {
    this.cleanupDrafts();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ---- guard -------------------------------------------------------------

  /**
   * A turn that handles a trigger fire must not create, change or delete
   * triggers, so that fire data can never make triggers multiply or change
   * themselves. Requests from the terminal are the user's own.
   */
  private guard(caller: Caller, action: string): void {
    if (caller.via !== "mcp") return;
    const refuse = (why: string): never => {
      throw new ServiceError("refused", `Cannot ${action} now: ${why} Triggers cannot be created, changed or deleted while a trigger fire is being handled; the user can ask again in a new message.`);
    };
    if (caller.threadId && this.deps.fires.threadBusy(caller.threadId)) {
      refuse("this thread is handling a trigger fire that has not been reported yet.");
    }
    if (caller.turnId && this.reportedTurns.has(caller.turnId)) refuse("this turn handled a trigger fire.");
    if (caller.turnTrigger === "queue" && caller.threadId && this.recentFireIn(caller.threadId)) {
      refuse("this turn was started by a queued message, and this thread recently received a trigger fire.");
    }
  }

  private recentFireIn(threadId: string): boolean {
    const cutoff = this.now().getTime() - RECENT_FIRE_MS;
    return this.deps.fires
      .all()
      .some((fire) => fire.target?.threadId === threadId && fire.deliveredAt !== undefined && Date.parse(fire.deliveredAt) >= cutoff);
  }

  // ---- loading -----------------------------------------------------------

  private requireTrigger(id: unknown): string {
    if (typeof id !== "string" || !this.deps.store.hasTrigger(id)) {
      throw new ServiceError("not_found", `no trigger with id ${JSON.stringify(id)}; trigger_list shows the existing ones`);
    }
    return id;
  }

  private load(id: unknown): LoadedTrigger {
    const triggerId = this.requireTrigger(id);
    try {
      return this.deps.store.loadTrigger(triggerId);
    } catch (error) {
      throw new ServiceError("invalid", `${triggerId} cannot be loaded: ${(error as Error).message}`);
    }
  }

  private tryLoad(id: string): LoadedTrigger | undefined {
    try {
      return this.deps.store.hasTrigger(id) ? this.deps.store.loadTrigger(id) : undefined;
    } catch {
      return undefined;
    }
  }

  private loadDraft(draftId: unknown): LoadedDraft {
    if (typeof draftId !== "string") throw new ServiceError("invalid", "draftId is required");
    try {
      return this.deps.store.loadDraft(draftId);
    } catch (error) {
      throw new ServiceError("not_found", `${(error as Error).message}; drafts expire after 24 hours, submit it again with trigger_draft`);
    }
  }

  private cleanupDrafts(): void {
    const cutoff = this.now().getTime() - DRAFT_TTL_MS;
    for (const meta of this.deps.store.listDrafts()) {
      if (Date.parse(meta.createdAt) < cutoff) this.deps.store.deleteDraft(meta.draftId);
    }
  }

  // ---- drafts and approval ----------------------------------------------

  /** Validates a new trigger (or a new version of one), stores it as a draft, and runs its probe once. */
  async createDraft(params: { definition?: unknown; code?: unknown; replace?: unknown }, caller: Caller): Promise<DraftView> {
    this.guard(caller, "create a trigger");
    let raw = params.definition;
    if (typeof raw === "string") {
      try {
        raw = parseYaml(raw);
      } catch (error) {
        throw new ServiceError("invalid", `definition is not valid YAML: ${(error as Error).message}`);
      }
    }
    if (!isRecord(raw)) throw new ServiceError("invalid", "definition must be a mapping (an object or YAML text)");
    const code = params.code;
    if (typeof code !== "string" || code.trim() === "") throw new ServiceError("invalid", "code is required: the probe's TypeScript source");
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) throw new ServiceError("invalid", "the probe code is larger than 64 KB");

    // The engine owns the approval fields, the thread ids and the revision.
    const cleaned: Record<string, unknown> = { ...raw };
    delete cleaned.meta;
    if (isRecord(cleaned.probe)) cleaned.probe = { ...cleaned.probe, sha256: null };
    if (isRecord(cleaned.target)) cleaned.target = { ...cleaned.target, thread_id: null };
    const validated = validateDefinition(cleaned);
    if (!validated.ok) throw new ServiceError("invalid", `the definition has problems:\n- ${validated.errors.join("\n- ")}`);
    const definition = validated.definition;

    const exists = this.deps.store.hasTrigger(definition.id);
    if (exists && params.replace !== true) {
      throw new ServiceError("conflict", `a trigger with id "${definition.id}" already exists; choose another id, or pass replace=true to replace it`);
    }
    if (!exists && this.deps.store.listTriggerIds().length >= MAX_TRIGGERS) {
      throw new ServiceError("refused", `there are already ${MAX_TRIGGERS} triggers; delete some first`);
    }
    const existing = exists ? this.tryLoad(definition.id) : undefined;
    definition.meta = {
      created_at: existing?.definition.meta.created_at ?? this.now().toISOString(),
      origin_thread_id: caller.threadId ?? existing?.definition.meta.origin_thread_id ?? null,
      approved_at: null,
      revision: (existing?.definition.meta.revision ?? 0) + 1,
    };

    this.cleanupDrafts();
    const meta: Parameters<Store["createDraft"]>[2] = { originThreadId: definition.meta.origin_thread_id ?? null };
    if (exists) meta.replaces = definition.id;
    const draft = this.deps.store.createDraft(definition, code, meta);
    draft.meta.dryRun = toTrial(await this.deps.engine.dryRun(definition, draft.dir));
    this.deps.store.saveDraftMeta(draft.meta);
    this.deps.log(`draft ${draft.meta.draftId} created (${caller.via}${caller.threadId ? `, thread ${caller.threadId}` : ""})`);
    return this.draftView(this.deps.store.loadDraft(draft.meta.draftId));
  }

  private warnings(draft: LoadedDraft): string[] {
    const def = draft.definition;
    const trial = draft.meta.dryRun;
    const out: string[] = [];
    if (trial && !trial.ok) {
      out.push(`The trial run failed: ${trial.error}. Fix the probe and submit it again with trigger_draft${draft.meta.replaces ? " (replace=true)" : ""}.`);
    } else if (trial?.ok && def.mode === "state" && trial.fire) {
      out.push("The condition holds right now, so the trigger will fire as soon as it is active. Make sure the user expects that.");
    } else if (trial?.ok && def.mode === "event" && (trial.events ?? 0) > 0) {
      out.push(`The trial run saw ${trial.events} event(s). They count as already seen; only events that appear later fire the trigger.`);
    }
    if (def.action.type === "agent" && def.target.kind === "origin" && !draft.meta.originThreadId) {
      out.push("This request did not identify a Codex thread, so fires will go to a dedicated thread instead.");
    }
    if (def.action.type === "agent" && def.target.kind === "dedicated" && !def.target.cwd) {
      out.push("target.cwd is not set, so the dedicated thread will work in the user's home folder.");
    }
    return out;
  }

  private draftView(draft: LoadedDraft): DraftView {
    const def = draft.definition;
    const existing = draft.meta.replaces ? this.tryLoad(draft.meta.replaces) : undefined;
    const codeChanged = !existing || fingerprint(existing.definition, existing.probeCode) !== fingerprint(def, draft.probeCode);
    let changes: string[] | null = null;
    if (existing) {
      changes = describeChanges(existing.definition, def, BOOKKEEPING);
      if (existing.probeCode !== draft.probeCode) changes.unshift("probe code: new version");
    }
    const trial = draft.meta.dryRun ?? null;
    const codePath = join(draft.dir, def.probe.entry);
    const text = approvalText({ definition: def, codePath: tilde(codePath), codeChanged, ...(trial ? { trial } : {}), ...(changes ? { changes } : {}) });
    return {
      draftId: draft.meta.draftId,
      triggerId: def.id,
      replaces: draft.meta.replaces ?? null,
      codePath,
      definitionYaml: definitionToYaml(def),
      trial,
      warnings: this.warnings(draft),
      changes,
      approvalText: text,
    };
  }

  getDraft(params: { draftId?: unknown }): DraftView {
    return this.draftView(this.loadDraft(params.draftId));
  }

  listDrafts() {
    this.cleanupDrafts();
    return this.deps.store.listDrafts().map((meta) => ({
      draftId: meta.draftId,
      createdAt: meta.createdAt,
      replaces: meta.replaces ?? null,
      trialOk: meta.dryRun?.ok ?? null,
    }));
  }

  discardDraft(params: { draftId?: unknown }): { discarded: string } {
    const draft = this.loadDraft(params.draftId);
    this.deps.store.deleteDraft(draft.meta.draftId);
    return { discarded: draft.meta.draftId };
  }

  /** Makes an approved draft live. The approval itself is asked for by the caller (MCP dialog or terminal prompt). */
  activateDraft(params: { draftId?: unknown }, caller: Caller) {
    this.guard(caller, "activate a trigger");
    const draft = this.loadDraft(params.draftId);
    const def: TriggerDefinition = structuredClone(draft.definition);
    const exists = this.deps.store.hasTrigger(def.id);
    if (exists && !draft.meta.replaces) {
      throw new ServiceError("conflict", `a trigger with id "${def.id}" was created after this draft; submit the draft again with replace=true`);
    }
    const existing = exists ? this.tryLoad(def.id) : undefined;
    def.meta.revision = (existing?.definition.meta.revision ?? 0) + 1;
    def.meta.approved_at = this.now().toISOString();
    def.probe.sha256 = fingerprint(def, draft.probeCode);
    const previous = existing?.definition.target;
    if (def.target.kind === "dedicated" && previous?.kind === "dedicated" && previous.thread_id) def.target.thread_id = previous.thread_id;

    this.deps.store.promoteDraft(draft.meta.draftId, def);
    this.deps.engine.reload(def.id);
    if (def.action.type === "agent" && def.target.kind === "dedicated" && !def.target.thread_id) {
      this.deps.executor.prepareDedicatedThread(def.id);
    }
    this.deps.log(`activated ${def.id} revision ${def.meta.revision} (approved via ${caller.via})`);
    return this.get({ triggerId: def.id });
  }

  /** For `ctrig approve <id>`: what changed since the user approved this trigger. */
  approvalView(params: { triggerId?: unknown }): { triggerId: string; problem: string | null; approvalText: string } {
    const { definition, probeCode, dir } = this.load(params.triggerId);
    const problem = approvalProblem(definition, probeCode) ?? null;
    const text = approvalText({ definition, codePath: tilde(join(dir, definition.probe.entry)), codeChanged: problem !== null });
    return { triggerId: definition.id, problem, approvalText: text };
  }

  /** Approves the code and permissions now on disk, after the user reviewed them in a terminal. */
  approveTrigger(params: { triggerId?: unknown }, caller: Caller) {
    if (caller.via !== "cli") throw new ServiceError("refused", "only the user can approve this, by running `ctrig approve` in a terminal");
    const { definition, probeCode } = this.load(params.triggerId);
    definition.probe.sha256 = fingerprint(definition, probeCode);
    definition.meta.approved_at = this.now().toISOString();
    definition.meta.revision += 1;
    this.deps.store.saveDefinition(definition);
    this.deps.engine.reload(definition.id);
    this.deps.log(`re-approved ${definition.id} revision ${definition.meta.revision}`);
    return this.get({ triggerId: definition.id });
  }

  // ---- changes -----------------------------------------------------------

  /** Prepares a change to parameters, policy, action or notifications as a draft that needs approval. */
  updateTrigger(params: { triggerId?: unknown; changes?: unknown }, caller: Caller): DraftView {
    this.guard(caller, "change a trigger");
    const changes = params.changes;
    if (!isRecord(changes) || Object.keys(changes).length === 0) throw new ServiceError("invalid", "changes must be a non-empty mapping");
    const locked = patchPaths(changes).filter((path) => LOCKED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
    if (locked.length > 0) {
      throw new ServiceError(
        "invalid",
        `trigger_update cannot change ${locked.join(", ")}. To change the probe code, its permissions or the mode, submit a new version with trigger_draft (replace=true).`,
      );
    }
    const existing = this.load(params.triggerId);
    const merged = deepMerge(JSON.parse(JSON.stringify(existing.definition)) as Record<string, unknown>, changes);
    const validated = validateDefinition(merged);
    if (!validated.ok) throw new ServiceError("invalid", `the changed definition has problems:\n- ${validated.errors.join("\n- ")}`);
    const def = validated.definition;
    if (describeChanges(existing.definition, def, BOOKKEEPING).length === 0) throw new ServiceError("invalid", "these changes do not change anything");
    def.meta = { ...existing.definition.meta, approved_at: null, revision: existing.definition.meta.revision + 1 };
    def.probe.sha256 = null;
    def.target.thread_id = null;
    this.cleanupDrafts();
    const draft = this.deps.store.createDraft(def, existing.probeCode, {
      originThreadId: def.meta.origin_thread_id ?? null,
      replaces: def.id,
    });
    return this.draftView(draft);
  }

  pause(params: { triggerId?: unknown }, caller: Caller) {
    this.guard(caller, "pause a trigger");
    const id = this.requireTrigger(params.triggerId);
    this.deps.engine.pause(id);
    this.deps.log(`paused ${id} (${caller.via})`);
    return this.summary(id);
  }

  resume(params: { triggerId?: unknown }, caller: Caller) {
    this.guard(caller, "resume a trigger");
    const id = this.requireTrigger(params.triggerId);
    try {
      this.deps.engine.resume(id);
    } catch (error) {
      throw new ServiceError("refused", (error as Error).message);
    }
    this.deps.log(`resumed ${id} (${caller.via})`);
    return this.summary(id);
  }

  delete(params: { triggerId?: unknown }, caller: Caller) {
    this.guard(caller, "delete a trigger");
    const id = this.requireTrigger(params.triggerId);
    const loaded = this.tryLoad(id);
    this.deps.store.deleteTrigger(id);
    this.deps.engine.reload(id);
    this.deps.executor.closeFiresOf(id);
    this.deps.log(`deleted ${id} (${caller.via})`);
    return { deleted: id, dedicatedThreadId: loaded?.definition.target.thread_id ?? null };
  }

  // ---- queries -----------------------------------------------------------

  private summary(id: string): TriggerSummary {
    const loaded = this.tryLoad(id);
    const runtime = this.deps.engine.runtime(id);
    const def = loaded?.definition;
    const threadId = def ? (def.target.kind === "origin" ? def.meta.origin_thread_id : def.target.thread_id) ?? null : null;
    const last = runtime.last;
    return {
      id,
      name: def?.name ?? id,
      state: def ? describeState(runtime, this.now()) : "cannot be loaded: trigger.yaml is invalid",
      lifecycle: runtime.lifecycle,
      health: runtime.health,
      action: def?.action.type ?? "unknown",
      target: def?.target.kind ?? "unknown",
      threadId,
      fires: runtime.fireCount,
      lastCheck: last ? { at: last.ranAt, ok: last.ok, ...(last.summary ? { summary: last.summary } : {}), ...(last.error ? { error: last.error } : {}) } : null,
      nextCheck: runtime.lifecycle === "active" ? runtime.nextRunAt ?? null : null,
    };
  }

  list(): TriggerSummary[] {
    return this.deps.store.listTriggerIds().map((id) => this.summary(id));
  }

  get(params: { triggerId?: unknown }) {
    const { definition, probeCode, dir } = this.load(params.triggerId);
    const runtime = this.deps.engine.runtime(definition.id);
    return {
      ...this.summary(definition.id),
      approval: approvalProblem(definition, probeCode) ?? "approved",
      definitionYaml: definitionToYaml(definition),
      probePath: join(dir, definition.probe.entry),
      runtime: {
        phase: runtime.phase,
        pendingSince: runtime.pendingSince ?? null,
        cooldownUntil: runtime.cooldownUntil ?? null,
        lastFireAt: runtime.lastFireAt ?? null,
        consecutiveFailures: runtime.consecutiveFailures,
        lastSuccessAt: runtime.lastSuccessAt ?? null,
        heldEvents: runtime.heldEvents.length,
        probeState: runtime.probeState ?? null,
      },
      recentRuns: this.deps.engine.recentRuns(definition.id).slice(-5).reverse() as RunRecord[],
      recentFires: this.deps.fires.forTrigger(definition.id).slice(-5).reverse().map(fireView),
    };
  }

  /** Runs an active trigger's probe once with its current state, without firing or saving anything. */
  async test(params: { triggerId?: unknown }) {
    const id = this.requireTrigger(params.triggerId);
    let result: ProbeRunResult;
    try {
      result = await this.deps.engine.test(id);
    } catch (error) {
      throw new ServiceError("refused", (error as Error).message);
    }
    return toTrial(result);
  }

  history(params: { triggerId?: unknown; limit?: unknown }) {
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(100, Math.floor(params.limit)) : 10;
    const fires = params.triggerId === undefined ? this.deps.fires.all() : this.deps.fires.forTrigger(this.requireTrigger(params.triggerId));
    return fires.slice(-limit).reverse().map(fireView);
  }

  report(params: { fireId?: unknown; summary?: unknown; notify?: unknown }, caller: Caller) {
    if (typeof params.fireId !== "string") throw new ServiceError("invalid", "fireId is required");
    if (typeof params.summary !== "string" || params.summary.trim() === "") throw new ServiceError("invalid", "summary is required");
    const notify = params.notify === true;
    let fire: FireRecord;
    try {
      fire = this.deps.executor.report(params.fireId, { summary: params.summary.trim(), notify }, caller);
    } catch (error) {
      const message = (error as Error).message;
      throw new ServiceError(message.startsWith("no such fire") ? "not_found" : "refused", message);
    }
    if (caller.turnId) {
      this.reportedTurns.add(caller.turnId);
      if (this.reportedTurns.size > REPORTED_TURNS_MAX) this.reportedTurns.delete(this.reportedTurns.values().next().value!);
    }
    const when = this.tryLoad(fire.triggerId)?.definition.notify.when ?? "never";
    return { fireId: fire.fireId, status: fire.status, userNotified: when === "always" || (when === "receipt" && notify) };
  }

  status() {
    const ids = this.deps.store.listTriggerIds();
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const lifecycle = this.deps.engine.runtime(id).lifecycle;
      counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
    }
    return {
      version: this.deps.version,
      pid: process.pid,
      startedAt: this.startedAt,
      home: this.deps.paths.home,
      deno: this.deps.deno() ?? null,
      codex: this.deps.codex() ?? null,
      triggers: { total: ids.length, ...counts },
      drafts: this.deps.store.listDrafts().length,
      budget: this.deps.config.budget,
      ...this.deps.executor.status(),
    };
  }

  /** Control API methods. `caller` is passed separately from the method's own parameters. */
  handlers(): Record<string, (params: Record<string, unknown>, caller: Caller) => unknown> {
    return {
      ping: () => ({ version: this.deps.version, pid: process.pid }),
      status: () => this.status(),
      "draft.create": (p, c) => this.createDraft(p, c),
      "draft.get": (p) => this.getDraft(p),
      "draft.list": () => this.listDrafts(),
      "draft.discard": (p) => this.discardDraft(p),
      "draft.activate": (p, c) => this.activateDraft(p, c),
      "trigger.list": () => this.list(),
      "trigger.get": (p) => this.get(p),
      "trigger.test": (p) => this.test(p),
      "trigger.update": (p, c) => this.updateTrigger(p, c),
      "trigger.pause": (p, c) => this.pause(p, c),
      "trigger.resume": (p, c) => this.resume(p, c),
      "trigger.delete": (p, c) => this.delete(p, c),
      "trigger.approval": (p) => this.approvalView(p),
      "trigger.approve": (p, c) => this.approveTrigger(p, c),
      "fire.history": (p) => this.history(p),
      "fire.report": (p, c) => this.report(p, c),
    };
  }
}
