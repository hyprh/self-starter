// Codex thread delivery strategy: `codex queue` into origin or dedicated threads,
// plus background `codex app-server` inspection and waking when no Codex app has the thread open.

import type { TriggerDefinition } from "../../core/definition.js";
import { renderDedicatedSeed, renderEnvelope } from "../../core/envelope.js";
import type { CodexRunner } from "../codex.js";
import type { FireRecord } from "../fires.js";
import { BUSY_RECHECK_MS, type DeliveryRuntime, type HostDeliveryStrategy, type QueuedTarget } from "./types.js";

/**
 * Codex looks for messages queued from outside every 10 seconds, so after this
 * long without a pick-up no Codex app has the thread open. Counted on a clock
 * that stops while the computer sleeps, so an app waking up with it gets its turn.
 */
const WAKE_AFTER_MS = 20_000;
/** Errors from codex that mean the thread no longer exists. */
const THREAD_GONE = /archived|not found|no such|unknown thread|does not exist/i;
/** What codex answers when another process, such as a Codex app, has the thread open. */
const OPEN_ELSEWHERE = /active writer/i;

export class CodexDeliveryStrategy implements HostDeliveryStrategy {
  readonly host = "codex" as const;
  private readonly queuedAt = new Map<string, number>();
  private readonly nextCheck = new Map<string, number>();

  constructor(
    private readonly runtime: DeliveryRuntime,
    private readonly getCodex: () => CodexRunner | undefined,
  ) {}

  waitsForEntry(): boolean {
    return false;
  }

  forgetClosed(open: ReadonlySet<string>): void {
    for (const id of this.queuedAt.keys()) if (!open.has(id)) this.queuedAt.delete(id);
    for (const id of this.nextCheck.keys()) if (!open.has(id)) this.nextCheck.delete(id);
  }

  prepareDedicated(triggerId: string): void {
    const codex = this.getCodex();
    if (!codex) return;
    this.ensureDedicatedThread(triggerId, codex).catch((error: Error) => {
      this.runtime.log(`could not create the dedicated thread of ${triggerId} yet: ${error.message}`);
    });
  }

  async deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    const codex = this.getCodex();
    if (!codex) {
      await this.runtime.hooks.failAttempt(definition, fire, "the codex CLI was not found; run `self-starter doctor`");
      return;
    }

    const message = renderEnvelope(this.runtime.hooks.envelope(definition, fire));
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
      if (!THREAD_GONE.test(sent)) return this.runtime.hooks.failAttempt(definition, fire, sent);
      this.runtime.log(`the origin thread of ${definition.id} is gone (${sent}); using a thread of its own`);
    }
    let threadId: string;
    try {
      threadId = await this.ensureDedicatedThread(definition.id, codex);
    } catch (error) {
      return this.runtime.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    const sent = await queueInto("dedicated", threadId);
    if (typeof sent !== "string") return this.queued(definition, fire, sent);
    if (THREAD_GONE.test(sent)) this.runtime.forgetDedicatedThread(definition.id, threadId);
    return this.runtime.hooks.failAttempt(definition, fire, sent);
  }

  async follow(fire: FireRecord, age: number): Promise<void> {
    const outcome = this.runtime.getOutcome(fire.fireId);
    // The trigger's own thread is always woken; the user can keep Self-Starter out of their own threads.
    const wake = fire.target?.kind === "dedicated" || this.runtime.config.wakeClosedThreads;
    if (wake && (outcome === undefined || outcome === "open")) {
      const uptime = this.runtime.uptime();
      if (!this.queuedAt.has(fire.fireId)) this.queuedAt.set(fire.fireId, uptime); // queued before a restart
      const waited = uptime - this.queuedAt.get(fire.fireId)!;
      if (waited >= WAKE_AFTER_MS && (this.nextCheck.get(fire.fireId) ?? 0) <= uptime) {
        this.startWake(fire);
        return;
      }
      if (outcome === undefined) return;
    }
    // The fire is still waiting in the thread: tell the user after a while.
    if (!wake || outcome === "open" || outcome === "unreachable") {
      await this.runtime.hooks.remindIfLate(fire, age);
    }
  }

  /** Records a fire as handed to Codex, and looks again once an open Codex app would have picked it up. */
  private async queued(definition: TriggerDefinition, fire: FireRecord, target: QueuedTarget): Promise<void> {
    this.runtime.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.runtime.now().toISOString() });
    this.queuedAt.set(fire.fireId, this.runtime.uptime());
    const check = setTimeout(() => this.runtime.hooks.lookAgain(), WAKE_AFTER_MS + 1000);
    check.unref();
    this.runtime.log(`fire ${fire.fireId} queued into thread ${target.threadId}`);
    if (definition.notify.when === "always") {
      await this.runtime.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.runtime.hooks.describe(fire)} (sent to Codex)`,
        threadId: target.threadId,
      });
    }
  }

  private ensureDedicatedThread(triggerId: string, codex: CodexRunner): Promise<string> {
    const { definition } = this.runtime.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    return this.runtime.createOnce(definition, () => this.createDedicatedThread(definition, codex));
  }

  private async createDedicatedThread(definition: TriggerDefinition, codex: CodexRunner): Promise<string> {
    const result = await codex.startThread({
      cwd: this.runtime.cwdFor(definition),
      name: `Trigger: ${definition.name}`,
      prompt: renderDedicatedSeed(definition),
      timeoutMs: Math.min(this.runtime.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.threadId) throw new Error(`could not create the dedicated thread: ${result.error ?? "no thread id"}`);
    const ref = this.runtime.bindDedicated(definition, result.threadId);
    this.runtime.log(`dedicated thread of ${definition.id}: ${result.threadId}`);
    return ref;
  }

  private startWake(fire: FireRecord): void {
    const codex = this.getCodex();
    const threadId = fire.target?.threadId;
    if (!codex || !threadId || !this.runtime.store.hasTrigger(fire.triggerId)) {
      this.runtime.setOutcome(fire.fireId, "unreachable");
      return;
    }
    if (!this.runtime.runSlotFree()) return; // next tick
    this.runtime.runTurn(fire, `thread ${threadId}`, () => this.wake(fire, threadId, codex));
  }

  /** Runs a fire in its thread when no Codex app picked it up, so the conversation reacts even while the app is closed. */
  private async wake(fire: FireRecord, threadId: string, codex: CodexRunner): Promise<void> {
    const view = await codex.inspectThread(threadId, fire.fireId);
    if (view.mentions) {
      this.runtime.setOutcome(fire.fireId, "picked-up"); // an open Codex app is on it
      return;
    }
    if (view.busy) {
      // Someone is in the middle of a turn there; the queued message runs after it.
      this.runtime.clearOutcome(fire.fireId);
      this.nextCheck.set(fire.fireId, this.runtime.uptime() + BUSY_RECHECK_MS);
      return;
    }
    const own = fire.target?.kind === "dedicated";
    const submissionId = fire.target?.submissionId;
    // A stopped turn (Stop, or the app closed in the middle of one) makes Codex hold the thread's queue.
    // The fire is started anyway, unless messages of the user's are held there too: those wait for the user.
    if (view.paused && (!submissionId || (!own && view.holdsOthers))) return this.waitInPausedThread(fire);
    const { definition } = this.runtime.store.loadTrigger(fire.triggerId);
    this.runtime.log(`no Codex app has thread ${threadId} open; running fire ${fire.fireId} there`);
    const result = await codex.wakeThread({
      threadId,
      marker: fire.fireId,
      sandbox: definition.action.sandbox,
      // The trigger's own thread follows target.cwd; a thread of the user's keeps its folder.
      ...(own ? { cwd: this.runtime.cwdFor(definition) } : {}),
      ...(view.paused ? { startQueued: submissionId } : {}),
      onOpen: () => this.runtime.fires.record({ type: "woken", fireId: fire.fireId, at: this.runtime.now().toISOString() }),
      timeoutMs: this.runtime.config.agentRunTimeoutMinutes * 60_000,
    });
    if (!result.ok && OPEN_ELSEWHERE.test(result.error ?? "")) {
      // A Codex app has the thread open after all. With the queue held, the user is there to continue it.
      if (view.paused) return this.waitInPausedThread(fire);
      // Otherwise the app runs the fire; look again in case it lets go of the thread first.
      this.runtime.setOutcome(fire.fireId, "open");
      this.nextCheck.set(fire.fireId, this.runtime.uptime() + BUSY_RECHECK_MS);
      return;
    }
    if (!result.ok) {
      this.runtime.setOutcome(fire.fireId, "unreachable");
      this.runtime.log(`fire ${fire.fireId} did not run in thread ${threadId}: ${result.error}`);
      return;
    }
    await this.runtime.completeTurn(fire, result.lastMessage);
  }

  /** The fire stays queued in a thread where Codex was stopped, and runs when the user continues there; the user is told now. */
  private async waitInPausedThread(fire: FireRecord): Promise<void> {
    this.runtime.setOutcome(fire.fireId, "paused");
    await this.runtime.hooks.remindPaused(
      fire,
      "waiting in your thread: Codex was stopped there, so it runs when you continue the conversation",
    );
  }
}
