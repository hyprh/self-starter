// Host-agnostic delivery coordinator and strategy registry.
// Executor interacts only with HostDelivery's minimal coordinator facade;
// strategies receive a private DeliveryRuntime view for shared run-slot and
// dedicated session binding primitives.

import { conversationNoun, hostFor, hostOf, type Host } from "../core/conversations.js";
import type { TriggerDefinition } from "../core/definition.js";
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
  type HostDeliveryStrategyFactory,
  type HostDeliveryStrategyInput,
  type QueuedOutcome,
} from "./delivery/types.js";
import type { ExecutorDeps } from "./executor.js";
import type { FireRecord } from "./fires.js";

export type {
  CliSessionRunOptions,
  CliSessionRunner,
  CliSessionTurnResult,
  DeliveryRuntime,
  HostDeliveryHooks,
  HostDeliveryStrategy,
  HostDeliveryStrategyFactory,
  HostDeliveryStrategyInput,
  QueuedOutcome,
};

export class HostDelivery {
  private readonly strategies = new Map<Host, HostDeliveryStrategy>();
  private readonly outcome = new Map<string, QueuedOutcome>();
  private readonly threadCreation = new Map<string, Promise<string>>();
  private readonly runtime: DeliveryRuntime;
  private activeAgentRuns = 0;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly hooks: HostDeliveryHooks,
    customStrategies?: Iterable<HostDeliveryStrategyInput>,
  ) {
    this.runtime = this.createRuntime();
    const defaults: HostDeliveryStrategy[] = [
      new CodexDeliveryStrategy(this.runtime, deps.codex),
      new ClaudeDeliveryStrategy(this.runtime, () => deps.claude?.(), deps.deliverToSession),
      new CliSessionDeliveryStrategy(this.runtime, "antigravity", () => deps.antigravity?.()),
      new CliSessionDeliveryStrategy(this.runtime, "zcode", () => deps.zcode?.()),
      new CliSessionDeliveryStrategy(this.runtime, "opencode", () => deps.opencode?.()),
    ];
    for (const strategy of defaults) this.strategies.set(strategy.host, strategy);
    if (deps.strategies) {
      for (const entry of deps.strategies) this.registerStrategy(entry);
    }
    if (customStrategies) {
      for (const entry of customStrategies) this.registerStrategy(entry);
    }
  }

  get activeRuns(): number {
    return this.activeAgentRuns;
  }

  registerStrategy(entry: HostDeliveryStrategyInput): void {
    const strategy = typeof entry === "function" ? entry(this.runtime) : entry;
    this.strategies.set(strategy.host, strategy);
  }

  /** Whether a delivered fire is still waiting to enter its host conversation before its receipt clock starts. */
  isWaitingForEntry(fire: FireRecord): boolean {
    const strategy = this.strategyFor(hostOf(fire.target?.threadId));
    return strategy.waitsForEntry ? strategy.waitsForEntry(fire) : fire.target?.via === undefined;
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

  private strategyFor(host: Host): HostDeliveryStrategy {
    const strategy = this.strategies.get(host);
    if (!strategy) throw new Error(`no delivery strategy registered for host "${host}"`);
    return strategy;
  }

  private createRuntime(): DeliveryRuntime {
    const { deps, hooks } = this;
    return {
      get store() {
        return deps.store;
      },
      get fires() {
        return deps.fires;
      },
      get paths() {
        return deps.paths;
      },
      get config() {
        return deps.config;
      },
      hooks,
      now: () => this.now(),
      uptime: () => this.uptime(),
      log: (line) => this.log(line),
      cwdFor: (definition) => folderOrHome(definition.target.cwd),
      getOutcome: (fireId) => this.outcome.get(fireId),
      setOutcome: (fireId, outcome) => {
        this.outcome.set(fireId, outcome);
      },
      clearOutcome: (fireId) => {
        this.outcome.delete(fireId);
      },
      runSlotFree: () => this.runSlotFree(),
      runTurn: (fire, where, run, finished) => this.runTurn(fire, where, run, finished),
      completeTurn: (fire, lastMessage) => this.completeTurn(fire, lastMessage),
      creationKey: (definition) => this.creationKey(definition),
      createOnce: (definition, create) => this.createOnce(definition, create),
      bindDedicated: (definition, ref) => this.bindDedicated(definition, ref),
      forgetDedicatedThread: (triggerId, threadId) => this.forgetDedicatedThread(triggerId, threadId),
      wentIn: (fire, via) => this.wentIn(fire, via),
    };
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
    if (this.creationKey(latest) !== this.creationKey(definition)) {
      throw new Error("the trigger changed while its result session was being created");
    }
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
    const noun = conversationNoun(hostOf(threadId));
    this.log(`the dedicated ${noun} ${threadId} of ${triggerId} is gone; a new one will be created`);
  }

  /** Records how a fire handed to a session went into it; the time it waits for a receipt starts now. */
  private wentIn(fire: FireRecord, via: "inbox" | "headless"): void {
    this.deps.fires.record({
      type: "delivered",
      fireId: fire.fireId,
      target: { ...fire.target!, via },
      at: this.now().toISOString(),
    });
  }
}
