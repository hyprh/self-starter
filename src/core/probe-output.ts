// Parsing and validation of what a probe prints on stdout.

import type { Mode } from "./definition.js";
import { parseDuration } from "./duration.js";

export const OUTPUT_LIMITS = {
  summaryChars: 200,
  dataBytes: 16 * 1024,
  stateBytes: 64 * 1024,
  eventKeyChars: 200,
  eventsPerRun: 100,
};

export interface ProbeEvent {
  key: string;
  summary?: string;
  data?: unknown;
}

interface OutputBase {
  summary: string;
  data?: unknown;
  /** undefined means the probe did not return state, so the previous state is kept. */
  state?: unknown;
  nextCheckInMs?: number;
}

export interface StateOutput extends OutputBase {
  mode: "state";
  fire: boolean;
  rearm?: boolean;
}

export interface EventOutput extends OutputBase {
  mode: "event";
  events: ProbeEvent[];
}

export type ProbeOutput = StateOutput | EventOutput;

export type ParseResult = { ok: true; output: ProbeOutput } | { ok: false; error: string };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function jsonSize(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * Probes should print exactly one JSON object. To tolerate stray log lines on
 * stdout, the last non-empty line is tried when the whole output does not parse.
 */
function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new Error("the probe printed nothing on stdout");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    const last = lines[lines.length - 1]!;
    try {
      return JSON.parse(last);
    } catch {
      throw new Error("stdout is not a JSON object");
    }
  }
}

function parseNextCheck(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value * 1000);
  const ms = parseDuration(value);
  return ms === undefined ? "invalid" : ms;
}

export function parseProbeOutput(mode: Mode, stdout: string): ParseResult {
  let raw: unknown;
  try {
    raw = extractJson(stdout);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "stdout is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    return { ok: false, error: "summary is required and must be a string" };
  }
  const summary = truncate(obj.summary.trim(), OUTPUT_LIMITS.summaryChars);

  if (jsonSize(obj.data) > OUTPUT_LIMITS.dataBytes) {
    return { ok: false, error: `data is larger than ${OUTPUT_LIMITS.dataBytes} bytes` };
  }
  if (jsonSize(obj.state) > OUTPUT_LIMITS.stateBytes) {
    return { ok: false, error: `state is larger than ${OUTPUT_LIMITS.stateBytes} bytes` };
  }
  const nextCheck = parseNextCheck(obj.next_check_in);
  if (nextCheck === "invalid") {
    return { ok: false, error: 'next_check_in must be a duration such as "30s" or a number of seconds' };
  }

  const base: OutputBase = { summary };
  if (obj.data !== undefined) base.data = obj.data;
  if (obj.state !== undefined) base.state = obj.state;
  if (nextCheck !== undefined) base.nextCheckInMs = nextCheck;

  if (mode === "state") {
    if (typeof obj.fire !== "boolean") return { ok: false, error: "fire is required and must be true or false" };
    if (obj.rearm !== undefined && typeof obj.rearm !== "boolean") {
      return { ok: false, error: "rearm must be true or false" };
    }
    const output: StateOutput = { ...base, mode: "state", fire: obj.fire };
    if (obj.rearm !== undefined) output.rearm = obj.rearm as boolean;
    return { ok: true, output };
  }

  if (!Array.isArray(obj.events)) return { ok: false, error: "events is required and must be a list" };
  if (obj.events.length > OUTPUT_LIMITS.eventsPerRun) {
    return { ok: false, error: `at most ${OUTPUT_LIMITS.eventsPerRun} events per run` };
  }
  const events: ProbeEvent[] = [];
  for (const [i, item] of obj.events.entries()) {
    if (typeof item !== "object" || item === null) return { ok: false, error: `events[${i}] must be an object` };
    const event = item as Record<string, unknown>;
    if (typeof event.key !== "string" || event.key === "" || event.key.length > OUTPUT_LIMITS.eventKeyChars) {
      return { ok: false, error: `events[${i}].key must be a non-empty string` };
    }
    const parsed: ProbeEvent = { key: event.key };
    if (typeof event.summary === "string") parsed.summary = truncate(event.summary, OUTPUT_LIMITS.summaryChars);
    if (event.data !== undefined) parsed.data = event.data;
    events.push(parsed);
  }
  if (jsonSize(events) > OUTPUT_LIMITS.dataBytes * 4) return { ok: false, error: "events are too large" };
  return { ok: true, output: { ...base, mode: "event", events } };
}
