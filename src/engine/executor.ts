// Turns fires into actions: a notification, or a message queued into a Codex
// thread, either the one where the trigger was created or the trigger's own.
// Applies the concurrency policy, the daily agent budget, retries, receipts,
// receipt timeouts and quiet hours.
//
// A queued message runs as soon as a Codex app has its thread open. When none
// has, the executor wakes the thread itself, so the conversation still reacts
// while the app is closed.
//
// A trigger made in Claude Code hands its fires to a Claude Code session the same
// way: into the process that shows the session, when one does, and otherwise as
// a headless turn of that session (see sessions.ts).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { agentName, conversationNoun as conversation, hostFor, hostOf, opencodeRef, opencodeSessionIdOf, sessionIdOf, sessionRef, zcodeRef, zcodeSessionIdOf } from "../core/conversations.js";
import { renderDedicatedSeed, renderEnvelope, type EnvelopeInput } from "../core/envelope.js";
import type { QuietHours, TriggerDefinition } from "../core/definition.js";
import type { ProbeEvent } from "../core/probe-output.js";
import { isQuietTime } from "../core/quiet-hours.js";
import type { FireDraft } from "../core/state-machine.js";
import type { CodexRunner } from "./codex.js";
import type { Config } from "./config.js";
import type { FireLog, FireRecord, Receipt } from "./fires.js";
import type { Notification, Notifier } from "./notify.js";
import type { Paths } from "./paths.js";
import { deliverToOpenSession, lastWritten, readSession, type SessionRunner } from "./sessions.js";
import type { ZCodeRunner } from "./zcode.js";
import type { OpenCodeRunner } from "./opencode.js";
import type { Store } from "./store.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
const MAX_FAILURES = RETRY_DELAYS_MS.length + 1;
/**
 * Codex looks for messages queued from outside every 10 seconds, so after this
 * long without a pick-up no Codex app has the thread open. Counted on a clock
 * that stops while the computer sleeps, so an app waking up with it gets its turn.
 */
const WAKE_AFTER_MS = 20_000;
/** While someone is in the middle of a turn in the thread, look again this much later. */
const BUSY_RECHECK_MS = 60_000;

/**
 * What became of a fire queued into a thread. paused: Codex holds the queue of the user's thread, so the
 * fire waits for them. open: a Codex app has the thread open but has not run the fire; the engine looks again.
 */
type QueuedOutcome = "picked-up" | "waking" | "woken" | "paused" | "open" | "unreachable";
/** Where a fire was queued; submissionId is the message's id from `codex queue`. */
type QueuedTarget = { kind: "origin" | "dedicated"; threadId: string; submissionId?: string };
/** What claude -p answers for a session that no longer exists. */
const SESSION_GONE = /No conversation found/i;
/**
 * A turn the hooks still see running is over once its session has written nothing for this long: a turn the
 * user interrupted runs no hook, and neither does a Claude Code that crashed. A turn at work writes as it goes.
 */
const TURN_QUIET_MS = 15 * 60_000;
/** How long a fire just posted into a session counts as a turn there, before the session reports one. */
const POST_GRACE_MS = 60_000;
/** Errors from codex that mean the thread no longer exists. */
const THREAD_GONE = /archived|not found|no such|unknown thread|does not exist/i;
/** What codex answers when another process, such as a Codex app, has the thread open. */
const OPEN_ELSEWHERE = /active writer/i;
type CliHost = "zcode" | "opencode";

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

/** The folder, while it exists; the home folder otherwise. */
function folderOrHome(folder: string | null | undefined): string {
  return folder && existsSync(folder) ? folder : homedir();
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
  /** Per fire queued into a thread: when it was queued (uptime), what came of it, and when to look again. */
  private readonly queuedAt = new Map<string, number>();
  private readonly outcome = new Map<string, QueuedOutcome>();
  private readonly nextCheck = new Map<string, number>();
  private readonly threadCreation = new Map<string, Promise<string>>();
  /** Sessions running a headless turn of ours: one turn at a time, even after a receipt. */
  private readonly headlessSessions = new Set<string>();
  /** Claude Code sessions that claude could not find. */
  private readonly goneSessions = new Set<string>();
  /** When a fire was last posted into each Claude Code session. */
  private readonly postedAt = new Map<string, number>();
  private activeAgentRuns = 0;
  private kicking = false;
  private kickAgain = false;
  private ticking = false;
  private tickAgain = false;
  private closed = false;

  constructor(private readonly deps: ExecutorDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private uptime(): number {
    return this.deps.uptime?.() ?? performance.now();
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
        await this.follow(fire, age);
      }
    }
    await this.flushDeferred();
  }

  /** Drops what was kept about fires that are no longer waiting for a receipt. */
  private forgetClosed(open: Set<string>): void {
    for (const id of this.reminded) if (!open.has(id)) this.reminded.delete(id);
    for (const id of this.queuedAt.keys()) if (!open.has(id)) this.queuedAt.delete(id);
    for (const id of this.outcome.keys()) if (!open.has(id) && this.outcome.get(id) !== "waking") this.outcome.delete(id);
    for (const id of this.nextCheck.keys()) if (!open.has(id)) this.nextCheck.delete(id);
  }

  /** A fire queued into a thread is still open: wake the thread if no Codex app has it open, or remind the user. */
  private async follow(fire: FireRecord, age: number): Promise<void> {
    const host = hostOf(fire.target?.threadId);
    if (host === "zcode" || host === "opencode") return this.followCliSession(fire, age, host);
    if (sessionIdOf(fire.target?.threadId) !== undefined) return this.followSession(fire, age);
    const outcome = this.outcome.get(fire.fireId);
    // The trigger's own thread is always woken; the user can keep Self-Starter out of their own threads.
    const wake = fire.target?.kind === "dedicated" || this.deps.config.wakeClosedThreads;
    if (wake && (outcome === undefined || outcome === "open")) {
      const uptime = this.uptime();
      if (!this.queuedAt.has(fire.fireId)) this.queuedAt.set(fire.fireId, uptime); // queued before a restart
      const waited = uptime - this.queuedAt.get(fire.fireId)!;
      if (waited >= WAKE_AFTER_MS && (this.nextCheck.get(fire.fireId) ?? 0) <= uptime) return this.startWake(fire);
      if (outcome === undefined) return;
    }
    // The fire is still waiting in the thread: tell the user after a while.
    if (!wake || outcome === "open" || outcome === "unreachable") await this.remindIfLate(fire, age);
  }

  private startWake(fire: FireRecord): void {
    const codex = this.deps.codex();
    const threadId = fire.target?.threadId;
    if (!codex || !threadId || !this.deps.store.hasTrigger(fire.triggerId)) {
      this.outcome.set(fire.fireId, "unreachable");
      return;
    }
    if (!this.runSlotFree()) return; // next tick
    this.runTurn(fire, `thread ${threadId}`, () => this.wake(fire, threadId, codex));
  }

  /** Runs a fire in its thread when no Codex app picked it up, so the conversation reacts even while the app is closed. */
  private async wake(fire: FireRecord, threadId: string, codex: CodexRunner): Promise<void> {
    const view = await codex.inspectThread(threadId, fire.fireId);
    if (view.mentions) {
      this.outcome.set(fire.fireId, "picked-up"); // an open Codex app is on it
      return;
    }
    if (view.busy) {
      // Someone is in the middle of a turn there; the queued message runs after it.
      this.outcome.delete(fire.fireId);
      this.nextCheck.set(fire.fireId, this.uptime() + BUSY_RECHECK_MS);
      return;
    }
    const own = fire.target?.kind === "dedicated";
    const submissionId = fire.target?.submissionId;
    // A stopped turn (Stop, or the app closed in the middle of one) makes Codex hold the thread's queue.
    // The fire is started anyway, unless messages of the user's are held there too: those wait for the user.
    if (view.paused && (!submissionId || (!own && view.holdsOthers))) return this.waitInPausedThread(fire);
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    this.log(`no Codex app has thread ${threadId} open; running fire ${fire.fireId} there`);
    const result = await codex.wakeThread({
      threadId,
      marker: fire.fireId,
      sandbox: definition.action.sandbox,
      // The trigger's own thread follows target.cwd; a thread of the user's keeps its folder.
      ...(own ? { cwd: this.cwdFor(definition) } : {}),
      ...(view.paused ? { startQueued: submissionId } : {}),
      onOpen: () => this.deps.fires.record({ type: "woken", fireId: fire.fireId, at: this.now().toISOString() }),
      timeoutMs: this.deps.config.agentRunTimeoutMinutes * 60_000,
    });
    if (!result.ok && OPEN_ELSEWHERE.test(result.error ?? "")) {
      // A Codex app has the thread open after all. With the queue held, the user is there to continue it.
      if (view.paused) return this.waitInPausedThread(fire);
      // Otherwise the app runs the fire; look again in case it lets go of the thread first.
      this.outcome.set(fire.fireId, "open");
      this.nextCheck.set(fire.fireId, this.uptime() + BUSY_RECHECK_MS);
      return;
    }
    if (!result.ok) {
      this.outcome.set(fire.fireId, "unreachable");
      this.log(`fire ${fire.fireId} did not run in thread ${threadId}: ${result.error}`);
      return;
    }
    await this.turnDone(fire, result.lastMessage);
  }

  /** The fire stays queued in a thread where Codex was stopped, and runs when the user continues there; the user is told now. */
  private async waitInPausedThread(fire: FireRecord): Promise<void> {
    this.outcome.set(fire.fireId, "paused");
    this.reminded.add(fire.fireId);
    await this.remind(fire, "waiting in your thread: Codex was stopped there, so it runs when you continue the conversation");
  }

  /** Whether budget.maxConcurrentAgentRuns leaves room for another turn of ours. */
  private runSlotFree(): boolean {
    return this.activeAgentRuns < this.deps.config.budget.maxConcurrentAgentRuns;
  }

  /** Runs a turn for a fire in a run slot, in the background: the fire is waking meanwhile, and unreachable if the run breaks. */
  private runTurn(fire: FireRecord, where: string, run: () => Promise<void>, finished?: () => void): void {
    this.outcome.set(fire.fireId, "waking");
    this.activeAgentRuns += 1;
    void run()
      .catch((error: Error) => {
        this.outcome.set(fire.fireId, "unreachable");
        this.log(`could not run fire ${fire.fireId} in ${where}: ${error.message}`);
      })
      .finally(() => {
        this.activeAgentRuns -= 1;
        finished?.();
        this.lookAgain(); // another fire may be waiting for the slot
      });
  }

  /**
   * A turn we ran for a fire is over. Usually it reported through trigger_report; otherwise its last message
   * is the receipt, which, like a late report, replaces a "no reply" receipt written while the turn ran.
   */
  private async turnDone(fire: FireRecord, lastMessage: string | undefined): Promise<void> {
    this.outcome.set(fire.fireId, "woken");
    const existing = this.deps.fires.get(fire.fireId)?.receipt;
    if (existing && existing.source !== "timeout") return;
    const at = this.now().toISOString();
    const receipt: Receipt = { ...receiptFrom(lastMessage, fire.summary), at, source: "final-answer" };
    this.deps.fires.record({ type: "receipt", fireId: fire.fireId, receipt, at });
    await this.afterReceipt(fire.fireId, receipt);
  }

  // ---- Dedicated conversation creation -----------------------------------

  private creationKey(definition: TriggerDefinition): string {
    return JSON.stringify([definition.id, definition.meta.created_at, definition.meta.revision, hostFor(definition)]);
  }

  private createOnce(definition: TriggerDefinition, create: () => Promise<string>): Promise<string> {
    const key = this.creationKey(definition);
    let pending = this.threadCreation.get(key);
    if (!pending) {
      pending = create().finally(() => this.threadCreation.delete(key));
      this.threadCreation.set(key, pending);
    }
    return pending;
  }

  private bindDedicated(definition: TriggerDefinition, ref: string): string {
    const latest = this.deps.store.loadTrigger(definition.id).definition;
    if (this.creationKey(latest) !== this.creationKey(definition)) throw new Error("the trigger changed while its result session was being created");
    if (!latest.target.thread_id || latest.target.thread_id === definition.target.thread_id) {
      latest.target.thread_id = ref;
      this.deps.store.saveDefinition(latest);
    }
    return latest.target.thread_id;
  }

  // ---- Dedicated CLI sessions --------------------------------------------

  private ensureCliSession(triggerId: string, host: CliHost): Promise<string> {
    const { definition } = this.deps.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    return this.createOnce(definition, () => this.createCliSession(definition, host));
  }

  private async createCliSession(definition: TriggerDefinition, host: CliHost): Promise<string> {
    const runner = this.deps[host]?.();
    if (!runner) throw new Error(`the ${host} CLI was not found; run \`self-starter doctor\``);
    const result = await runner.run({
      cwd: definition.target.cwd ?? homedir(),
      message: renderDedicatedSeed(definition, "session"),
      sandbox: definition.action.sandbox,
      timeoutMs: Math.min(this.deps.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.ok || !result.sessionId) throw new Error(`could not create the ${agentName(host)} session: ${result.error ?? "no session id"}`);
    const ref = this.bindDedicated(definition, host === "opencode" ? opencodeRef(result.sessionId) : zcodeRef(result.sessionId));
    this.log(`dedicated ${agentName(host)} session of ${definition.id}: ${result.sessionId}`);
    return ref;
  }

  private async dispatchToCliSession(definition: TriggerDefinition, fire: FireRecord, host: CliHost): Promise<void> {
    let threadId: string;
    try {
      threadId = await this.ensureCliSession(definition.id, host);
    } catch (error) {
      return this.failAttempt(definition, fire, (error as Error).message);
    }
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { kind: "dedicated", threadId }, at: this.now().toISOString() });
    this.lookAgain();
    if (definition.notify.when === "always") {
      await this.sendNotification(definition, fire.fireId, { title: definition.name, body: `${this.describe(fire)} (sent to ${agentName(host)})`, threadId });
    }
  }

  /** A queued fire can outlive the action or session it was delivered to. */
  private cliTask(fire: FireRecord, ref: string, host: CliHost, expected?: TriggerDefinition): TriggerDefinition | undefined {
    if (fire.status !== "delivered" || fire.target?.via !== undefined) {
      this.outcome.delete(fire.fireId);
      return undefined;
    }
    const definition = this.deps.store.hasTrigger(fire.triggerId) ? this.deps.store.loadTrigger(fire.triggerId).definition : undefined;
    if (definition?.action.type === "agent" && hostFor(definition) === host
      && definition.target.kind === "dedicated" && definition.target.thread_id === ref
      && (!expected || definition.action.sandbox === expected.action.sandbox && definition.action.prompt === expected.action.prompt
        && (definition.target.cwd ?? homedir()) === (expected.target.cwd ?? homedir()))) return definition;
    this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: definition
      ? "the trigger's action or result session changed before execution"
      : "the trigger was deleted", at: this.now().toISOString() });
    this.outcome.delete(fire.fireId);
    this.kick();
    return undefined;
  }

  private async followCliSession(fire: FireRecord, age: number, host: CliHost): Promise<void> {
    const ref = fire.target?.threadId;
    if (!ref || this.headlessSessions.has(ref)) return;
    const runner = this.deps[host]?.();
    if (fire.target?.via === undefined && runner && this.runSlotFree() && (this.nextCheck.get(fire.fireId) ?? 0) <= this.uptime()) {
      const definition = this.cliTask(fire, ref, host);
      if (!definition) return;
      const sessionId = (host === "opencode" ? opencodeSessionIdOf(ref) : zcodeSessionIdOf(ref))!;
      this.headlessSessions.add(ref);
      this.runTurn(fire, `${agentName(host)} session ${sessionId}`, async () => {
        const result = await runner.run({
          sessionId,
          cwd: definition.target.cwd ?? homedir(),
          message: renderEnvelope(this.envelope(definition, fire)),
          sandbox: definition.action.sandbox,
          timeoutMs: this.deps.config.agentRunTimeoutMinutes * 60_000,
          onStart: () => {
            if (!this.cliTask(fire, ref, host, definition)) throw new Error(`the queued ${agentName(host)} action was cancelled before execution`);
            this.wentIn(fire, "headless");
            this.deps.fires.record({ type: "woken", fireId: fire.fireId, at: this.now().toISOString() });
          },
        });
        if (result.busy) {
          this.outcome.delete(fire.fireId);
          this.nextCheck.set(fire.fireId, this.uptime() + BUSY_RECHECK_MS);
          return;
        }
        if (!result.ok) {
          if (fire.status !== "delivered") return;
          // A failed start is still a failed attempt, not a reason to retry on every tick.
          if (fire.target?.via === undefined) this.wentIn(fire, "headless");
          throw new Error(result.error ?? `${agentName(host)} did not complete the turn`);
        }
        await this.turnDone(fire, result.lastMessage);
      }, () => this.headlessSessions.delete(ref));
    }
    if (this.outcome.get(fire.fireId) !== "waking") await this.remindIfLate(fire, age);
  }

  // ---- Claude Code sessions ------------------------------------------------

  /** A fire for a trigger made in Claude Code: handed to the session it was made in, or to the trigger's own. */
  private async dispatchToSession(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    let target: QueuedTarget;
    try {
      target = await this.sessionFor(definition);
    } catch (error) {
      return this.failAttempt(definition, fire, (error as Error).message);
    }
    // Handed over: it goes into the session once no turn runs there (followSession).
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.now().toISOString() });
    this.lookAgain();
    if (definition.notify.when === "always") {
      await this.sendNotification(definition, fire.fireId, { title: definition.name, body: `${this.describe(fire)} (sent to Claude)`, threadId: target.threadId });
    }
  }

  /** Where a fire of the trigger goes: the session it was made in while Claude Code has it, the trigger's own otherwise. */
  private async sessionFor(definition: TriggerDefinition): Promise<QueuedTarget> {
    const origin = definition.target.kind === "origin" ? definition.meta.origin_thread_id : undefined;
    if (origin && this.sessionExists(origin)) return { kind: "origin", threadId: origin };
    if (origin) this.log(`the origin session of ${definition.id} is gone; using a session of its own`);
    return { kind: "dedicated", threadId: await this.ensureDedicatedSession(definition.id) };
  }

  /**
   * A fire handed to a Claude Code session is still open. Until it is in the session, it goes in as soon as
   * no turn runs there, the way a message queued in Codex waits for the turn in progress: into the process
   * that shows the session, or as a headless turn when none does. Then the user hears about it if no reply comes.
   */
  private async followSession(fire: FireRecord, age: number): Promise<void> {
    if (fire.target?.via === undefined && (await this.bringIntoSession(fire))) return;
    if (this.outcome.get(fire.fireId) !== "waking") await this.remindIfLate(fire, age);
  }

  /** Puts a fire into its session if no turn runs there: true when it went in, or started running there. */
  private async bringIntoSession(fire: FireRecord): Promise<boolean> {
    const sessionId = sessionIdOf(fire.target?.threadId)!;
    if (this.headlessSessions.has(sessionId) || this.sessionBusy(sessionId) || !this.deps.store.hasTrigger(fire.triggerId)) return false;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    const message = renderEnvelope(this.envelope(definition, fire));
    const how = await this.deliver(sessionId, message).catch((error: Error) => {
      this.log(`could not deliver into session ${sessionId}: ${error.message}`);
      return undefined;
    });
    if (!how) return this.startHeadless(definition, fire, sessionId, message);
    this.postedAt.set(sessionId, this.now().getTime());
    this.wentIn(fire, "inbox");
    this.log(`fire ${fire.fireId} ${how} into session ${sessionId}`);
    return true;
  }

  /** Hands a message to a Claude Code process that shows the session: how it went in, or undefined when none does. */
  private deliver(sessionId: string, text: string): Promise<"relayed" | "posted" | undefined> {
    return this.deps.deliverToSession?.(sessionId, text) ?? deliverToOpenSession(this.deps.paths, sessionId, text, (line) => this.log(line));
  }

  /** Records how a fire handed to a session went into it; the time it waits for a receipt starts now. */
  private wentIn(fire: FireRecord, via: "inbox" | "headless"): void {
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { ...fire.target!, via }, at: this.now().toISOString() });
  }

  /** Whether a turn runs in the session, which a fire waits for. A fire posted there a moment ago counts until its turn starts. */
  private sessionBusy(sessionId: string): boolean {
    const session = readSession(this.deps.paths, sessionId);
    const turn = session?.turn;
    const now = this.now().getTime();
    const turnAt = turn ? Date.parse(turn.at) : 0;
    if (turn?.running && (now - turnAt < TURN_QUIET_MS || now - lastWritten(session!) < TURN_QUIET_MS)) return true;
    const posted = this.postedAt.get(sessionId);
    if (posted === undefined) return false;
    if (now - posted < POST_GRACE_MS) return turnAt < posted;
    this.postedAt.delete(sessionId);
    return false;
  }

  /** Runs the fire as a headless turn of its session, which no Claude Code process shows; false when it cannot start yet. */
  private startHeadless(definition: TriggerDefinition, fire: FireRecord, sessionId: string, message: string): boolean {
    const claude = this.deps.claude?.();
    // Without claude it waits for the user to open the session (and they get the reminder); otherwise for a run slot.
    if (!claude || !this.runSlotFree()) return false;
    this.headlessSessions.add(sessionId);
    this.wentIn(fire, "headless");
    this.deps.fires.record({ type: "woken", fireId: fire.fireId, at: this.now().toISOString() });
    this.log(`no Claude Code process shows session ${sessionId}; running fire ${fire.fireId} there headless`);
    const run = () => this.runHeadless(definition, fire, sessionId, message, claude);
    this.runTurn(fire, `session ${sessionId}`, run, () => this.headlessSessions.delete(sessionId));
    return true;
  }

  private async runHeadless(definition: TriggerDefinition, fire: FireRecord, sessionId: string, message: string, claude: SessionRunner): Promise<void> {
    const session = readSession(this.deps.paths, sessionId);
    const result = await claude.run({
      sessionId,
      // The trigger's own session follows target.cwd; a session of the user's keeps its folder.
      cwd: folderOrHome(fire.target?.kind === "dedicated" ? definition.target.cwd : session?.cwd),
      message,
      sandbox: definition.action.sandbox,
      ...(session?.configDir ? { configDir: session.configDir } : {}),
      timeoutMs: this.deps.config.agentRunTimeoutMinutes * 60_000,
    });
    if (!result.ok && SESSION_GONE.test(result.error ?? "")) {
      // Handed over again, to the trigger's own session.
      this.goneSessions.add(sessionId);
      this.outcome.delete(fire.fireId);
      return this.failAttempt(definition, fire, `session ${sessionId} no longer exists`);
    }
    if (!result.ok) {
      this.outcome.set(fire.fireId, "unreachable");
      this.log(`fire ${fire.fireId} did not run in session ${sessionId}: ${result.error}`);
      return;
    }
    await this.turnDone(fire, result.lastMessage);
  }

  /** Whether Claude Code still has the session; it cleans old ones up. */
  private sessionExists(ref: string): boolean {
    const sessionId = sessionIdOf(ref);
    if (sessionId === undefined || this.goneSessions.has(sessionId)) return false;
    const transcript = readSession(this.deps.paths, sessionId)?.transcript;
    return transcript === undefined || existsSync(transcript);
  }

  /** Returns the trigger's own Claude Code session, starting it on first use, and again once Claude Code no longer has it. */
  private ensureDedicatedSession(triggerId: string): Promise<string> {
    const { definition } = this.deps.store.loadTrigger(triggerId);
    const existing = definition.target.thread_id;
    if (existing && this.sessionExists(existing)) return Promise.resolve(existing);
    return this.createOnce(definition, () => this.startDedicatedSession(definition));
  }

  private async startDedicatedSession(definition: TriggerDefinition): Promise<string> {
    const claude = this.deps.claude?.();
    if (!claude) throw new Error("the claude CLI was not found; run `self-starter doctor`");
    const sessionId = randomUUID();
    const origin = sessionIdOf(definition.meta.origin_thread_id);
    const configDir = origin ? readSession(this.deps.paths, origin)?.configDir : undefined;
    const result = await claude.run({
      sessionId,
      start: { name: `Trigger: ${definition.name}` },
      cwd: this.cwdFor(definition),
      message: renderDedicatedSeed(definition, "session"),
      sandbox: definition.action.sandbox,
      ...(configDir ? { configDir } : {}),
      timeoutMs: Math.min(this.deps.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.ok) throw new Error(`could not start the trigger's session: ${result.error}`);
    const ref = this.bindDedicated(definition, sessionRef(sessionId));
    this.log(`dedicated session of ${definition.id}: ${sessionId}`);
    return ref;
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
    if (this.agentRunsToday() >= limit) {
      this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the daily agent budget is used up", at: this.now().toISOString() });
      await this.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.describe(fire)} (not handed to ${agentName(host)}: the daily limit of ${limit} runs is used up)`,
      });
      return;
    }
    if (host === "claude-code") return this.dispatchToSession(definition, fire);
    if (host === "zcode" || host === "opencode") return this.dispatchToCliSession(definition, fire, host);

    const codex = this.deps.codex();
    if (!codex) {
      await this.failAttempt(definition, fire, "the codex CLI was not found; run `self-starter doctor`");
      return;
    }

    const message = renderEnvelope(this.envelope(definition, fire));
    /** Queues the message into a thread: where it went, or why it could not go there. */
    const queueInto = (kind: QueuedTarget["kind"], threadId: string): Promise<QueuedTarget | string> =>
      codex.queue(threadId, message).then(
        ({ submissionId }) => ({ kind, threadId, ...(submissionId ? { submissionId } : {}) }),
        (error: Error) => error.message,
      );

    const origin = definition.target.kind === "origin" ? definition.meta.origin_thread_id : undefined;
    if (origin) {
      const sent = await queueInto("origin", origin);
      if (typeof sent !== "string") return this.queued(definition, fire, sent);
      if (!THREAD_GONE.test(sent)) return this.failAttempt(definition, fire, sent);
      this.log(`the origin thread of ${definition.id} is gone (${sent}); using a thread of its own`);
    }
    let threadId: string;
    try {
      threadId = await this.ensureDedicatedThread(definition.id, codex);
    } catch (error) {
      return this.failAttempt(definition, fire, (error as Error).message);
    }
    const sent = await queueInto("dedicated", threadId);
    if (typeof sent !== "string") return this.queued(definition, fire, sent);
    if (THREAD_GONE.test(sent)) this.forgetDedicatedThread(definition.id, threadId);
    return this.failAttempt(definition, fire, sent);
  }

  /** Records a fire as handed to Codex, and looks again once an open Codex app would have picked it up. */
  private async queued(definition: TriggerDefinition, fire: FireRecord, target: QueuedTarget): Promise<void> {
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.now().toISOString() });
    this.queuedAt.set(fire.fireId, this.uptime());
    const check = setTimeout(() => this.lookAgain(), WAKE_AFTER_MS + 1000);
    check.unref();
    this.log(`fire ${fire.fireId} queued into thread ${target.threadId}`);
    if (definition.notify.when === "always") {
      await this.sendNotification(definition, fire.fireId, { title: definition.name, body: `${this.describe(fire)} (sent to Codex)`, threadId: target.threadId });
    }
  }

  private cwdFor(definition: TriggerDefinition): string {
    return folderOrHome(definition.target.cwd);
  }

  /** Returns the dedicated thread of a trigger, creating it on first use. */
  ensureDedicatedThread(triggerId: string, codex: CodexRunner): Promise<string> {
    const { definition } = this.deps.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    return this.createOnce(definition, () => this.createDedicatedThread(definition, codex));
  }

  /** Creates the dedicated thread (or session) right after activation, so it exists before the first fire. */
  prepareDedicatedThread(triggerId: string): void {
    const host = hostFor(this.deps.store.loadTrigger(triggerId).definition);
    if (host === "zcode" || host === "opencode") {
      this.ensureCliSession(triggerId, host).catch((error: Error) => {
        this.log(`could not create the ${agentName(host)} session of ${triggerId} yet: ${error.message}`);
      });
      return;
    }
    if (host === "claude-code") {
      this.ensureDedicatedSession(triggerId).catch((error: Error) => {
        this.log(`could not start the dedicated session of ${triggerId} yet: ${error.message}`);
      });
      return;
    }
    const codex = this.deps.codex();
    if (!codex) return;
    this.ensureDedicatedThread(triggerId, codex).catch((error: Error) => {
      this.log(`could not create the dedicated thread of ${triggerId} yet: ${error.message}`);
    });
  }

  private async createDedicatedThread(definition: TriggerDefinition, codex: CodexRunner): Promise<string> {
    const result = await codex.startThread({
      cwd: this.cwdFor(definition),
      name: `Trigger: ${definition.name}`,
      prompt: renderDedicatedSeed(definition),
      timeoutMs: Math.min(this.deps.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.threadId) throw new Error(`could not create the dedicated thread: ${result.error ?? "no thread id"}`);
    const ref = this.bindDedicated(definition, result.threadId);
    this.log(`dedicated thread of ${definition.id}: ${result.threadId}`);
    return ref;
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
