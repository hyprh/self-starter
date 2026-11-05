// Claude Code session delivery strategy: relays or posts into an open session's
// inbox when idle, or resumes the session headlessly (`claude -p`) when closed.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { sessionIdOf, sessionRef } from "../../core/conversations.js";
import type { TriggerDefinition } from "../../core/definition.js";
import { renderDedicatedSeed, renderEnvelope } from "../../core/envelope.js";
import type { FireRecord } from "../fires.js";
import { deliverToOpenSession, lastWritten, readSession, type SessionRunner } from "../sessions.js";
import { folderOrHome, type DeliveryRuntime, type HostDeliveryStrategy, type QueuedTarget } from "./types.js";

/** What claude -p answers for a session that no longer exists. */
const SESSION_GONE = /No conversation found/i;
/**
 * A turn the hooks still see running is over once its session has written nothing for this long: a turn the
 * user interrupted runs no hook, and neither does a Claude Code that crashed. A turn at work writes as it goes.
 */
const TURN_QUIET_MS = 15 * 60_000;
/** How long a fire just posted into a session counts as a turn there, before the session reports one. */
const POST_GRACE_MS = 60_000;

export class ClaudeDeliveryStrategy implements HostDeliveryStrategy {
  readonly host = "claude-code" as const;
  private readonly headlessSessions = new Set<string>();
  private readonly goneSessions = new Set<string>();
  private readonly postedAt = new Map<string, number>();

  constructor(
    private readonly runtime: DeliveryRuntime,
    private readonly getClaude: () => SessionRunner | undefined,
    private readonly customDeliverToSession?: (sessionId: string, text: string) => Promise<"relayed" | "posted" | undefined>,
  ) {}

  prepareDedicated(triggerId: string): void {
    this.ensureDedicatedSession(triggerId).catch((error: Error) => {
      this.runtime.log(`could not start the dedicated session of ${triggerId} yet: ${error.message}`);
    });
  }

  async deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void> {
    let target: QueuedTarget;
    try {
      target = await this.sessionFor(definition);
    } catch (error) {
      return this.runtime.hooks.failAttempt(definition, fire, (error as Error).message);
    }
    // Handed over: it goes into the session once no turn runs there (follow).
    this.runtime.fires.record({ type: "delivered", fireId: fire.fireId, target, at: this.runtime.now().toISOString() });
    this.runtime.hooks.lookAgain();
    if (definition.notify.when === "always") {
      await this.runtime.hooks.sendNotification(definition, fire.fireId, {
        title: definition.name,
        body: `${this.runtime.hooks.describe(fire)} (sent to Claude)`,
        threadId: target.threadId,
      });
    }
  }

  /**
   * A fire handed to a Claude Code session is still open. Until it is in the session, it goes in as soon as
   * no turn runs there, the way a message queued in Codex waits for the turn in progress: into the process
   * that shows the session, or as a headless turn when none does. Then the user hears about it if no reply comes.
   */
  async follow(fire: FireRecord, age: number): Promise<void> {
    if (fire.target?.via === undefined && (await this.bringIntoSession(fire))) return;
    if (this.runtime.getOutcome(fire.fireId) !== "waking") await this.runtime.hooks.remindIfLate(fire, age);
  }

  /** Where a fire of the trigger goes: the session it was made in while Claude Code has it, the trigger's own otherwise. */
  private async sessionFor(definition: TriggerDefinition): Promise<QueuedTarget> {
    const origin = definition.target.kind === "origin" ? definition.meta.origin_thread_id : undefined;
    if (origin && this.sessionExists(origin)) return { kind: "origin", threadId: origin };
    if (origin) this.runtime.log(`the origin session of ${definition.id} is gone; using a session of its own`);
    return { kind: "dedicated", threadId: await this.ensureDedicatedSession(definition.id) };
  }

  /** Puts a fire into its session if no turn runs there: true when it went in, or started running there. */
  private async bringIntoSession(fire: FireRecord): Promise<boolean> {
    const sessionId = sessionIdOf(fire.target?.threadId)!;
    if (this.headlessSessions.has(sessionId) || this.sessionBusy(sessionId) || !this.runtime.store.hasTrigger(fire.triggerId)) return false;
    const { definition } = this.runtime.store.loadTrigger(fire.triggerId);
    const message = renderEnvelope(this.runtime.hooks.envelope(definition, fire));
    const how = await this.deliverToSession(sessionId, message).catch((error: Error) => {
      this.runtime.log(`could not deliver into session ${sessionId}: ${error.message}`);
      return undefined;
    });
    if (!how) return this.startHeadless(definition, fire, sessionId, message);
    this.postedAt.set(sessionId, this.runtime.now().getTime());
    this.runtime.wentIn(fire, "inbox");
    this.runtime.log(`fire ${fire.fireId} ${how} into session ${sessionId}`);
    return true;
  }

  /** Hands a message to a Claude Code process that shows the session: how it went in, or undefined when none does. */
  private deliverToSession(sessionId: string, text: string): Promise<"relayed" | "posted" | undefined> {
    return (
      this.customDeliverToSession?.(sessionId, text) ??
      deliverToOpenSession(this.runtime.paths, sessionId, text, (line) => this.runtime.log(line))
    );
  }

  /** Whether a turn runs in the session, which a fire waits for. A fire posted there a moment ago counts until its turn starts. */
  private sessionBusy(sessionId: string): boolean {
    const session = readSession(this.runtime.paths, sessionId);
    const turn = session?.turn;
    const now = this.runtime.now().getTime();
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
    const claude = this.getClaude();
    // Without claude it waits for the user to open the session (and they get the reminder); otherwise for a run slot.
    if (!claude || !this.runtime.runSlotFree()) return false;
    this.headlessSessions.add(sessionId);
    this.runtime.wentIn(fire, "headless");
    this.runtime.fires.record({ type: "woken", fireId: fire.fireId, at: this.runtime.now().toISOString() });
    this.runtime.log(`no Claude Code process shows session ${sessionId}; running fire ${fire.fireId} there headless`);
    const run = () => this.runHeadless(definition, fire, sessionId, message, claude);
    this.runtime.runTurn(fire, `session ${sessionId}`, run, () => this.headlessSessions.delete(sessionId));
    return true;
  }

  private async runHeadless(
    definition: TriggerDefinition,
    fire: FireRecord,
    sessionId: string,
    message: string,
    claude: SessionRunner,
  ): Promise<void> {
    const session = readSession(this.runtime.paths, sessionId);
    const result = await claude.run({
      sessionId,
      fireId: fire.fireId,
      // The trigger's own session follows target.cwd; a session of the user's keeps its folder.
      cwd: folderOrHome(fire.target?.kind === "dedicated" ? definition.target.cwd : session?.cwd),
      message,
      sandbox: definition.action.sandbox,
      ...(session?.configDir ? { configDir: session.configDir } : {}),
      timeoutMs: this.runtime.config.agentRunTimeoutMinutes * 60_000,
    });
    if (!result.ok && SESSION_GONE.test(result.error ?? "")) {
      // Handed over again, to the trigger's own session.
      this.goneSessions.add(sessionId);
      this.runtime.clearOutcome(fire.fireId);
      return this.runtime.hooks.failAttempt(definition, fire, `session ${sessionId} no longer exists`);
    }
    if (!result.ok) {
      this.runtime.setOutcome(fire.fireId, "unreachable");
      this.runtime.log(`fire ${fire.fireId} did not run in session ${sessionId}: ${result.error}`);
      return;
    }
    await this.runtime.completeTurn(fire, result.lastMessage);
  }

  /** Whether Claude Code still has the session; it cleans old ones up. */
  private sessionExists(ref: string): boolean {
    const sessionId = sessionIdOf(ref);
    if (sessionId === undefined || this.goneSessions.has(sessionId)) return false;
    const transcript = readSession(this.runtime.paths, sessionId)?.transcript;
    return transcript === undefined || existsSync(transcript);
  }

  /** Returns the trigger's own Claude Code session, starting it on first use, and again once Claude Code no longer has it. */
  private ensureDedicatedSession(triggerId: string): Promise<string> {
    const { definition } = this.runtime.store.loadTrigger(triggerId);
    const existing = definition.target.thread_id;
    if (existing && this.sessionExists(existing)) return Promise.resolve(existing);
    return this.runtime.createOnce(definition, () => this.startDedicatedSession(definition));
  }

  private async startDedicatedSession(definition: TriggerDefinition): Promise<string> {
    const claude = this.getClaude();
    if (!claude) throw new Error("the claude CLI was not found; run `self-starter doctor`");
    const sessionId = randomUUID();
    const origin = sessionIdOf(definition.meta.origin_thread_id);
    const configDir = origin ? readSession(this.runtime.paths, origin)?.configDir : undefined;
    const result = await claude.run({
      sessionId,
      start: { name: `Trigger: ${definition.name}` },
      cwd: this.runtime.cwdFor(definition),
      message: renderDedicatedSeed(definition, "session"),
      sandbox: definition.action.sandbox,
      ...(configDir ? { configDir } : {}),
      timeoutMs: Math.min(this.runtime.config.agentRunTimeoutMinutes, 5) * 60_000,
    });
    if (!result.ok) throw new Error(`could not start the trigger's session: ${result.error}`);
    const ref = this.runtime.bindDedicated(definition, sessionRef(sessionId));
    this.runtime.log(`dedicated session of ${definition.id}: ${sessionId}`);
    return ref;
  }
}
