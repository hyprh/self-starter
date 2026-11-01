// Turns fires into actions: a notification, or a message handed to an agent
// conversation (Codex thread, Claude Code session, or ZCode / OpenCode session).
// Applies the concurrency policy, the daily agent budget, retries, receipts,
// receipt timeouts, reminders, and quiet hours; host-specific delivery and
// background waking live in host-delivery.ts.

import { agentName, conversationNoun as conversation, hostFor, hostOf } from "../core/conversations.js";
import type { EnvelopeInput } from "../core/envelope.js";
import type { QuietHours, TriggerDefinition } from "../core/definition.js";
import type { ProbeEvent } from "../core/probe-output.js";
import { isQuietTime } from "../core/quiet-hours.js";
import type { FireDraft } from "../core/state-machine.js";
import type { CodexRunner } from "./codex.js";
import type { Config } from "./config.js";
import type { FireLog, FireRecord, Receipt } from "./fires.js";
import { HostDelivery } from "./host-delivery.js";
import type { Notification, Notifier } from "./notify.js";
import type { OpenCodeRunner } from "./opencode.js";
import type { Paths } from "./paths.js";
import type { SessionRunner } from "./sessions.js";
import type { Store } from "./store.js";
import type { ZCodeRunner } from "./zcode.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
const MAX_FAILURES = RETRY_DELAYS_MS.length + 1;

export interface ExecutorDeps {
  store: Store;
  fires: FireLog;
  paths: Paths;
  config: Config;
  notifier: Notifier;
  /** Returns undefined when no codex binary is available. */
  codex: () => CodexRunner | undefined;
  /** Runs headless turns of Claude Code sessions; undefined when no claude binary is available. */
  claude?: () => SessionRunner | undefined;
  zcode?: () => ZCodeRunner | undefined;
  opencode?: () => OpenCodeRunner | undefined;
  /** Hands a message to a Claude Code process that shows the session (tests replace it). */
  deliverToSession?: (sessionId: string, text: string) => Promise<"relayed" | "posted" | undefined>;
  log: (line: string) => void;
  now?: () => Date;
  /** Milliseconds that pass only while the computer is awake (performance.now() by default). */
  uptime?: () => number;
}

interface Deferred {
  fireId?: string;
  notification: Notification;
  quiet: QuietHours | undefined;
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** A receipt from the last message of a turn that did not call trigger_report: its first line. */
function receiptFrom(lastMessage: string | undefined, fallback: string): { summary: string; notify: boolean } {
  const line = lastMessage?.split("\n").map((text) => text.trim()).find(Boolean);
  return { summary: (line ?? fallback).slice(0, 300), notify: true };
}

export class Executor {
  private readonly inFlight = new Set<string>();
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly deferred: Deferred[] = [];
  private readonly reminded = new Set<string>();
  private readonly delivery: HostDelivery;
  private kicking = false;
  private kickAgain = false;
  private ticking = false;
  private tickAgain = false;
  private closed = false;

  constructor(private readonly deps: ExecutorDeps) {
    this.delivery = new HostDelivery(deps, {
      envelope: (definition, fire) => this.envelope(definition, fire),
      describe: (fire) => this.describe(fire),
      failAttempt: (definition, fire, error) => this.failAttempt(definition, fire, error),
      turnDone: (fire, lastMessage) => this.turnDone(fire, lastMessage),
      remindIfLate: (fire, age) => this.remindIfLate(fire, age),
      remindPaused: async (fire, note) => {
        this.reminded.add(fire.fireId);
        await this.remind(fire, note);
      },
      sendNotification: (definition, fireId, notification) => this.sendNotification(definition, fireId, notification),
      lookAgain: () => this.lookAgain(),
      kick: () => this.kick(),
    });
  }

  private dropDeferred(fireIds: Iterable<string>): void {
    const ids = new Set(fireIds);
    for (let i = this.deferred.length - 1; i >= 0; i--) {
      const fireId = this.deferred[i]!.fireId;
      if (fireId && ids.has(fireId)) this.deferred.splice(i, 1);
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
    const closed: string[] = [];
    for (const fire of this.deps.fires.forTrigger(triggerId)) {
      if (fire.status === "pending") {
        this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the trigger was deleted", at });
        closed.push(fire.fireId);
      } else if (fire.status === "delivered") {
        const receipt: Receipt = { summary: `${fire.summary} (the trigger was deleted)`, notify: false, at, source: "closed" };
        this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
        closed.push(fire.fireId);
      }
    }
    this.dropDeferred(closed);
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
    if (!fire.receipt && fire.status !== "delivered") {
      throw new Error(`fire ${fireId} has not been handed over yet (it is ${fire.status})`);
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

  /** Periodic work: waking threads nobody has open, reminders, receipt timeouts, notifications held by quiet hours, and retries. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.checkOpenFires();
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
    this.kick();
  }

  private async checkOpenFires(): Promise<void> {
    const now = this.now().getTime();
    const timeoutMs = this.deps.config.receiptTimeoutMinutes * 60_000;
    const open = this.deps.fires.withStatus("delivered");
    this.forgetClosed(new Set(open.map((fire) => fire.fireId)));
    for (const fire of open) {
      if (!fire.deliveredAt) continue;
      const age = now - Date.parse(fire.deliveredAt);
      // A session fire waiting for a turn has not reached the agent; its receipt clock starts when it goes in.
      const waiting = fire.target?.via === undefined && hostOf(fire.target?.threadId) !== "codex";
      if (age > timeoutMs && !waiting) {
        const host = hostOf(fire.target?.threadId);
        const receipt: Receipt = {
          summary: `${fire.summary} (no reply from ${agentName(host)} yet; open the ${conversation(host)} to continue)`,
          notify: true,
          at: new Date(now).toISOString(),
          source: "timeout",
        };
        this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at: receipt.at });
        await this.afterReceipt(fire.fireId, receipt);
      } else if (fire.target?.threadId) {
        await this.delivery.follow(fire, age);
      }
    }
    await this.flushDeferred();
  }

  /** Drops what was kept about fires that are no longer waiting for a receipt. */
  private forgetClosed(open: Set<string>): void {
    for (const id of this.reminded) if (!open.has(id)) this.reminded.delete(id);
    this.delivery.forgetClosed(open);
  }

  /**
   * A turn we ran for a fire is over. Usually it reported through trigger_report; otherwise its last message
   * is the receipt, which, like a late report, replaces a "no reply" receipt written while the turn ran.
   */
  private async turnDone(fire: FireRecord, lastMessage: string | undefined): Promise<void> {
    const existing = this.deps.fires.get(fire.fireId)?.receipt;
    if (existing && existing.source !== "timeout") return;
    const at = this.now().toISOString();
    const receipt: Receipt = { ...receiptFrom(lastMessage, fire.summary), at, source: "final-answer" };
    this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
    await this.afterReceipt(fire.fireId, receipt);
  }

  /** Looks at open fires again now, without waiting for the next tick. */
  private lookAgain(): void {
    if (!this.closed) this.tick().catch((error: Error) => this.log(`executor tick failed: ${error.message}`));
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

  /** True while a fire of the trigger waits for its receipt. (Fires being dispatched are checked before this.) */
  private busy(triggerId: string, since: number): boolean {
    return this.deps.fires.forTrigger(triggerId).some((fire) => Date.parse(fire.createdAt) >= since && fire.status === "delivered");
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
    // coalesce waits for the previous fire, and the trigger's own thread takes one fire at a time.
    if (busy && definition.action.type === "agent" && (policy === "coalesce" || definition.target.kind === "dedicated")) return;

    let fire = fires[0]!;
    if (policy === "coalesce" && fires.length > 1) {
      fire = fires[fires.length - 1]!;
      for (const older of fires.slice(0, -1)) {
        this.deps.fires.record({ type: "merged", fireId: older.fireId, into: fire.fireId, at });
      }
    }
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
  private mergedFires(fire: FireRecord): FireRecord[] {
    const out: FireRecord[] = [];
    for (const id of fire.merged) {
      const child = this.deps.fires.get(id);
      if (child) out.push(...this.mergedFires(child), child);
    }
    return out;
  }

  /** How often the trigger fired up to this fire, so that Codex can tell when it is too noisy. */
  private recentFires(definition: TriggerDefinition, fire: FireRecord): { lastDay: number; lastHour: number } {
    const at = Date.parse(fire.createdAt);
    const since = Math.max(Date.parse(definition.meta.created_at), at - 86_400_000);
    const times = this.deps.fires
      .forTrigger(definition.id)
      .map((other) => Date.parse(other.createdAt))
      .filter((time) => time >= since && time <= at);
    return { lastDay: times.length, lastHour: times.filter((time) => time > at - 3_600_000).length };
  }

  private envelope(definition: TriggerDefinition, fire: FireRecord): EnvelopeInput {
    const merged = this.mergedFires(fire);
    const byKey = new Map<string, ProbeEvent>();
    for (const item of [...merged, fire]) for (const event of item.events ?? []) byKey.set(event.key, event);
    const previous = this.deps.fires.previousDone(definition.id, definition.meta.created_at);
    const base: EnvelopeInput = {
      definition,
      fireId: fire.fireId,
      fireNumber: fire.fireNumber,
      firedAt: fire.createdAt,
      reason: fire.reason,
      summary: fire.summary,
      data: fire.data,
      merged: 1 + merged.length,
      previous: previous?.receipt ? { firedAt: previous.createdAt, summary: previous.receipt.summary } : null,
      recentFires: this.recentFires(definition, fire),
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

    const host = hostFor(definition);
    const limit = this.deps.config.budget.maxAgentRunsPerDay;
    // A missing session can put an already charged fire back into delivery.
    // Its bounded retries consume the same fire's budget entry, not a new one.
    const alreadyCounted = fire.target && fire.target.kind !== "none" && fire.deliveredAt && localDay(new Date(fire.deliveredAt)) === localDay(this.now());
    if (this.agentRunsToday() - (alreadyCounted ? 1 : 0) >= limit) {
      this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the daily agent budget is used up", at: this.now().toISOString() });
      await this.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.describe(fire)} (not handed to ${agentName(host)}: the daily limit of ${limit} runs is used up)`,
      });
      return;
    }

    await this.delivery.deliver(definition, fire);
  }

  /** Creates the dedicated thread (or session) right after activation, so it exists before the first fire. */
  prepareDedicatedThread(triggerId: string): void {
    this.delivery.prepareDedicated(triggerId);
  }

  private async failAttempt(definition: TriggerDefinition, fire: FireRecord, error: string): Promise<void> {
    const failures = (this.deps.fires.get(fire.fireId)?.failures ?? 0) + 1;
    const at = this.now().toISOString();
    if (failures >= MAX_FAILURES) {
      this.deps.fires.record({ type: "failed", fireId: fire.fireId, error, at });
      this.log(`fire ${fire.fireId} failed: ${error}`);
      await this.sendNotification(definition, fire.fireId, {
        title: `${definition.name}: could not hand the fire to ${agentName(hostFor(definition))}`,
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

  /** Tells the user once that a fire still waits for its reply, when it has waited originReminderMinutes. */
  private async remindIfLate(fire: FireRecord, age: number): Promise<void> {
    if (age <= this.deps.config.originReminderMinutes * 60_000 || fire.notifiedAt || this.reminded.has(fire.fireId)) return;
    this.reminded.add(fire.fireId);
    await this.remind(fire);
  }

  private async remind(fire: FireRecord, note = Executor.waitingNote(fire)): Promise<void> {
    if (!this.deps.store.hasTrigger(fire.triggerId)) return;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    if (definition.notify.when === "never") return;
    const notification: Notification = { title: definition.name, body: `${this.describe(fire)} (${note})` };
    if (fire.target?.threadId) notification.threadId = fire.target.threadId;
    await this.sendNotification(definition, fire.fireId, notification);
  }

  /** Where a fire waits for its reply, for the reminder. */
  private static waitingNote(fire: FireRecord): string {
    const host = hostOf(fire.target?.threadId);
    return `waiting for ${agentName(host)} in ${fire.target?.kind === "dedicated" ? "the trigger's" : "your"} ${conversation(host)}`;
  }

  private async afterReceipt(fireId: string, receipt: Receipt): Promise<void> {
    const fire = this.deps.fires.get(fireId);
    if (!fire || !this.deps.store.hasTrigger(fire.triggerId)) return;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    const when = definition.notify.when;
    if (when === "never") {
      this.dropDeferred([fireId]);
      return;
    }
    // A reminder already told (or is held to tell) the user that the fire is waiting.
    if (receipt.source === "timeout" && (fire.notifiedAt || this.deferred.some((item) => item.fireId === fireId))) return;
    this.dropDeferred([fireId]);
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
      this.deferred.push({ ...(fireId ? { fireId } : {}), notification, quiet });
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
    for (const item of ready) {
      await this.deps.notifier.notify(item.notification);
      if (item.fireId) this.deps.fires.record({ type: "notified", fireId: item.fireId, at: now.toISOString() });
      const index = this.deferred.indexOf(item);
      if (index >= 0) this.deferred.splice(index, 1);
    }
  }

  status(): { activeAgentRuns: number; deferredNotifications: number; agentRunsToday: number } {
    return { activeAgentRuns: this.delivery.activeRuns, deferredNotifications: this.deferred.length, agentRunsToday: this.agentRunsToday() };
  }
}
