import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  definitionToYaml,
  parseDefinitionYaml,
  probeTimings,
  validateDefinition,
} from "../../src/core/definition.js";
import { formatDuration, parseDuration } from "../../src/core/duration.js";
import { makeDefinition } from "../helpers.js";

describe("durations", () => {
  it("parses units", () => {
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("5m"), 300_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("1d"), 86_400_000);
  });

  it("rejects malformed values", () => {
    for (const value of ["", "5", "m5", "1.5h", "-1s", "5 minutes", 30, null]) {
      assert.equal(parseDuration(value), undefined, String(value));
    }
  });

  it("formats with the largest exact unit", () => {
    assert.equal(formatDuration(90_000), "90s");
    assert.equal(formatDuration(3_600_000), "1h");
    assert.equal(formatDuration(1500), "1500ms");
  });
});

describe("validateDefinition", () => {
  it("fills in defaults", () => {
    const result = validateDefinition({
      id: "nvda",
      name: "NVDA",
      intent: "Tell me when NVDA breaks 200",
      probe: {},
      action: { prompt: "Write a brief." },
    });
    assert.ok(result.ok, JSON.stringify(result));
    const def = result.definition;
    assert.equal(def.mode, "state");
    assert.equal(def.probe.entry, "probe.ts");
    assert.deepEqual(def.probe.interval, { min: "30s", max: "1h", default: "5m" });
    assert.equal(def.probe.timeout, "20s");
    assert.equal(def.probe.access, "full");
    assert.equal(def.policy.concurrency, "coalesce");
    assert.equal(def.action.type, "agent");
    assert.equal(def.action.sandbox, "workspace-write");
    assert.equal(def.target.kind, "dedicated");
    assert.equal(def.notify.when, "receipt");
    assert.equal(def.meta.revision, 1);
  });

  it("targets the origin thread for one-off triggers", () => {
    const def = makeDefinition({ policy: { max_fires: 1 } });
    assert.equal(def.target.kind, "origin");
  });

  it("collects errors instead of stopping at the first", () => {
    const result = validateDefinition({
      id: "Bad ID",
      name: "",
      intent: "x",
      probe: { interval: { min: "1s", max: "2h", default: "3h" } },
      mode: "event",
      for: "5m",
      action: { type: "agent" },
      surprise: true,
    });
    assert.ok(!result.ok);
    const text = result.errors.join("\n");
    for (const expected of [
      "unknown key: surprise",
      "id must use",
      "name is required",
      "probe.interval.min must be at least",
      "probe.interval.default must lie between",
      "for only applies to state mode",
      "action.prompt is required",
    ]) {
      assert.match(text, new RegExp(expected), expected);
    }
  });

  it("rejects bad permissions and quiet hours", () => {
    const result = validateDefinition({
      id: "x",
      name: "x",
      intent: "x",
      probe: { permissions: { net: ["https://example.com/path"], env: ["lower"] } },
      policy: { quiet_hours: { from: "25:00", to: "08:00", tz: "Mars/Olympus" } },
      action: { type: "notify" },
    });
    assert.ok(!result.ok);
    const text = result.errors.join("\n");
    assert.match(text, /permissions\.net\[0\]/);
    assert.match(text, /permissions\.env\[0\]/);
    assert.match(text, /quiet_hours times/);
    assert.match(text, /not a known time zone/);
  });

  it("rejects judge for now", () => {
    const result = validateDefinition({ ...makeDefinition(), judge: { prompt: "is it news?" } });
    assert.ok(!result.ok);
    assert.match(result.errors.join(), /judge/);
  });

  it("round-trips through YAML", () => {
    const def = makeDefinition({ policy: { cooldown: "1h", quiet_hours: { from: "23:00", to: "08:00", tz: "UTC" } } });
    const parsed = parseDefinitionYaml(definitionToYaml(def));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.definition, def);
  });

  it("reports YAML syntax errors", () => {
    const parsed = parseDefinitionYaml("id: [unclosed");
    assert.ok(!parsed.ok);
    assert.match(parsed.errors[0]!, /invalid YAML/);
  });

  it("exposes timings in milliseconds", () => {
    const def = makeDefinition({ for: "2m", policy: { cooldown: "1h" } });
    const t = probeTimings(def);
    assert.equal(t.minMs, 10_000);
    assert.equal(t.defaultMs, 60_000);
    assert.equal(t.forMs, 120_000);
    assert.equal(t.cooldownMs, 3_600_000);
  });
});
