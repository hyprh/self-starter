// Plain-language descriptions of a trigger, for Codex to explain it, listings and the CLI.

import type { TriggerDefinition } from "./definition.js";
import type { RuntimeState } from "./state-machine.js";

export interface TrialRun {
  ok: boolean;
  durationMs: number;
  summary?: string;
  fire?: boolean;
  events?: number;
  error?: string;
}

export function describeChecks(def: TriggerDefinition): string {
  const { min, max, default: normal } = def.probe.interval;
  const range = min === max ? "" : ` (the probe may ask for anything from ${min} to ${max})`;
  return `every ${normal}${range}; each check may take up to ${def.probe.timeout}`;
}

export function describeFiring(def: TriggerDefinition): string {
  const parts: string[] = [];
  if (def.mode === "event") {
    parts.push("when the probe reports new events (each event counts once)");
  } else {
    parts.push(def.for ? `when the condition has held for ${def.for}` : "when the condition becomes true");
    parts.push("then again only after it has cleared");
  }
  if (def.policy.cooldown) parts.push(`at most once per ${def.policy.cooldown}`);
  if (def.policy.max_fires !== undefined) parts.push(def.policy.max_fires === 1 ? "only once" : `at most ${def.policy.max_fires} times`);
  if (def.policy.expires_at) parts.push(`until ${def.policy.expires_at}`);
  return parts.join("; ");
}

const SANDBOX_TEXT = {
  "read-only": "read-only",
  "workspace-write": "can change files and run commands in its folder",
  "danger-full-access": "full access, no sandbox",
} as const;

export function describeAction(def: TriggerDefinition): string {
  if (def.action.type === "notify") return "a notification (Codex is not involved)";
  const where =
    def.target.kind === "origin"
      ? `back in the thread where the trigger was created (if no Codex app has it open, it runs there in the background: ${SANDBOX_TEXT[def.action.sandbox]})`
      : `in a dedicated thread (${SANDBOX_TEXT[def.action.sandbox]}${def.target.cwd ? `; folder ${def.target.cwd}` : ""})`;
  return `Codex works on this ${where}:\n  "${def.action.prompt ?? ""}"`;
}

export function describeAccess(def: TriggerDefinition): string {
  if (def.probe.access === "full") return "full: runs as you (files, commands, any network)";
  return `sandbox: network only to ${def.probe.permissions.net.join(", ") || "nothing"}; no files, no commands`;
}

export function describeNotify(def: TriggerDefinition): string {
  const when = { always: "on every fire", receipt: "when Codex says it matters", never: "never" }[def.notify.when];
  const quiet = def.policy.quiet_hours;
  return quiet ? `${when} (held during ${quiet.from}–${quiet.to} ${quiet.tz})` : when;
}

export function describeTrial(trial: TrialRun | undefined, mode: TriggerDefinition["mode"]): string {
  if (!trial) return "not run";
  const seconds = `${(trial.durationMs / 1000).toFixed(1)}s`;
  if (!trial.ok) return `FAILED after ${seconds}: ${trial.error ?? "unknown error"}`;
  const outcome =
    mode === "event"
      ? `${trial.events ?? 0} event(s) seen now; they count as old, only later ones fire`
      : trial.fire
        ? "the condition holds now, so it fires right after activation"
        : "condition not met";
  return `ok in ${seconds}: "${trial.summary ?? ""}" (${outcome})`;
}

export interface DescribeInput {
  definition: TriggerDefinition;
  codePath: string;
  trial?: TrialRun;
  /** For a change to an existing trigger: what differs. */
  changes?: string[];
  /** True when the probe code is new or changed. */
  codeChanged: boolean;
}

/** What a trigger (or a change to one) will do, in plain language. */
export function describeTrigger(input: DescribeInput): string {
  const def = input.definition;
  const heading = input.changes ? `Change to the trigger "${def.name}" (${def.id})` : `The trigger "${def.name}" (${def.id})`;
  const lines = [heading, ""];
  if (input.changes) {
    lines.push("Changes:", ...input.changes.map((line) => `  • ${line}`), "");
  }
  lines.push(`Your words: "${def.intent}"`);
  lines.push(`Checks: ${describeChecks(def)}`);
  lines.push(`Probe access: ${describeAccess(def)}`);
  if (def.probe.permissions.env.length > 0) lines.push(`Secrets: ${def.probe.permissions.env.join(", ")}`);
  lines.push(`Fires: ${describeFiring(def)}`);
  lines.push(`Then: ${describeAction(def)}`);
  lines.push(`Notifications: ${describeNotify(def)}`);
  if (input.trial || !input.changes) lines.push(`Trial run: ${describeTrial(input.trial, def.mode)}`);
  if (def.meta.recipe) lines.push(`Probe: the ready-made recipe ${def.meta.recipe}, shipped with the plugin`);
  lines.push(`Probe code${input.codeChanged ? "" : " (unchanged)"}: ${input.codePath}`);
  return lines.join("\n");
}

/** One phrase for the current state, such as "watching" or "paused (paused by the user)". */
export function describeState(runtime: RuntimeState, now: Date = new Date()): string {
  if (runtime.lifecycle === "paused") return `paused (${runtime.pausedReason ?? "paused"})`;
  if (runtime.lifecycle === "expired") return "expired";
  if (runtime.lifecycle === "exhausted") return "done (reached max_fires)";
  const parts: string[] = [];
  if (runtime.phase === "pending") parts.push(`condition holds since ${runtime.pendingSince}, waiting for it to last`);
  else if (runtime.phase === "wait_rearm") parts.push("fired, waiting for the condition to clear");
  else parts.push("watching");
  if (runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now.getTime()) parts.push(`cooling down until ${runtime.cooldownUntil}`);
  if (runtime.health === "degraded") parts.push(`failing (${runtime.consecutiveFailures} checks in a row)`);
  return parts.join("; ");
}
