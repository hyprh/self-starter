// Generic dedicated CLI session delivery strategy (Antigravity, ZCode, OpenCode,
// and any future host implementing CliSessionRunner). Zero host-specific branches:
// all naming and reference formatting come from HOST_SPECS.

import { homedir } from "node:os";
import { formatRef, hostFor, hostOf, hostSpec, parseRef, type Host } from "../../core/conversations.js";
import type { TriggerDefinition } from "../../core/definition.js";
import { renderDedicatedSeed, renderEnvelope } from "../../core/envelope.js";
import type { FireRecord } from "../fires.js";
import { BUSY_RECHECK_MS, type CliSessionRunner, type DeliveryRuntime, type HostDeliveryStrategy } from "./types.js";

export class CliSessionDeliveryStrategy implements HostDeliveryStrategy {
  private readonly activeSessions = new Set<string>();
  private readonly nextCheck = new Map<string, number>();

  constructor(
    private readonly runtime: DeliveryRuntime,
    readonly host: Host,
    private readonly getRunner: () => CliSessionRunner | undefined,
  ) {}

  forgetClosed(open: ReadonlySet<string>): void {
    for (const id of this.nextCheck.keys()) if (!open.has(id)) this.nextCheck.delete(id);
  }

  prepareDedicated(triggerId: string): void {
    const spec = hostSpec(this.host);
    this.ensureCliSession(triggerId).catch((error: Error) => {
      this.runtime.log(`could not create the ${spec.agentName} session of ${triggerId} yet: ${error.message}`);
    });
  }

  async deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    const spec = hostSpec(this.host);
    let threadId: string;
    try {
      threadId = await this.ensureCliSession(definition.id);
    } catch (error) {
      return this.runtime.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    this.runtime.fires.record({
      type: "delivered",
      fireId: fire.fireId,
      target: { kind: "dedicated", threadId },
      at: this.runtime.now().toISOString(),
    });
    this.runtime.hooks.lookAgain();
    if (definition.notify.when === "always") {
      await this.runtime.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.runtime.hooks.describe(fire)} (sent to ${spec.agentName})`,
        threadId,
      });
    }
  }

  async follow(fire: FireRecord, age: number): Promise<void> {
    const ref = fire.target?.threadId;
    if (!ref || this.activeSessions.has(ref)) return;
    const parsed = parseRef(ref);
    if (!parsed || parsed.host !== this.host) return;
    const spec = hostSpec(this.host);
    const runner = this.getRunner();
    if (fire.target?.via === undefined && runner && this.runtime.runSlotFree() && (this.nextCheck.get(fire.fireId) ?? 0) <= this.runtime.uptime()) {
      const definition = this.cliTask(fire, ref);
      if (!definition) return;
      const sessionId = parsed.id;
      this.activeSessions.add(ref);
      this.runtime.runTurn(
        fire,
        `${spec.agentName} session ${sessionId}`,
        async () => {
          const result = await runner.run({
            sessionId,
            // Do NOT fall back to homedir() via folderOrHome when target.cwd is missing on disk:
            // failing closed on ENOENT prevents widening workspace-write permissions to $HOME.
            cwd: definition.target.cwd ?? homedir(),
            message: renderEnvelope(this.runtime.hooks.envelope(definition, fire)),
            sandbox: definition.action.sandbox,
            timeoutMs: this.runtime.config.agentRunTimeoutMinutes * 60_000,
            onStart: () => {
              if (!this.cliTask(fire, ref, definition)) {
                throw new Error(`the queued ${spec.agentName} action was cancelled before execution`);
              }
              this.runtime.wentIn(fire, "headless");
              this.runtime.fires.record({ type: "woken", fireId: fire.fireId, at: this.runtime.now().toISOString() });
            },
          });
          if (result.busy) {
            this.runtime.clearOutcome(fire.fireId);
            this.nextCheck.set(fire.fireId, this.runtime.uptime() + BUSY_RECHECK_MS);
            return;
          }
          if (!result.ok) {
            if (fire.status !== "delivered") return;
            if (result.sessionGone) {
              // The CLI rejected the resume target before it ran the task. A
              // late failure must not clear a newer revision's session binding.
              const latest = this.runtime.store.hasTrigger(definition.id)
                ? this.runtime.store.loadTrigger(definition.id).definition
                : undefined;
              if (!latest || this.runtime.creationKey(latest) !== this.runtime.creationKey(definition) || latest.target.thread_id !== ref) {
                this.runtime.fires.record({
                  type: "skipped",
                  fireId: fire.fireId,
                  why: "the trigger changed before its missing result session could be replaced",
                  at: this.runtime.now().toISOString(),
                });
                this.runtime.clearOutcome(fire.fireId);
                return;
              }
              // Native installations retain their host in the origin reference.
              // An imported target-only definition must never fall back to a
              // different host when its sole host reference is cleared.
              if (hostOf(latest.meta.origin_thread_id) !== this.host) {
                throw new Error("the missing result session has no matching host origin; recreate the trigger");
              }
              this.runtime.forgetDedicatedThread(definition.id, ref);
              this.runtime.clearOutcome(fire.fireId);
              return this.runtime.hooks.failAttempt(
                definition,
                fire,
                result.error ?? `${spec.agentName} session ${sessionId} no longer exists`,
              );
            }
            // A failed start is still a failed attempt, not a reason to retry on every tick.
            if (fire.target?.via === undefined) this.runtime.wentIn(fire, "headless");
            throw new Error(result.error ?? `${spec.agentName} did not complete the turn`);
          }
          await this.runtime.completeTurn(fire, result.lastMessage);
        },
        () => this.activeSessions.delete(ref),
      );
    }
    if (this.runtime.getOutcome(fire.fireId) !== "waking") await this.runtime.hooks.remindIfLate(fire, age);
  }

  private ensureCliSession(triggerId: string): Promise<string> {
    const { definition } = this.runtime.store.loadTrigger(triggerId);
    if (definition.target.thread_id) return Promise.resolve(definition.target.thread_id);
    return this.runtime.createOnce(definition, () => this.createCliSession(definition));
  }

  private async createCliSession(definition: TriggerDefinition): Promise<string> {
    const spec = hostSpec(this.host);
    const runner = this.getRunner();
    if (!runner) throw new Error(`the ${spec.cliName} CLI was not found; run \`self-starter doctor\``);
    const result = await runner.run({
      // Intentionally preserve explicit target.cwd without folderOrHome fallback (see follow()).
      cwd: definition.target.cwd ?? homedir(),
      message: renderDedicatedSeed(definition, "session"),
      sandbox: definition.action.sandbox,
      timeoutMs: Math.min(this.runtime.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.ok || !result.sessionId) {
      throw new Error(`could not create the ${spec.agentName} session: ${result.error ?? "no session id"}`);
    }
    const ref = this.runtime.bindDedicated(definition, formatRef(this.host, result.sessionId));
    this.runtime.log(`dedicated ${spec.agentName} session of ${definition.id}: ${result.sessionId}`);
    return ref;
  }

  /** A queued fire can outlive the action or session it was delivered to. */
  private cliTask(fire: FireRecord, ref: string, expected?: TriggerDefinition): TriggerDefinition | undefined {
    if (fire.status !== "delivered" || fire.target?.via !== undefined) {
      this.runtime.clearOutcome(fire.fireId);
      return undefined;
    }
    const definition = this.runtime.store.hasTrigger(fire.triggerId)
      ? this.runtime.store.loadTrigger(fire.triggerId).definition
      : undefined;
    if (
      definition?.action.type === "agent" &&
      hostFor(definition) === this.host &&
      definition.target.kind === "dedicated" &&
      definition.target.thread_id === ref &&
      (!expected ||
        (definition.action.sandbox === expected.action.sandbox &&
          definition.action.prompt === expected.action.prompt &&
          (definition.target.cwd ?? homedir()) === (expected.target.cwd ?? homedir())))
    ) {
      return definition;
    }
    this.runtime.fires.record({
      type: "skipped",
      fireId: fire.fireId,
      why: definition
        ? "the trigger's action or result session changed before execution"
        : "the trigger was deleted",
      at: this.runtime.now().toISOString(),
    });
    this.runtime.clearOutcome(fire.fireId);
    this.runtime.hooks.kick();
    return undefined;
  }
}
