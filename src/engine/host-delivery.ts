// Host-agnostic delivery coordinator and strategy registry.
// Executor owns budgets, concurrency policies, retries, receipts, reminders,
// and quiet hours; HostDelivery provides shared run-slot / session-binding
// primitives (DeliveryRuntime) and dispatches each host's lifecycle to its
// registered HostDeliveryStrategy.

import { hostFor, hostOf, type Host } from "../core/conversations.js";
import type { TriggerDefinition } from "../core/definition.js";
import type { Config } from "./config.js";
import { ClaudeDeliveryStrategy } from "./delivery/claude-delivery.js";
import { CliSessionDeliveryStrategy } from "./delivery/cli-session-delivery.js";
import { CodexDeliveryStrategy } from "./delivery/codex-delivery.js";
import {
  folderOrHome,
  type CliSessionRunOptions,
  type CliSessionRunner,
  type CliSessionTurnResult,
  type DeliveryRuntime,
  type HostDeliveryHooks,
  type HostDeliveryStrategy,
  type QueuedOutcome,
} from "./delivery/types.js";
import type { ExecutorDeps } from "./executor.js";
import type { FireLog, FireRecord } from "./fires.js";
import type { Paths } from "./paths.js";
import type { Store } from "./store.js";

export type {
  CliSessionRunOptions,
  CliSessionRunner,
  CliSessionTurnResult,
  DeliveryRuntime,
  HostDeliveryHooks,
  HostDeliveryStrategy,
  QueuedOutcome,
};

export class HostDelivery implements DeliveryRuntime {
  private readonly strategies = new Map<Host, HostDeliveryStrategy>();
  private readonly outcome = new Map<string, QueuedOutcome>();
  private readonly threadCreation = new Map<string, Promise<string>>();
  private activeAgentRuns = 0;

  constructor(
    private readonly deps: ExecutorDeps,
    readonly hooks: HostDeliveryHooks,
    customStrategies?: Iterable<HostDeliveryStrategy>,
  ) {
    const defaults: HostDeliveryStrategy[] = [
      new CodexDeliveryStrategy(this, deps.codex),
      new ClaudeDeliveryStrategy(this, () => deps.claude?.(), deps.deliverToSession),
      new CliSessionDeliveryStrategy(this, "antigravity", () => deps.antigravity?.()),
      new CliSessionDeliveryStrategy(this, "zcode", () => deps.zcode?.()),
      new CliSessionDeliveryStrategy(this, "opencode", () => deps.opencode?.()),
    ];
    for (const strategy of defaults) this.strategies.set(strategy.host, strategy);
    if (deps.strategies) {
      for (const strategy of deps.strategies) this.strategies.set(strategy.host, strategy);
    }
    if (customStrategies) {
      for (const strategy of customStrategies) this.strategies.set(strategy.host, strategy);
    }
  }

  get store(): Store {
    return this.deps.store;
  }

  get fires(): FireLog {
    return this.deps.fires;
  }

  get paths(): Paths {
    return this.deps.paths;
  }

  get config(): Config {
    return this.deps.config;
  }

  get activeRuns(): number {
    return this.activeAgentRuns;
  }

  registerStrategy(strategy: HostDeliveryStrategy): void {
    this.strategies.set(strategy.host, strategy);
  }

  private strategyFor(host: Host): HostDeliveryStrategy {
    const strategy = this.strategies.get(host);
    if (!strategy) throw new Error(`no delivery strategy registered for host "${host}"`);
    return strategy;
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  uptime(): number {
    return this.deps.uptime?.() ?? performance.now();
  }

  log(line: string): void {
    this.deps.log(line);
  }

  cwdFor(definition: TriggerDefinition): string {
    return folderOrHome(definition.target.cwd);
  }

  getOutcome(fireId: string): QueuedOutcome | undefined {
    return this.outcome.get(fireId);
  }

  setOutcome(fireId: string, outcome: QueuedOutcome): void {
    this.outcome.set(fireId, outcome);
  }

  clearOutcome(fireId: string): void {
    this.outcome.delete(fireId);
  }

  /** Drops per-fire host state for fires that are no longer waiting for a receipt. */
  forgetClosed(open: ReadonlySet<string>): void {
    for (const id of this.outcome.keys()) {
      if (!open.has(id) && this.outcome.get(id) !== "waking") this.outcome.delete(id);
    }
    for (const strategy of this.strategies.values()) {
      strategy.forgetClosed?.(open);
    }
  }

  /** Creates the dedicated thread (or session) right after activation, so it exists before the first fire. */
  prepareDedicated(triggerId: string): void {
    const host = hostFor(this.deps.store.loadTrigger(triggerId).definition);
    this.strategyFor(host).prepareDedicated(triggerId);
  }

  /** Hands an agent fire to its host conversation (or records it for the next free turn). */
  async deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    await this.strategyFor(hostFor(definition)).deliver(definition, fire);
  }

  /** A fire handed to a conversation is still open: enter/wake the conversation or remind the user. */
  async follow(fire: FireRecord, age: number): Promise<void> {
    await this.strategyFor(hostOf(fire.target?.threadId)).follow(fire, age);
  }

  // ---- Shared run-slot & dedicated binding primitives ---------------------

  /** Whether budget.maxConcurrentAgentRuns leaves room for another turn of ours. */
  runSlotFree(): boolean {
    return this.activeAgentRuns < this.deps.config.budget.maxConcurrentAgentRuns;
  }

  /** Runs a turn for a fire in a run slot, in the background: the fire is waking meanwhile, and unreachable if the run breaks. */
  runTurn(fire: FireRecord, where: string, run: () => Promise<void>, finished?: () => void): void {
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

  async completeTurn(fire: FireRecord, lastMessage: string | undefined): Promise<void> {
    this.outcome.set(fire.fireId, "woken");
    await this.hooks.turnDone(fire, lastMessage);
  }

  creationKey(definition: TriggerDefinition): string {
    return JSON.stringify([definition.id, definition.meta.created_at, definition.meta.revision, hostFor(definition)]);
  }

  createOnce(definition: TriggerDefinition, create: () => Promise<string>): Promise<string> {
    const key = this.creationKey(definition);
    let pending = this.threadCreation.get(key);
    if (!pending) {
      pending = create().finally(() => this.threadCreation.delete(key));
      this.threadCreation.set(key, pending);
    }
    return pending;
  }

  bindDedicated(definition: TriggerDefinition, ref: string): string {
    const latest = this.deps.store.loadTrigger(definition.id).definition;
    if (this.creationKey(latest) !== this.creationKey(definition)) {
      throw new Error("the trigger changed while its result session was being created");
    }
    if (!latest.target.thread_id || latest.target.thread_id === definition.target.thread_id) {
      latest.target.thread_id = ref;
      this.deps.store.saveDefinition(latest);
    }
    return latest.target.thread_id;
  }

  forgetDedicatedThread(triggerId: string, threadId: string): void {
    if (!this.deps.store.hasTrigger(triggerId)) return;
    const latest = this.deps.store.loadTrigger(triggerId).definition;
    if (latest.target.thread_id !== threadId) return;
    latest.target.thread_id = null;
    this.deps.store.saveDefinition(latest);
    this.log(`the dedicated thread ${threadId} of ${triggerId} is gone; a new one will be created`);
  }

  /** Records how a fire handed to a session went into it; the time it waits for a receipt starts now. */
  wentIn(fire: FireRecord, via: "inbox" | "headless"): void {
    this.deps.fires.record({
      type: "delivered",
      fireId: fire.fireId,
      target: { ...fire.target!, via },
      at: this.now().toISOString(),
    });
  }
}
