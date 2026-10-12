import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeEvent } from "../../src/core/probe-output.js";
import {
  evaluate,
  initialRuntime,
  nextRunDelayMs,
  type RunResult,
  type RuntimeState,
} from "../../src/core/state-machine.js";
import type { TriggerDefinition } from "../../src/core/definition.js";
import { makeDefinition } from "../helpers.js";

const T0 = Date.parse("2026-10-12T00:00:00Z");
const atSeconds = (s: number) => new Date(T0 + s * 1000);

function stateRun(fire: boolean, extra: { rearm?: boolean; nextCheckInMs?: number } = {}): RunResult {
  return { ok: true, durationMs: 5, output: { mode: "state", fire, summary: `fire=${fire}`, ...extra } };
}

function eventRun(keys: string[]): RunResult {
  const events: ProbeEvent[] = keys.map((key) => ({ key }));
  return { ok: true, durationMs: 5, output: { mode: "event", events, summary: `${keys.length} events` } };
}

const failedRun: RunResult = { ok: false, error: "boom", durationMs: 5 };

/** Feeds runs at the given seconds and returns the seconds at which the trigger fired. */
function simulate(def: TriggerDefinition, steps: Array<[number, RunResult]>): { fires: number[]; rt: RuntimeState } {
  let rt = initialRuntime(1);
  const fires: number[] = [];
  for (const [second, run] of steps) {
    const result = evaluate(def, rt, run, atSeconds(second));
    rt = result.runtime;
    if (result.fire) fires.push(second);
  }
  return { fires, rt };
}

describe("state mode", () => {
  it("fires only on the not-met to met transition", () => {
    const def = makeDefinition();
    const { fires, rt } = simulate(def, [
      [0, stateRun(false)],
      [60, stateRun(true)],
      [120, stateRun(true)],
      [180, stateRun(true)],
      [240, stateRun(false)],
      [300, stateRun(true)],
    ]);
    assert.deepEqual(fires, [60, 300]);
    assert.equal(rt.fireCount, 2);
    assert.equal(rt.phase, "wait_rearm");
  });

  it("waits until the condition has held for `for`", () => {
    const def = makeDefinition({ for: "2m" });
    const { fires } = simulate(def, [
      [0, stateRun(true)],
      [60, stateRun(true)],
      [90, stateRun(false)], // resets the clock
      [100, stateRun(true)],
      [200, stateRun(true)],
      [220, stateRun(true)],
    ]);
    assert.deepEqual(fires, [220]);
  });

  it("uses rearm for hysteresis", () => {
    const def = makeDefinition();
    const { fires } = simulate(def, [
      [0, stateRun(true)],
      [60, stateRun(false, { rearm: false })], // dipped below 200 but not below 196
      [120, stateRun(true)],
      [180, stateRun(false, { rearm: true })], // fell below 196
      [240, stateRun(true)],
    ]);
    assert.deepEqual(fires, [0, 240]);
  });

  it("does not re-arm during the cooldown", () => {
    const def = makeDefinition({ policy: { cooldown: "10m" } });
    const { fires } = simulate(def, [
      [0, stateRun(true)],
      [60, stateRun(false)],
      [120, stateRun(true)],
      [660, stateRun(false)],
      [720, stateRun(true)],
    ]);
    assert.deepEqual(fires, [0, 720]);
  });

  it("repeats while the condition holds when the probe always re-arms", () => {
    const def = makeDefinition({ policy: { cooldown: "1h" } });
    const steps: Array<[number, RunResult]> = [];
    for (let s = 0; s <= 3 * 3600; s += 600) steps.push([s, stateRun(true, { rearm: true })]);
    const { fires } = simulate(def, steps);
    assert.deepEqual(fires, [0, 3600, 7200, 10800]);
  });

  it("stops after max_fires", () => {
    const def = makeDefinition({ policy: { max_fires: 2 } });
    const { fires, rt } = simulate(def, [
      [0, stateRun(true)],
      [60, stateRun(false)],
      [120, stateRun(true)],
      [180, stateRun(false)],
      [240, stateRun(true)],
    ]);
    assert.deepEqual(fires, [0, 120]);
    assert.equal(rt.lifecycle, "exhausted");
  });

  it("does not fire while paused", () => {
    const def = makeDefinition();
    const rt = { ...initialRuntime(1), lifecycle: "paused" as const };
    const result = evaluate(def, rt, stateRun(true), atSeconds(0));
    assert.equal(result.fire, undefined);
    assert.equal(result.runtime.last?.fire, true);
  });
});

describe("health", () => {
  it("degrades after three failures and recovers on success", () => {
    const def = makeDefinition();
    let rt = initialRuntime(1);
    const healthChanges: string[] = [];
    for (const [i, run] of [failedRun, failedRun, failedRun, failedRun, stateRun(false)].entries()) {
      const result = evaluate(def, rt, run, atSeconds(i * 60));
      rt = result.runtime;
      if (result.health) healthChanges.push(`${i}:${result.health}`);
    }
    assert.deepEqual(healthChanges, ["2:degraded", "4:recovered"]);
    assert.equal(rt.consecutiveFailures, 0);
  });

  it("keeps state from failed runs and earlier successes", () => {
    const def = makeDefinition();
    const first = evaluate(def, initialRuntime(1), {
      ok: true,
      durationMs: 1,
      output: { mode: "state", fire: false, summary: "x", state: { cursor: 5 } },
    }, atSeconds(0));
    const second = evaluate(def, first.runtime, failedRun, atSeconds(60));
    const third = evaluate(def, second.runtime, stateRun(false), atSeconds(120));
    assert.deepEqual(third.runtime.probeState, { cursor: 5 });
  });
});

describe("event mode", () => {
  it("records existing events on the first run without firing", () => {
    const def = makeDefinition({ mode: "event" });
    const { fires, rt } = simulate(def, [
      [0, eventRun(["a", "b"])],
      [60, eventRun(["a", "b"])],
      [120, eventRun(["a", "b", "c"])],
    ]);
    assert.deepEqual(fires, [120]);
    assert.deepEqual(Object.keys(rt.seenKeys).sort(), ["a", "b", "c"]);
  });

  it("holds events found during a cooldown and fires them together afterwards", () => {
    const def = makeDefinition({ mode: "event", policy: { cooldown: "10m" } });
    let rt = initialRuntime(1);
    const fired: Array<{ second: number; keys: string[] }> = [];
    const steps: Array<[number, string[]]> = [
      [0, []],
      [60, ["a"]],
      [120, ["a", "b"]],
      [180, ["a", "b", "c"]],
      [720, ["a", "b", "c"]],
    ];
    for (const [second, keys] of steps) {
      const result = evaluate(def, rt, eventRun(keys), atSeconds(second));
      rt = result.runtime;
      if (result.fire) fired.push({ second, keys: result.fire.events!.map((e) => e.key) });
    }
    assert.deepEqual(fired, [
      { second: 60, keys: ["a"] },
      { second: 720, keys: ["b", "c"] },
    ]);
  });
});

describe("nextRunDelayMs", () => {
  it("clamps the probe's suggestion to the approved range", () => {
    const def = makeDefinition();
    const rt = initialRuntime(1);
    assert.equal(nextRunDelayMs(def, rt, stateRun(false, { nextCheckInMs: 1000 }), atSeconds(0)), 10_000);
    assert.equal(nextRunDelayMs(def, rt, stateRun(false, { nextCheckInMs: 10 * 3_600_000 }), atSeconds(0)), 3_600_000);
    assert.equal(nextRunDelayMs(def, rt, stateRun(false), atSeconds(0)), 60_000);
  });

  it("backs off after failures", () => {
    const def = makeDefinition();
    const rt = { ...initialRuntime(1), consecutiveFailures: 3 };
    assert.equal(nextRunDelayMs(def, rt, failedRun, atSeconds(0)), 240_000);
  });

  it("checks again when a pending condition would satisfy `for`", () => {
    const def = makeDefinition({ for: "90s" });
    const { runtime } = evaluate(def, initialRuntime(1), stateRun(true), atSeconds(0));
    assert.equal(runtime.phase, "pending");
    assert.equal(nextRunDelayMs(def, runtime, stateRun(true, { nextCheckInMs: 600_000 }), atSeconds(0)), 90_000);
  });
});
