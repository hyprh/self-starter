// Turns fires into actions: a notification, a message queued into the origin
// thread, or a turn run in the trigger's dedicated thread. Applies the
// concurrency policy, the daily agent budget, retries, receipts, receipt
// timeouts and quiet hours.
//
// A message queued into the origin thread runs as soon as a Codex app has that
// thread open. When nobody does, the executor wakes the thread itself after a
// minute, so the conversation still reacts while the app is closed.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { renderDedicatedSeed, renderEnvelope, RECEIPT_SCHEMA, type EnvelopeInput } from "../core/envelope.js";
import type { QuietHours, TriggerDefinition } from "../core/definition.js";
import type { ProbeEvent } from "../core/probe-output.js";
import { isQuietTime } from "../core/quiet-hours.js";
import type { FireDraft } from "../core/state-machine.js";
import type { CodexRunner } from "./codex.js";
import type { Config } from "./config.js";
import type { FireLog, FireRecord, Receipt } from "./fires.js";
import { writeJsonAtomic } from "./fs-util.js";
import type { Notification, Notifier } from "./notify.js";
import type { Paths } from "./paths.js";
import type { Store } from "./store.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
const MAX_FAILURES = RETRY_DELAYS_MS.length + 1;
/** A Codex app that has the thread open picks a queued message up within seconds; after this, nobody has. */
const WAKE_AFTER_MS = 60_000;
/** While the user is in the middle of a turn in the origin thread, look again this much later. */
const BUSY_RECHECK_MS = 60_000;

/** What became of a fire queued into its origin thread. */
type OriginOutcome = "picked-up" | "waking" | "woken" | "unreachable";
/** Errors from codex that mean the thread no longer exists. */
const THREAD_GONE = /archived|not found|no such|unknown thread|does not exist/i;

export interface ExecutorDeps {
  store: Store;
  fires: FireLog;
  paths: Paths;
  config: Config;
  notifier: Notifier;
  /** Returns undefined when no codex binary is available. */
  codex: () => CodexRunner | undefined;
  log: (line: string) => void;
  now?: () => Date;
}

interface Deferred {
  fireId?: string;
  notification: Notification;
  quiet: QuietHours | undefined;
}

type EnvelopeBase = Omit<EnvelopeInput, "receipt">;

function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Reads a receipt from a dedicated-thread run's final answer. */
export function parseReceipt(lastMessage: string | undefined, fallback: string): { summary: string; notify: boolean } {
  if (lastMessage) {
    try {
      const parsed = JSON.parse(lastMessage) as { summary?: unknown; notify?: unknown };
      if (typeof parsed.summary === "string") {
        return { summary: parsed.summary.slice(0, 500), notify: parsed.notify !== false };
      }
    } catch {
      return { summary: lastMessage.trim().slice(0, 500), notify: true };
    }
  }
  return { summary: fallback, notify: true };
}

export class Executor {
  private readonly inFlight = new Set<string>();
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly deferred: Deferred[] = [];
  private readonly reminded = new Set<string>();
  private readonly originOutcome = new Map<string, OriginOutcome>();
  private readonly nextOriginCheck = new Map<string, number>();
  private readonly threadCreation = new Map<string, Promise<string>>();
  private activeAgentRuns = 0;
  private kicking = false;
  private kickAgain = false;
  private closed = false;

  constructor(private readonly deps: ExecutorDeps) {
    writeJsonAtomic(deps.paths.receiptSchema, RECEIPT_SCHEMA);
    // Runs that were in progress when the daemon stopped are retried.
    for (const fire of deps.fires.withStatus("running")) {
      deps.fires.record({ type: "attempt_failed", fireId: fire.fireId, error: "the daemon stopped during the run", at: this.now().toISOString() });
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    this.deps.log(line);
  }

  /** Closes the fires of a deleted trigger that still wait for a receipt, so their threads are free again. */
  closeFiresOf(triggerId: string): void {
    const at = this.now().toISOString();
    for (const fire of this.deps.fires.forTrigger(triggerId)) {
      if (fire.status === "pending") {
        this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the trigger was deleted", at });
      } else if (fire.status === "delivered") {
        const receipt: Receipt = { summary: `${fire.summary} (the trigger was deleted)`, notify: false, at, source: "closed" };
        this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
      }
    }
  }

  /** Stops starting new work; runs in progress finish on their own. */
  close(): void {
    this.closed = true;
  }

  /** Records a new fire and starts working on it. */
  submit(definition: TriggerDefinition, draft: FireDraft, fireNumber: number): FireRecord {
    const fields: Parameters<FireLog["create"]>[0] = {
      triggerId: definition.id,
      revision: definition.meta.revision,
      fireNumber,
      reason: draft.reason,
      summary: draft.summary,
    };
    if (draft.data !== undefined) fields.data = draft.data;
    if (draft.events !== undefined) fields.events = draft.events;
    const fire = this.deps.fires.create(fields, this.now());
    this.log(`fire ${fire.fireId} of ${definition.id}: ${draft.reason}`);
    this.kick();
    return fire;
  }

  /** A receipt reported by the agent through trigger_report. */
  report(fireId: string, receipt: { summary: string; notify: boolean }, caller: { threadId?: string; turnId?: string } = {}): FireRecord {
    const fire = this.deps.fires.get(fireId);
    if (!fire) throw new Error(`no such fire: ${fireId}`);
    if (fire.status === "merged") throw new Error(`fire ${fireId} was merged into ${fire.mergedInto}; report that one instead`);
    // A late reply replaces the "no reply" receipt written at the timeout.
    if (fire.receipt && fire.receipt.source !== "timeout") throw new Error(`fire ${fireId} already has a receipt`);
    if (!fire.receipt && fire.status !== "delivered" && fire.status !== "running") {
      throw new Error(`fire ${fireId} has not been handed to Codex (it is ${fire.status})`);
    }
    if (caller.threadId && fire.target?.threadId && caller.threadId !== fire.target.threadId) {
      throw new Error("this fire was delivered to a different thread");
    }
    const full: Receipt = { summary: receipt.summary.slice(0, 500), notify: receipt.notify, at: this.now().toISOString(), source: "tool" };
    if (caller.turnId) full.turnId = caller.turnId;
    this.deps.fires.record({ type: "receipt", fireId, receipt: full, at: full.at });
    void this.afterReceipt(fireId, full).catch((error: Error) => this.log(`notification failed: ${error.message}`));
    this.kick();
    return this.deps.fires.get(fireId)!;
  }

  /** Periodic work: waking closed origin threads, reminders, receipt timeouts, notifications held by quiet hours, and retries. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    const timeoutMs = this.deps.config.receiptTimeoutMinutes * 60_000;
    const open = this.deps.fires.withStatus("delivered");
    this.forgetClosed(new Set(open.map((fire) => fire.fireId)));
    for (const fire of open) {
      if (!fire.deliveredAt) continue;
      const age = now - Date.parse(fire.deliveredAt);
      if (age > timeoutMs) {
        const receipt: Receipt = {
          summary: `${fire.summary} (no reply from Codex yet; open the thread to continue)`,
          notify: true,
          at: new Date(now).toISOString(),
          source: "timeout",
        };
        this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at: receipt.at });
        await this.afterReceipt(fire.fireId, receipt);
      } else if (fire.target?.kind === "origin") {
        await this.followOrigin(fire, age, now);
      }
    }
    await this.flushDeferred();
    this.kick();
  }

  /** Drops what was kept about fires that are no longer waiting for a receipt. */
  private forgetClosed(open: Set<string>): void {
    for (const id of this.reminded) if (!open.has(id)) this.reminded.delete(id);
    for (const id of this.originOutcome.keys()) if (!open.has(id) && this.originOutcome.get(id) !== "waking") this.originOutcome.delete(id);
    for (const id of this.nextOriginCheck.keys()) if (!open.has(id)) this.nextOriginCheck.delete(id);
  }

  /** A fire queued into the origin thread is still open: wake the thread if nobody has it open, or remind the user. */
  private async followOrigin(fire: FireRecord, age: number, now: number): Promise<void> {
    const outcome = this.originOutcome.get(fire.fireId);
    const wake = this.deps.config.wakeClosedThreads;
    if (wake && outcome === undefined) {
      if (age >= WAKE_AFTER_MS && (this.nextOriginCheck.get(fire.fireId) ?? 0) <= now) this.startWake(fire, now);
      return;
    }
    const remind = wake ? outcome === "unreachable" : true;
    if (remind && age > this.deps.config.originReminderMinutes * 60_000 && !fire.notifiedAt && !this.reminded.has(fire.fireId)) {
      this.reminded.add(fire.fireId);
      await this.remind(fire);
    }
  }

  private startWake(fire: FireRecord, now: number): void {
    const codex = this.deps.codex();
    const threadId = fire.target?.threadId;
    if (!codex || !threadId || !this.deps.store.hasTrigger(fire.triggerId)) {
      this.originOutcome.set(fire.fireId, "unreachable");
      return;
    }
    if (this.activeAgentRuns >= this.deps.config.budget.maxConcurrentAgentRuns) return; // next tick
    this.originOutcome.set(fire.fireId, "waking");
    this.activeAgentRuns += 1;
    void this.wake(fire, threadId, codex, now)
      .catch((error: Error) => {
        this.originOutcome.set(fire.fireId, "unreachable");
        this.log(`could not wake thread ${threadId} for fire ${fire.fireId}: ${error.message}`);
      })
      .finally(() => {
        this.activeAgentRuns -= 1;
        this.kick();
      });
  }

  /** Runs a fire in its origin thread when no Codex app picked it up, so the conversation reacts even while the app is closed. */
  private async wake(fire: FireRecord, threadId: string, codex: CodexRunner, now: number): Promise<void> {
    const view = await codex.inspectThread(threadId, fire.fireId);
    if (view.mentions) {
      this.originOutcome.set(fire.fireId, "picked-up"); // an open Codex app is on it
      return;
    }
    if (view.busy) {
      // The user is in the middle of a turn there; the queued message runs after it.
      this.originOutcome.delete(fire.fireId);
      this.nextOriginCheck.set(fire.fireId, now + BUSY_RECHECK_MS);
      return;
    }
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    this.log(`no Codex app has thread ${threadId} open; running fire ${fire.fireId} there`);
    const result = await codex.wakeThread({
      threadId,
      marker: fire.fireId,
      sandbox: definition.action.sandbox,
      timeoutMs: this.deps.config.agentRunTimeoutMinutes * 60_000,
    });
    if (!result.ok) {
      this.originOutcome.set(fire.fireId, "unreachable");
      this.log(`fire ${fire.fireId} did not run in thread ${threadId}: ${result.error}`);
      return;
    }
    this.originOutcome.set(fire.fireId, "woken");
    // Usually the turn reported through trigger_report; otherwise its last message is the receipt.
    if (this.deps.fires.get(fire.fireId)?.receipt) return;
    const at = this.now().toISOString();
    const receipt: Receipt = { ...parseReceipt(result.lastMessage, fire.summary), at, source: "final-answer" };
    this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
    await this.afterReceipt(fire.fireId, receipt);
  }

  /** Dispatches pending fires that are ready. Never runs twice at once. */
  kick(): void {
    if (this.kicking) {
      this.kickAgain = true;
      return;
    }
    this.kicking = true;
    try {
      do {
        this.kickAgain = false;
        this.dispatchReady();
      } while (this.kickAgain);
    } finally {
      this.kicking = false;
    }
  }

  private dispatchReady(): void {
    if (this.closed) return;
    const now = this.now().getTime();
    const byTrigger = new Map<string, FireRecord[]>();
    for (const fire of this.deps.fires.withStatus("pending")) {
      if (this.inFlight.has(fire.fireId) || (this.nextAttemptAt.get(fire.fireId) ?? 0) > now) continue;
      byTrigger.set(fire.triggerId, [...(byTrigger.get(fire.triggerId) ?? []), fire]);
    }
    for (const [triggerId, fires] of byTrigger) {
      try {
        this.dispatchTrigger(triggerId, fires);
      } catch (error) {
        this.log(`could not dispatch fires of ${triggerId}: ${(error as Error).message}`);
      }
    }
  }

  /** True while a fire of the trigger is being dispatched, run, or waits for its receipt. */
  private busy(triggerId: string, since: number): boolean {
    return this.deps.fires
      .forTrigger(triggerId)
      .some((fire) => Date.parse(fire.createdAt) >= since && (this.inFlight.has(fire.fireId) || fire.status === "running" || fire.status === "delivered"));
  }

  private dispatchTrigger(triggerId: string, pending: FireRecord[]): void {
    let fires = pending;
    const at = this.now().toISOString();
    if (!this.deps.store.hasTrigger(triggerId)) {
      for (const fire of fires) this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the trigger was deleted", at });
      return;
    }
    if (this.deps.fires.forTrigger(triggerId).some((fire) => this.inFlight.has(fire.fireId))) return;
    const { definition } = this.deps.store.loadTrigger(triggerId);
    // Fires from before the trigger was (re)created belong to a deleted trigger with the same id.
    const since = Date.parse(definition.meta.created_at);
    for (const stale of fires.filter((fire) => Date.parse(fire.createdAt) < since)) {
      this.deps.fires.record({ type: "skipped", fireId: stale.fireId, why: "the trigger was deleted", at });
    }
    fires = fires.filter((fire) => Date.parse(fire.createdAt) >= since);
    if (fires.length === 0) return;
    const policy = definition.policy.concurrency;
    const busy = this.busy(triggerId, since);

    if (busy && policy === "skip") {
      for (const fire of fires) {
        this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the previous fire was still being handled", at });
      }
      return;
    }
    // coalesce waits for the previous fire; a dedicated thread runs one turn at a time anyway.
    if (busy && definition.action.type === "agent" && (policy === "coalesce" || definition.target.kind === "dedicated")) return;

    let fire = fires[0]!;
    if (policy === "coalesce" && fires.length > 1) {
      fire = fires[fires.length - 1]!;
      for (const older of fires.slice(0, -1)) {
        this.deps.fires.record({ type: "merged", fireId: older.fireId, into: fire.fireId, at });
      }
    }
    const runsAgent = definition.action.type === "agent" && definition.target.kind === "dedicated";
    if (runsAgent && this.activeAgentRuns >= this.deps.config.budget.maxConcurrentAgentRuns) return;

    this.inFlight.add(fire.fireId);
    void this.dispatch(definition, fire)
      .catch((error: Error) => this.log(`dispatch of ${fire.fireId} crashed: ${error.message}`))
      .finally(() => {
        this.inFlight.delete(fire.fireId);
        this.kick();
      });
  }

  private agentRunsToday(): number {
    const today = localDay(this.now());
    return this.deps.fires
      .all()
      .filter((fire) => fire.target && fire.target.kind !== "none" && fire.deliveredAt && localDay(new Date(fire.deliveredAt)) === today)
      .length;
  }

  /** All fires merged into this one, including fires merged into those. */
  private mergedInto(fire: FireRecord): FireRecord[] {
    const out: FireRecord[] = [];
    for (const id of fire.merged) {
      const child = this.deps.fires.get(id);
      if (child) out.push(...this.mergedInto(child), child);
    }
    return out;
  }

  private envelopeBase(definition: TriggerDefinition, fire: FireRecord): EnvelopeBase {
    const merged = this.mergedInto(fire);
    const byKey = new Map<string, ProbeEvent>();
    for (const item of [...merged, fire]) for (const event of item.events ?? []) byKey.set(event.key, event);
    const previous = this.deps.fires.previousDone(definition.id, fire.fireId, definition.meta.created_at);
    const base: EnvelopeBase = {
      definition,
      fireId: fire.fireId,
      fireNumber: fire.fireNumber,
      firedAt: fire.createdAt,
      reason: fire.reason,
      summary: fire.summary,
      data: fire.data,
      merged: 1 + merged.length,
      previous: previous?.receipt ? { firedAt: previous.createdAt, summary: previous.receipt.summary } : null,
    };
    if (byKey.size > 0) base.events = [...byKey.values()];
    return base;
  }

  private async dispatch(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    if (definition.action.type === "notify") {
      const at = this.now().toISOString();
      this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { kind: "none" }, at });
      const receipt: Receipt = { summary: this.describe(fire), notify: true, at, source: "notify" };
      this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
      await this.afterReceipt(fire.fireId, receipt);
      return;
    }

    const limit = this.deps.config.budget.maxAgentRunsPerDay;
    if (this.agentRunsToday() >= limit) {
      this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the daily agent budget is used up", at: this.now().toISOString() });
      await this.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.describe(fire)} (not handed to Codex: the daily limit of ${limit} runs is used up)`,
      });
      return;
    }

    const codex = this.deps.codex();
    if (!codex) {
      await this.failAttempt(definition, fire, "the codex CLI was not found; run `self-starter doctor`");
      return;
    }

    const base = this.envelopeBase(definition, fire);
    const originThread = definition.meta.origin_thread_id;
    if (definition.target.kind === "origin" && originThread) {
      try {
        await codex.queue(originThread, renderEnvelope({ ...base, receipt: "tool" }));
      } catch (error) {
        const message = (error as Error).message;
        if (THREAD_GONE.test(message)) {
          this.log(`the origin thread of ${definition.id} is gone (${message}); using a dedicated thread`);
          await this.runDedicated(definition, fire, codex, base);
        } else {
          await this.failAttempt(definition, fire, message);
        }
        return;
      }
      const target = { kind: "origin" as const, threadId: originThread };
      this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.now().toISOString() });
      this.log(`fire ${fire.fireId} queued into thread ${originThread}`);
      if (definition.notify.when === "always") {
        await this.sendNotification(definition, fire.fireId, {
          title: definition.name,
          body: `${this.describe(fire)} (sent to your Codex thread)`,
          threadId: originThread,
        });
      }
      return;
    }

    await this.runDedicated(definition, fire, codex, base);
  }

  private async runDedicated(definition: TriggerDefinition, fire: FireRecord, codex: CodexRunner, base: EnvelopeBase): Promise<void> {
    this.activeAgentRuns += 1;
    try {
      let threadId: string;
      try {
        threadId = await this.ensureDedicatedThread(definition.id, codex);
      } catch (error) {
        await this.failAttempt(definition, fire, (error as Error).message);
        return;
      }
      const current = this.deps.store.loadTrigger(definition.id).definition;
      this.deps.fires.record({ type: "started", fireId: fire.fireId, target: { kind: "dedicated", threadId }, at: this.now().toISOString() });
      this.log(`running fire ${fire.fireId} in thread ${threadId}`);
      const result = await codex.resume({
        threadId,
        cwd: this.cwdFor(current),
        prompt: renderEnvelope({ ...base, definition: current, receipt: "final-answer" }),
        sandbox: current.action.sandbox,
        outputSchemaPath: this.deps.paths.receiptSchema,
        timeoutMs: this.deps.config.agentRunTimeoutMinutes * 60_000,
      });
      if (!result.ok) {
        const error = result.error ?? "the run failed";
        if (THREAD_GONE.test(error)) this.forgetDedicatedThread(definition.id, threadId);
        await this.failAttempt(definition, fire, error);
        return;
      }
      const at = this.now().toISOString();
      this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { kind: "dedicated", threadId }, at });
      // The agent may already have reported through trigger_report.
      if (this.deps.fires.get(fire.fireId)?.receipt) return;
      const receipt: Receipt = { ...parseReceipt(result.lastMessage, fire.summary), at, source: "final-answer" };
      this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
      await this.afterReceipt(fire.fireId, receipt);
    } finally {
      this.activeAgentRuns -= 1;
    }
  }

  private cwdFor(definition: TriggerDefinition): string {
    const cwd = definition.target.cwd;
    return cwd && existsSync(cwd) ? cwd : homedir();
  }

  /** Returns the dedicated thread of a trigger, creating it on first use. */
  ensureDedicatedThread(triggerId: string, codex: CodexRunner): Promise<string> {
    const { definition } = this.deps.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    let pending = this.threadCreation.get(triggerId);
    if (!pending) {
      pending = this.createDedicatedThread(definition, codex).finally(() => this.threadCreation.delete(triggerId));
      this.threadCreation.set(triggerId, pending);
    }
    return pending;
  }

  /** Creates the dedicated thread right after activation, so it exists before the first fire. */
  prepareDedicatedThread(triggerId: string): void {
    const codex = this.deps.codex();
    if (!codex) return;
    this.ensureDedicatedThread(triggerId, codex).catch((error: Error) => {
      this.log(`could not create the dedicated thread of ${triggerId} yet: ${error.message}`);
    });
  }

  private async createDedicatedThread(definition: TriggerDefinition, codex: CodexRunner): Promise<string> {
    const cwd = this.cwdFor(definition);
    const prompt = renderDedicatedSeed(definition);
    const timeoutMs = Math.min(this.deps.config.agentRunTimeoutMinutes, 5) * 60_000;
    let result = await codex.startThread({ cwd, name: `Trigger: ${definition.name}`, prompt, outputSchema: RECEIPT_SCHEMA, timeoutMs });
    if (!result.threadId) {
      // Older Codex versions: a thread made by `codex exec` works, but the app may not list it.
      this.log(`codex app-server could not create the thread of ${definition.id} (${result.error}); using codex exec`);
      result = await codex.exec({ cwd, prompt, sandbox: "read-only", outputSchemaPath: this.deps.paths.receiptSchema, timeoutMs });
    }
    if (!result.threadId) throw new Error(`could not create the dedicated thread: ${result.error ?? "no thread id"}`);
    if (this.deps.store.hasTrigger(definition.id)) {
      // Also kept for origin triggers that fall back to a thread of their own, so it is reused.
      const latest = this.deps.store.loadTrigger(definition.id).definition;
      if (!latest.target.thread_id) {
        latest.target.thread_id = result.threadId;
        this.deps.store.saveDefinition(latest);
      }
    }
    this.log(`dedicated thread of ${definition.id}: ${result.threadId}`);
    return result.threadId;
  }

  private forgetDedicatedThread(triggerId: string, threadId: string): void {
    if (!this.deps.store.hasTrigger(triggerId)) return;
    const latest = this.deps.store.loadTrigger(triggerId).definition;
    if (latest.target.thread_id !== threadId) return;
    latest.target.thread_id = null;
    this.deps.store.saveDefinition(latest);
    this.log(`the dedicated thread ${threadId} of ${triggerId} is gone; a new one will be created`);
  }

  private async failAttempt(definition: TriggerDefinition, fire: FireRecord, error: string): Promise<void> {
    const failures = (this.deps.fires.get(fire.fireId)?.failures ?? 0) + 1;
    const at = this.now().toISOString();
    if (failures >= MAX_FAILURES) {
      this.deps.fires.record({ type: "failed", fireId: fire.fireId, error, at });
      this.log(`fire ${fire.fireId} failed: ${error}`);
      await this.sendNotification(definition, fire.fireId, {
        title: `${definition.name}: could not hand the fire to Codex`,
        body: `${fire.summary}. ${error}`,
      });
      return;
    }
    this.deps.fires.record({ type: "attempt_failed", fireId: fire.fireId, error, at });
    const delay = RETRY_DELAYS_MS[failures - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    this.nextAttemptAt.set(fire.fireId, this.now().getTime() + delay);
    this.log(`fire ${fire.fireId} attempt ${failures} failed (${error}); retrying in ${Math.round(delay / 1000)}s`);
  }

  /** One line for notifications: the summary, and for event fires which events are new. */
  private describe(fire: FireRecord): string {
    const events = fire.events ?? [];
    if (events.length === 0) return fire.summary;
    const names = events.slice(0, 3).map((event) => event.summary ?? event.key);
    const more = events.length > 3 ? ` and ${events.length - 3} more` : "";
    return `${fire.summary} (new: ${names.join("; ")}${more})`;
  }

  private async remind(fire: FireRecord): Promise<void> {
    if (!this.deps.store.hasTrigger(fire.triggerId)) return;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    if (definition.notify.when === "never") return;
    const notification: Notification = { title: definition.name, body: `${this.describe(fire)} (waiting for Codex in your thread)` };
    if (fire.target?.threadId) notification.threadId = fire.target.threadId;
    await this.sendNotification(definition, fire.fireId, notification);
  }

  private async afterReceipt(fireId: string, receipt: Receipt): Promise<void> {
    const fire = this.deps.fires.get(fireId);
    if (!fire || !this.deps.store.hasTrigger(fire.triggerId)) return;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    const when = definition.notify.when;
    if (when === "never") return;
    // A reminder already told the user that the fire is waiting.
    if (receipt.source === "timeout" && fire.notifiedAt) return;
    if (when === "receipt" && !receipt.notify) return;
    const notification: Notification = { title: definition.name, body: receipt.summary };
    if (fire.target?.threadId) notification.threadId = fire.target.threadId;
    await this.sendNotification(definition, fireId, notification);
  }

  /** Sends a notification about a trigger to the trigger's channels, holding it during the trigger's quiet hours. */
  private async sendNotification(definition: TriggerDefinition | undefined, fireId: string | undefined, notification: Notification): Promise<void> {
    const quiet = definition?.policy.quiet_hours;
    if (definition?.notify.channels && !notification.channels) notification = { ...notification, channels: definition.notify.channels };
    if (isQuietTime(this.now(), quiet)) {
      this.deferred.push({ fireId, notification, quiet });
      return;
    }
    await this.deps.notifier.notify(notification);
    if (fireId) this.deps.fires.record({ type: "notified", fireId, at: this.now().toISOString() });
  }

  /** Notifications about a trigger itself (its health), outside any fire. */
  async notifyAbout(definition: TriggerDefinition | undefined, notification: Notification): Promise<void> {
    await this.sendNotification(definition, undefined, notification);
  }

  private async flushDeferred(): Promise<void> {
    const now = this.now();
    const ready = this.deferred.filter((item) => !isQuietTime(now, item.quiet));
    if (ready.length === 0) return;
    this.deferred.splice(0, this.deferred.length, ...this.deferred.filter((item) => !ready.includes(item)));
    for (const item of ready) {
      await this.deps.notifier.notify(item.notification);
      if (item.fireId) this.deps.fires.record({ type: "notified", fireId: item.fireId, at: now.toISOString() });
    }
  }

  status(): { activeAgentRuns: number; deferredNotifications: number; agentRunsToday: number } {
    return { activeAgentRuns: this.activeAgentRuns, deferredNotifications: this.deferred.length, agentRunsToday: this.agentRunsToday() };
  }
}
