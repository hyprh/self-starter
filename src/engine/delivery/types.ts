// Shared contracts and runtime services for host-specific fire delivery strategies.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Host } from "../../core/conversations.js";
import type { Sandbox, TriggerDefinition } from "../../core/definition.js";
import type { EnvelopeInput } from "../../core/envelope.js";
import type { TurnResult } from "../codex.js";
import type { Config } from "../config.js";
import type { FireLog, FireRecord } from "../fires.js";
import type { Notification } from "../notify.js";
import type { Paths } from "../paths.js";
import type { Store } from "../store.js";

/** While someone is in the middle of a turn in the conversation, look again this much later. */
export const BUSY_RECHECK_MS = 60_000;

/**
 * What became of a fire queued into a conversation.
 * paused: Codex holds the queue of the user's thread, so the fire waits for them.
 * open: a Codex app has the thread open but has not run the fire; the engine looks again.
 */
export type QueuedOutcome = "picked-up" | "waking" | "woken" | "paused" | "open" | "unreachable";

/** Where a fire was queued; submissionId is the message's id from `codex queue`. */
export type QueuedTarget = { kind: "origin" | "dedicated"; threadId: string; submissionId?: string };

export interface CliSessionRunOptions {
  /** Omit to create a dedicated session; subsequent turns resume its returned id. */
  sessionId?: string;
  cwd: string;
  message: string;
  sandbox: Sandbox;
  timeoutMs: number;
  /** Called once the session is owned, before a resumed CLI is allowed to start. */
  onStart?: () => void;
}

export type CliSessionTurnResult = TurnResult & { sessionId?: string; busy?: boolean; sessionGone?: boolean };

export interface CliSessionRunner {
  run(options: CliSessionRunOptions): Promise<CliSessionTurnResult>;
}

/** The folder, while it exists; the home folder otherwise. */
export function folderOrHome(folder: string | null | undefined): string {
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

/** Shared coordination primitives provided by HostDelivery to all per-host strategies. */
export interface DeliveryRuntime {
  readonly store: Store;
  readonly fires: FireLog;
  readonly paths: Paths;
  readonly config: Config;
  readonly hooks: HostDeliveryHooks;
  now(): Date;
  uptime(): number;
  log(line: string): void;
  cwdFor(definition: TriggerDefinition): string;
  getOutcome(fireId: string): QueuedOutcome | undefined;
  setOutcome(fireId: string, outcome: QueuedOutcome): void;
  clearOutcome(fireId: string): void;
  runSlotFree(): boolean;
  runTurn(fire: FireRecord, where: string, run: () => Promise<void>, finished?: () => void): void;
  completeTurn(fire: FireRecord, lastMessage: string | undefined): Promise<void>;
  creationKey(definition: TriggerDefinition): string;
  createOnce(definition: TriggerDefinition, create: () => Promise<string>): Promise<string>;
  bindDedicated(definition: TriggerDefinition, ref: string): string;
  forgetDedicatedThread(triggerId: string, threadId: string): void;
  wentIn(fire: FireRecord, via: "inbox" | "headless"): void;
}

/** Pluggable strategy for delivering trigger fires and running background turns on a specific host. */
export interface HostDeliveryStrategy {
  readonly host: Host;
  prepareDedicated(triggerId: string): void;
  deliver(definition: TriggerDefinition, fire: FireRecord): Promise<void>;
  follow(fire: FireRecord, age: number): Promise<void>;
  /**
   * Whether a delivered fire is still waiting to enter its conversation (so its receipt timeout clock
   * has not started yet). Defaults to `fire.target?.via === undefined` for session-based strategies;
   * queue-based strategies such as Codex return `false` because delivery immediately queues the turn.
   */
  waitsForEntry?(fire: FireRecord): boolean;
  forgetClosed?(open: ReadonlySet<string>): void;
}

export type HostDeliveryStrategyFactory = (runtime: DeliveryRuntime) => HostDeliveryStrategy;
export type HostDeliveryStrategyInput = HostDeliveryStrategy | HostDeliveryStrategyFactory;
