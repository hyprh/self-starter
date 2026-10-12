import assert from "node:assert/strict";
import { validateDefinition, type TriggerDefinition } from "../src/core/definition.js";

/** A valid definition with test-friendly defaults; `overrides` is merged shallowly per section. */
export function makeDefinition(overrides: Record<string, unknown> = {}): TriggerDefinition {
  const base: Record<string, unknown> = {
    id: "test-trigger",
    name: "Test trigger",
    intent: "Tell me when the value goes above 10",
    probe: {
      entry: "probe.ts",
      params: { threshold: 10 },
      permissions: { net: ["127.0.0.1"], env: [] },
      interval: { min: "10s", max: "1h", default: "1m" },
      timeout: "10s",
    },
    mode: "state",
    action: { type: "agent", prompt: "Look into it." },
  };
  const raw: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = raw[key];
    raw[key] =
      typeof current === "object" && current !== null && !Array.isArray(current) && typeof value === "object" && value !== null
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  const result = validateDefinition(raw);
  if (!result.ok) assert.fail(`test definition is invalid: ${result.errors.join("; ")}`);
  return result.definition;
}

export function at(iso: string): Date {
  return new Date(iso);
}
