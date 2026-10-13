// Fire records, kept as an append-only event log (fires.jsonl) and folded into
// an in-memory index. A fire is logged before anything is delivered, so after a
// crash the daemon can tell which fires still need work.

import type { ProbeEvent } from "../core/probe-output.js";
import type { TargetKind } from "../core/definition.js";
import { appendJsonLine, newId, readJsonLines } from "./fs-util.js";

export type FireStatus = "pending" | "merged" | "skipped" | "delivered" | "done" | "failed";

export interface Receipt {
  summary: string;
  notify: boolean;
  at: string;
  /**
   * tool: trigger_report; final-answer: the last message of a woken turn; notify: a notify-only action;
   * timeout: no reply in time; closed: the trigger was deleted before a reply came.
   */
  source: "tool" | "final-answer" | "notify" | "timeout" | "closed";
  /** The Codex turn that reported it, when known. */
  turnId?: string;
}

export interface FireRecord {
  fireId: string;
  triggerId: string;
  revision: number;
  fireNumber: number;
  createdAt: string;
  reason: string;
  summary: string;
  data?: unknown;
  events?: ProbeEvent[];
  status: FireStatus;
  /** Failed delivery attempts; the fire fails for good after a few. */
  failures: number;
  /** Fires merged into this one by the coalesce policy. */
  merged: string[];
  mergedInto?: string;
  /**
   * Where the fire went; submissionId is the queued message's id from `codex queue`. For a Claude Code
   * session, via says whether it went into a process that shows the session, or runs headless.
   */
  target?: { kind: TargetKind | "none"; threadId?: string; submissionId?: string; via?: "inbox" | "headless" };
  deliveredAt?: string;
  /** When the engine opened the fire's thread itself, because no Codex app had run the fire. */
  wokenAt?: string;
  error?: string;
  receipt?: Receipt;
  notifiedAt?: string;
  skippedBecause?: string;
}

export type FireEvent =
  | ({ type: "created" } & Omit<FireRecord, "status" | "failures" | "merged">)
  | { type: "merged"; fireId: string; into: string; at: string }
  | { type: "skipped"; fireId: string; why: string; at: string }
  | { type: "delivered"; fireId: string; target: FireRecord["target"]; at: string }
  | { type: "woken"; fireId: string; at: string }
  | { type: "attempt_failed"; fireId: string; error: string; at: string }
  | { type: "failed"; fireId: string; error: string; at: string }
  | { type: "receipt"; fireId: string; receipt: Receipt; at: string }
  | { type: "notified"; fireId: string; at: string };

function apply(index: Map<string, FireRecord>, event: FireEvent): void {
  if (event.type === "created") {
    const { type: _type, ...rest } = event;
    index.set(event.fireId, { ...rest, status: "pending", failures: 0, merged: [] });
    return;
  }
  const fire = index.get(event.fireId);
  if (!fire) return;
  switch (event.type) {
    case "merged": {
      fire.status = "merged";
      fire.mergedInto = event.into;
      index.get(event.into)?.merged.push(fire.fireId);
      break;
    }
    case "skipped":
      fire.status = "skipped";
      fire.skippedBecause = event.why;
      break;
    case "delivered":
      if (fire.status !== "done") fire.status = "delivered";
      fire.target = event.target;
      fire.deliveredAt = event.at;
      fire.error = undefined;
      break;
    case "woken":
      fire.wokenAt = event.at;
      break;
    case "attempt_failed":
      fire.status = "pending";
      fire.failures += 1;
      fire.error = event.error;
      break;
    case "failed":
      fire.status = "failed";
      fire.error = event.error;
      break;
    case "receipt":
      fire.status = "done";
      fire.receipt = event.receipt;
      break;
    case "notified":
      fire.notifiedAt = event.at;
      break;
  }
}

export class FireLog {
  private readonly index = new Map<string, FireRecord>();

  constructor(private readonly path: string) {
    for (const event of readJsonLines<FireEvent>(path)) apply(this.index, event);
  }

  record(event: FireEvent): void {
    appendJsonLine(this.path, event);
    apply(this.index, event);
  }

  create(fields: Omit<FireRecord, "fireId" | "status" | "failures" | "merged" | "createdAt">, createdAt = new Date()): FireRecord {
    const fireId = newId("fire");
    this.record({ type: "created", fireId, createdAt: createdAt.toISOString(), ...fields });
    return this.get(fireId)!;
  }

  get(fireId: string): FireRecord | undefined {
    return this.index.get(fireId);
  }

  all(): FireRecord[] {
    return [...this.index.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  forTrigger(triggerId: string): FireRecord[] {
    return this.all().filter((fire) => fire.triggerId === triggerId);
  }

  withStatus(...statuses: FireStatus[]): FireRecord[] {
    return this.all().filter((fire) => statuses.includes(fire.status));
  }

  /** The most recent finished fire of a trigger created at or after `since`, for the "previous fire" line. */
  previousDone(triggerId: string, since: string): FireRecord | undefined {
    return this.forTrigger(triggerId)
      .filter((fire) => fire.status === "done" && fire.receipt && Date.parse(fire.createdAt) >= Date.parse(since))
      .at(-1);
  }

  /** True while a fire is being handled in the given thread. */
  threadBusy(threadId: string): boolean {
    return this.all().some(
      (fire) => fire.status === "delivered" && fire.target?.threadId === threadId,
    );
  }
}
