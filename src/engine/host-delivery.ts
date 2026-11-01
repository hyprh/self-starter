// Host-specific conversation creation, fire delivery, and background turn
// execution across Codex threads, Claude Code sessions, and ZCode / OpenCode
// CLI sessions. Executor owns budgets, concurrency policies, retries, receipts,
// reminders, and quiet hours; HostDelivery owns talking to each host.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  agentName,
  hostFor,
  hostOf,
  opencodeRef,
  opencodeSessionIdOf,
  sessionIdOf,
  sessionRef,
  zcodeRef,
  zcodeSessionIdOf,
} from "../core/conversations.js";
import { renderDedicatedSeed, renderEnvelope, type EnvelopeInput } from "../core/envelope.js";
import type { TriggerDefinition } from "../core/definition.js";
import type { CodexRunner } from "./codex.js";
import type { ExecutorDeps } from "./executor.js";
import type { FireRecord } from "./fires.js";
import type { Notification } from "./notify.js";
import { deliverToOpenSession, lastWritten, readSession, type SessionRunner } from "./sessions.js";

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

/** The folder, while it exists; the home folder otherwise. */
function folderOrHome(folder: string | null | undefined): string {
  return folder && existsSync(folder) ? folder : homedir();
}

export interface HostDeliveryHooks {
  envelope: (definition: TriggerDefinition, fire: FireRecord) => EnvelopeInput;
  describe: (fire: FireRecord) => string;
  failAttempt: (definition: TriggerDefinition, fire: FireRecord, error: string) => Promise<void>;
  turnDone: (fire: FireRecord, lastMessage: string | undefined) => Promise<void>;
  remindIfLate: (fire: FireRecord, age: number) => Promise<void>;
  remindPaused: (fire: FireRecord, note: string) => Promise<void>;
  sendNotification: (definition: TriggerDefinition, fireId: string, notification: Notification) => Promise<void>;
  lookAgain: () => void;
  kick: () => void;
}

export class HostDelivery {
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

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly hooks: HostDeliveryHooks,
  ) {}

  get activeRuns(): number {
    return this.activeAgentRuns;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private uptime(): number {
    return this.deps.uptime?.() ?? performance.now();
  }

  private log(line: string): void {
    this.deps.log(line);
  }

  private cwdFor(definition: TriggerDefinition): string {
    return folderOrHome(definition.target.cwd);
  }

  /** Drops per-fire host state for fires that are no longer waiting for a receipt. */
  forgetClosed(open: Set<string>): void {
    for (const id of this.queuedAt.keys()) if (!open.has(id)) this.queuedAt.delete(id);
    for (const id of this.outcome.keys()) if (!open.has(id) && this.outcome.get(id) !== "waking") this.outcome.delete(id);
    for (const id of this.nextCheck.keys()) if (!open.has(id)) this.nextCheck.delete(id);
  }

  /** Creates the dedicated thread (or session) right after activation, so it exists before the first fire. */
  prepareDedicated(triggerId: string): void {
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

  /** Hands an agent fire to its host conversation (or records it for the next free turn). */
  async deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    const host = hostFor(definition);
    if (host === "claude-code") return this.dispatchToSession(definition, fire);
    if (host === "zcode" || host === "opencode") return this.dispatchToCliSession(definition, fire, host);
    return this.dispatchToCodex(definition, fire);
  }

  /** A fire handed to a conversation is still open: enter/wake the conversation or remind the user. */
  async follow(fire: FireRecord, age: number): Promise<void> {
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
    if (!wake || outcome === "open" || outcome === "unreachable") await this.hooks.remindIfLate(fire, age);
  }

  // ---- Shared run-slot & dedicated binding helpers ------------------------

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
        this.hooks.lookAgain(); // another fire may be waiting for the slot
      });
  }

  private async completeTurn(fire: FireRecord, lastMessage: string | undefined): Promise<void> {
    this.outcome.set(fire.fireId, "woken");
    await this.hooks.turnDone(fire, lastMessage);
  }

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

  private forgetDedicatedThread(triggerId: string, threadId: string): void {
    if (!this.deps.store.hasTrigger(triggerId)) return;
    const latest = this.deps.store.loadTrigger(triggerId).definition;
    if (latest.target.thread_id !== threadId) return;
    latest.target.thread_id = null;
    this.deps.store.saveDefinition(latest);
    this.log(`the dedicated thread ${threadId} of ${triggerId} is gone; a new one will be created`);
  }

  /** Records how a fire handed to a session went into it; the time it waits for a receipt starts now. */
  private wentIn(fire: FireRecord, via: "inbox" | "headless"): void {
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { ...fire.target!, via }, at: this.now().toISOString() });
  }

  // ---- Codex threads ------------------------------------------------------

  private async dispatchToCodex(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    const codex = this.deps.codex();
    if (!codex) {
      await this.hooks.failAttempt(definition, fire, "the codex CLI was not found; run `self-starter doctor`");
      return;
    }

    const message = renderEnvelope(this.hooks.envelope(definition, fire));
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
      if (!THREAD_GONE.test(sent)) return this.hooks.failAttempt(definition, fire, sent);
      this.log(`the origin thread of ${definition.id} is gone (${sent}); using a thread of its own`);
    }
    let threadId: string;
    try {
      threadId = await this.ensureDedicatedThread(definition.id, codex);
    } catch (error) {
      return this.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    const sent = await queueInto("dedicated", threadId);
    if (typeof sent !== "string") return this.queued(definition, fire, sent);
    if (THREAD_GONE.test(sent)) this.forgetDedicatedThread(definition.id, threadId);
    return this.hooks.failAttempt(definition, fire, sent);
  }

  /** Records a fire as handed to Codex, and looks again once an open Codex app would have picked it up. */
  private async queued(definition: TriggerDefinition, fire: FireRecord, target: QueuedTarget): Promise<void> {
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.now().toISOString() });
    this.queuedAt.set(fire.fireId, this.uptime());
    const check = setTimeout(() => this.hooks.lookAgain(), WAKE_AFTER_MS + 1000);
    check.unref();
    this.log(`fire ${fire.fireId} queued into thread ${target.threadId}`);
    if (definition.notify.when === "always") {
      await this.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.hooks.describe(fire)} (sent to Codex)`,
        threadId: target.threadId,
      });
    }
  }

  private ensureDedicatedThread(triggerId: string, codex: CodexRunner): Promise<string> {
    const { definition } = this.deps.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    return this.createOnce(definition, () => this.createDedicatedThread(definition, codex));
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
    await this.completeTurn(fire, result.lastMessage);
  }

  /** The fire stays queued in a thread where Codex was stopped, and runs when the user continues there; the user is told now. */
  private async waitInPausedThread(fire: FireRecord): Promise<void> {
    this.outcome.set(fire.fireId, "paused");
    await this.hooks.remindPaused(fire, "waiting in your thread: Codex was stopped there, so it runs when you continue the conversation");
  }

  // ---- Dedicated CLI sessions (ZCode & OpenCode) --------------------------

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
      return this.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target: { kind: "dedicated", threadId }, at: this.now().toISOString() });
    this.hooks.lookAgain();
    if (definition.notify.when === "always") {
      await this.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.hooks.describe(fire)} (sent to ${agentName(host)})`,
        threadId,
      });
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
    this.hooks.kick();
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
          message: renderEnvelope(this.hooks.envelope(definition, fire)),
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
          if (result.sessionGone) {
            // The CLI rejected the resume target before it ran the task. A
            // late failure must not clear a newer revision's session binding.
            const latest = this.deps.store.hasTrigger(definition.id) ? this.deps.store.loadTrigger(definition.id).definition : undefined;
            if (!latest || this.creationKey(latest) !== this.creationKey(definition) || latest.target.thread_id !== ref) {
              this.deps.fires.record({ type: "skipped", fireId: fire.fireId, why: "the trigger changed before its missing result session could be replaced", at: this.now().toISOString() });
              this.outcome.delete(fire.fireId);
              return;
            }
            // Native installations retain their host in the origin reference.
            // An imported target-only definition must never fall back to a
            // different host when its sole host reference is cleared.
            if (hostOf(latest.meta.origin_thread_id) !== host) throw new Error("the missing result session has no matching host origin; recreate the trigger");
            this.forgetDedicatedThread(definition.id, ref);
            this.outcome.delete(fire.fireId);
            return this.hooks.failAttempt(definition, fire, result.error ?? `${agentName(host)} session ${sessionId} no longer exists`);
          }
          // A failed start is still a failed attempt, not a reason to retry on every tick.
          if (fire.target?.via === undefined) this.wentIn(fire, "headless");
          throw new Error(result.error ?? `${agentName(host)} did not complete the turn`);
        }
        await this.completeTurn(fire, result.lastMessage);
      }, () => this.headlessSessions.delete(ref));
    }
    if (this.outcome.get(fire.fireId) !== "waking") await this.hooks.remindIfLate(fire, age);
  }

  // ---- Claude Code sessions -----------------------------------------------

  /** A fire for a trigger made in Claude Code: handed to the session it was made in, or to the trigger's own. */
  private async dispatchToSession(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    let target: QueuedTarget;
    try {
      target = await this.sessionFor(definition);
    } catch (error) {
      return this.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    // Handed over: it goes into the session once no turn runs there (followSession).
    this.deps.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.now().toISOString() });
    this.hooks.lookAgain();
    if (definition.notify.when === "always") {
      await this.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.hooks.describe(fire)} (sent to Claude)`,
        threadId: target.threadId,
      });
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
    if (this.outcome.get(fire.fireId) !== "waking") await this.hooks.remindIfLate(fire, age);
  }

  /** Puts a fire into its session if no turn runs there: true when it went in, or started running there. */
  private async bringIntoSession(fire: FireRecord): Promise<boolean> {
    const sessionId = sessionIdOf(fire.target?.threadId)!;
    if (this.headlessSessions.has(sessionId) || this.sessionBusy(sessionId) || !this.deps.store.hasTrigger(fire.triggerId)) return false;
    const { definition } = this.deps.store.loadTrigger(fire.triggerId);
    const message = renderEnvelope(this.hooks.envelope(definition, fire));
    const how = await this.deliverToSession(sessionId, message).catch((error: Error) => {
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
  private deliverToSession(sessionId: string, text: string): Promise<"relayed" | "posted" | undefined> {
    return this.deps.deliverToSession?.(sessionId, text) ?? deliverToOpenSession(this.deps.paths, sessionId, text, (line) => this.log(line));
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
      fireId: fire.fireId,
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
      return this.hooks.failAttempt(definition, fire, `session ${sessionId} no longer exists`);
    }
    if (!result.ok) {
      this.outcome.set(fire.fireId, "unreachable");
      this.log(`fire ${fire.fireId} did not run in session ${sessionId}: ${result.error}`);
      return;
    }
    await this.completeTurn(fire, result.lastMessage);
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
}
