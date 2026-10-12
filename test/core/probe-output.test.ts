import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OUTPUT_LIMITS, parseProbeOutput } from "../../src/core/probe-output.js";

describe("parseProbeOutput", () => {
  it("parses state mode output", () => {
    const result = parseProbeOutput(
      "state",
      JSON.stringify({ fire: true, summary: "201.3", data: { price: 201.3 }, rearm: false, state: { a: 1 }, next_check_in: "30s" }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.output, {
      mode: "state",
      fire: true,
      summary: "201.3",
      data: { price: 201.3 },
      rearm: false,
      state: { a: 1 },
      nextCheckInMs: 30_000,
    });
  });

  it("accepts next_check_in in seconds", () => {
    const result = parseProbeOutput("state", JSON.stringify({ fire: false, summary: "ok", next_check_in: 90 }));
    assert.ok(result.ok);
    assert.equal(result.output.nextCheckInMs, 90_000);
  });

  it("falls back to the last line when logs precede the JSON", () => {
    const result = parseProbeOutput("state", 'fetching...\ngot 200\n{"fire": false, "summary": "quiet"}\n');
    assert.ok(result.ok);
    assert.equal(result.output.summary, "quiet");
  });

  it("requires fire in state mode and events in event mode", () => {
    const state = parseProbeOutput("state", JSON.stringify({ summary: "x" }));
    assert.ok(!state.ok);
    assert.match(state.error, /fire is required/);
    const event = parseProbeOutput("event", JSON.stringify({ summary: "x" }));
    assert.ok(!event.ok);
    assert.match(event.error, /events is required/);
  });

  it("parses events and validates keys", () => {
    const ok = parseProbeOutput(
      "event",
      JSON.stringify({ summary: "2 new", events: [{ key: "a", summary: "A" }, { key: "b", data: { n: 1 } }] }),
    );
    assert.ok(ok.ok);
    assert.equal(ok.output.mode, "event");
    if (ok.output.mode === "event") assert.deepEqual(ok.output.events.map((e) => e.key), ["a", "b"]);
    const bad = parseProbeOutput("event", JSON.stringify({ summary: "x", events: [{ summary: "no key" }] }));
    assert.ok(!bad.ok);
    assert.match(bad.error, /events\[0\]\.key/);
  });

  it("truncates long summaries but rejects oversized data", () => {
    const long = parseProbeOutput("state", JSON.stringify({ fire: false, summary: "x".repeat(500) }));
    assert.ok(long.ok);
    assert.equal(long.output.summary.length, OUTPUT_LIMITS.summaryChars);
    const big = parseProbeOutput("state", JSON.stringify({ fire: false, summary: "x", data: "y".repeat(20_000) }));
    assert.ok(!big.ok);
    assert.match(big.error, /data is larger/);
  });

  it("rejects empty and non-object output", () => {
    assert.ok(!parseProbeOutput("state", "   ").ok);
    assert.ok(!parseProbeOutput("state", "[1,2]").ok);
    assert.ok(!parseProbeOutput("state", "not json").ok);
  });
});
