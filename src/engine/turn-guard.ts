// Guards trigger mutations during turns started by Self-Starter, so untrusted
// probe/fire data cannot create, alter or delete triggers (except quieting the
// firing trigger itself via trigger_tune).

import { sessionIdOf } from "../core/conversations.js";
import type { FireLog } from "./fires.js";
import type { Paths } from "./paths.js";
import type { Caller } from "./service.js";
import { triggerTurn } from "./sessions.js";

const RECENT_FIRE_MS = 24 * 3_600_000;
const REPORTED_TURNS_MAX = 1000;

export class TurnGuard {
  /** Turns that reported a fire, and the trigger of that fire. */
  private readonly reportedTurns = new Map<string, string>();

  constructor(
    private readonly fires: FireLog,
    private readonly paths: Paths,
    private readonly now: () => Date,
  ) {}

  mutationRefusal(caller: Caller, action: string): string | undefined {
    const why = this.handlingFire(caller);
    if (!why) return undefined;
    return `Cannot ${action} now: ${why} Triggers cannot be created, changed or deleted while a trigger fire is being handled (trigger_tune can only make the trigger that fired quieter); the user can ask again in a new message.`;
  }

  tuneRefusal(caller: Caller, triggerId: string): { fromFire: boolean; refused?: string } {
    const fromFire = this.handlingFire(caller) !== undefined;
    if (fromFire && !this.firingTriggers(caller).has(triggerId)) {
      return {
        fromFire,
        refused: `While handling a fire, only the trigger that fired can be made quieter, not ${triggerId}; the user can ask in a new message.`,
      };
    }
    return { fromFire };
  }

  recordReport(caller: Caller, triggerId: string): void {
    const turn = this.turnKey(caller);
    if (!turn) return;
    this.reportedTurns.set(turn, triggerId);
    if (this.reportedTurns.size > REPORTED_TURNS_MAX) {
      this.reportedTurns.delete(this.reportedTurns.keys().next().value!);
    }
  }

  /** Why the caller's turn counts as handling a trigger fire, or undefined when it does not. */
  private handlingFire(caller: Caller): string | undefined {
    if (caller.via !== "mcp") return undefined;
    if (caller.turnTrigger === "self-starter") return "this turn was started by Self-Starter.";
    if (caller.threadId && this.fires.threadBusy(caller.threadId)) return "this thread is handling a trigger fire that has not been reported yet.";
    const turn = this.turnKey(caller);
    if (turn && this.reportedTurns.has(turn)) return "this turn handled a trigger fire.";
    if (caller.turnTrigger === "queue" && caller.threadId && this.recentFireIn(caller.threadId)) {
      return "this turn was started by a queued message, and this thread recently received a trigger fire.";
    }
    // In Claude Code, the plugin's hooks record what started the session's turn.
    const sessionId = sessionIdOf(caller.threadId);
    if (sessionId && triggerTurn(this.paths, sessionId)) return "this turn was started by a Self-Starter message.";
    return undefined;
  }

  /** The triggers whose fires the caller's turn is handling or handled. */
  private firingTriggers(caller: Caller): Set<string> {
    const ids = new Set<string>();
    const sessionId = sessionIdOf(caller.threadId);
    if (sessionId) {
      // An origin Claude session can serve several watches. A process-wide
      // trigger marker locks mutations, but cannot authorize quieting every
      // watch that has ever used the session, including after a receipt.
      const started = caller.turnTrigger === "self-starter"
        ? { fireId: caller.triggerFireId }
        : triggerTurn(this.paths, sessionId);
      if (started) {
        const fire = started.fireId ? this.fires.get(started.fireId) : undefined;
        if (fire && fire.target?.threadId === caller.threadId) ids.add(fire.triggerId);
        return ids;
      }
    }
    const turn = this.turnKey(caller);
    const reported = turn ? this.reportedTurns.get(turn) : undefined;
    if (reported) ids.add(reported);
    for (const fire of this.fires.all()) {
      if ((fire.status === "delivered" || caller.turnTrigger === "self-starter") && caller.threadId && fire.target?.threadId === caller.threadId) {
        ids.add(fire.triggerId);
      }
    }
    return ids;
  }

  private turnKey(caller: Caller): string | undefined {
    return caller.turnId ? JSON.stringify([caller.threadId ?? null, caller.turnId]) : undefined;
  }

  private recentFireIn(threadId: string): boolean {
    const cutoff = this.now().getTime() - RECENT_FIRE_MS;
    return this.fires
      .all()
      .some((fire) => fire.target?.threadId === threadId && fire.deliveredAt !== undefined && Date.parse(fire.deliveredAt) >= cutoff);
  }
}
