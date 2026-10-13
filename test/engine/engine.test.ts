import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateDefinition, type TriggerDefinition } from "../../src/core/definition.js";
import { initialRuntime } from "../../src/core/state-machine.js";
import { bundledDeno, DEFAULT_CONFIG, type Config } from "../../src/engine/config.js";
import { Engine, USER_PAUSE } from "../../src/engine/engine.js";
import { Executor } from "../../src/engine/executor.js";
import { FireLog } from "../../src/engine/fires.js";
import { Secrets } from "../../src/engine/secrets.js";
import { Store } from "../../src/engine/store.js";
import { eventually, FakeCodex, RecordingNotifier, startServer, tempHome, type TestServer } from "./fixtures.js";

const deno = bundledDeno();
const CREATED = "2026-10-13T08:00:00Z";

/** Reports the price, and fails while the feed says it is below zero. */
const PRICE_PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const { price } = await (await fetch(input.params.url + "/price")).json();
if (price < 0) throw new Error("the price feed is down");
console.log(JSON.stringify({ fire: price > input.params.threshold, summary: "price " + price }));
`;

/** Like PRICE_PROBE, but waits while the price is zero, so a test can act during a run. */
const WAITING_PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
let price = 0;
while (price === 0) {
  price = (await (await fetch(input.params.url + "/price")).json()).price;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(JSON.stringify({ fire: price > input.params.threshold, summary: "price " + price }));
`;

function setup(server: TestServer, configChanges: Partial<Config> = {}) {
  const home = tempHome();
  const { paths } = home;
  const store = new Store(paths);
  store.ensureLayout();
  const config: Config = { ...DEFAULT_CONFIG, ...configChanges };
  const fires = new FireLog(paths.fires);
  const notifier = new RecordingNotifier();
  const clock = { at: Date.parse(CREATED) };
  const now = () => new Date(clock.at);
  const log = () => undefined;
  const executor = new Executor({ store, fires, paths, config, notifier, codex: () => new FakeCodex(), log, now, uptime: () => clock.at });
  const engine = new Engine({ store, executor, secrets: new Secrets(paths), paths, config, deno: () => deno, log, now });

  /** Writes a trigger to disk the way activating a draft or trigger_update does. */
  const install = (overrides: Record<string, unknown> = {}, { code = PRICE_PROBE, revision = 1 } = {}): TriggerDefinition => {
    const checked = validateDefinition({
      id: "price-feed",
      name: "Price feed",
      intent: "Tell me when the price goes above 150",
      probe: { params: { url: server.origin, threshold: 150 }, permissions: { net: [server.host] }, interval: { min: "10s", max: "1h", default: "1m" } },
      action: { type: "notify" },
      meta: { created_at: CREATED, revision },
      ...overrides,
    });
    if (!checked.ok) assert.fail(checked.errors.join("; "));
    store.saveDefinition(checked.definition);
    writeFileSync(join(store.triggerDir(checked.definition.id), "probe.ts"), code);
    return checked.definition;
  };

  /** Milliseconds until the trigger's next check. */
  const nextCheckIn = (id = "price-feed") => Date.parse(engine.runtime(id).nextRunAt!) - clock.at;
  const titles = () => notifier.sent.map((notification) => notification.title);

  return { store, fires, notifier, clock, engine, install, nextCheckIn, titles, cleanup: home.cleanup };
}

describe("engine", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let t: ReturnType<typeof setup>;

  beforeEach(async () => {
    server = await startServer();
    t = setup(server);
  });
  afterEach(async () => {
    t.engine.stop();
    t.cleanup();
    await server.close();
  });

  it("starts due triggers oldest first, a few at a time, and skips paused ones", async () => {
    t.cleanup();
    t = setup(server, { maxConcurrentProbes: 1 });
    const minutesAgo = (minutes: number) => new Date(t.clock.at - minutes * 60_000).toISOString();
    // Listed by id (newer, older, paused), but due in the other order.
    for (const [id, due] of [["newer", 1], ["older", 5], ["paused", 10]] as const) {
      t.install({ id, name: id });
      t.store.saveRuntime(id, { ...initialRuntime(1), nextRunAt: minutesAgo(due) });
    }
    t.engine.pause("paused");
    server.price = 120;

    await t.engine.tick();
    await eventually(() => t.engine.recentRuns("older").length === 1);
    assert.equal(t.engine.recentRuns("newer").length, 0, "one probe at a time, the longest due first");

    await t.engine.tick();
    await eventually(() => t.engine.recentRuns("newer").length === 1);
    await t.engine.tick();
    assert.equal(t.engine.recentRuns("older").length, 1, "not due again for a minute");
    assert.equal(t.engine.recentRuns("paused").length, 0);
  });

  it("tells you once when a probe keeps failing, backs off, and says when it works again", async () => {
    t.install();
    server.price = -1;
    for (let run = 1; run <= 4; run++) {
      const record = await t.engine.runNow("price-feed");
      assert.equal(record?.ok, false);
      assert.match(record?.error ?? "", /the price feed is down/);
    }
    assert.deepEqual(t.titles(), ["Price feed: the probe keeps failing"], "one alert, after the third failure in a row");
    assert.match(t.notifier.sent[0]!.body, /the price feed is down \(checks continue; see: self-starter show price-feed\)$/);
    assert.equal(t.nextCheckIn(), 8 * 60_000, "a minute, doubled after each failure");

    server.price = 120;
    await t.engine.runNow("price-feed");
    assert.deepEqual(t.titles().slice(1), ["Price feed: working again"]);
    assert.equal(t.notifier.sent[1]!.body, "price 120");
    assert.equal(t.nextCheckIn(), 60_000, "back to every minute");
  });

  it("counts a trigger.yaml that no longer loads as a failing check", async () => {
    t.install();
    server.price = 120;
    assert.equal((await t.engine.runNow("price-feed"))?.ok, true);

    writeFileSync(join(t.store.triggerDir("price-feed"), "trigger.yaml"), "id: price-feed\nprobe: [\n");
    for (let run = 1; run <= 3; run++) {
      const record = await t.engine.runNow("price-feed");
      assert.equal(record?.ok, false);
      assert.match(record?.error ?? "", /^invalid trigger\.yaml: /);
    }
    assert.deepEqual(t.titles(), ["price-feed: cannot load the trigger"]);
    assert.equal(t.nextCheckIn(), 5 * 60_000);

    t.install();
    assert.equal((await t.engine.runNow("price-feed"))?.ok, true);
    assert.deepEqual(t.titles().slice(1), ["Price feed: working again"]);
  });

  it("stops at its expiry date, and starts again when trigger_update moves the date", async () => {
    t.install({ policy: { expires_at: "2026-10-13T09:00:00Z" } });
    server.price = 120;
    assert.equal((await t.engine.runNow("price-feed"))?.ok, true);

    t.clock.at = Date.parse("2026-10-13T09:00:00Z");
    const hits = server.hits;
    assert.equal(await t.engine.runNow("price-feed"), undefined);
    assert.equal(server.hits, hits, "the probe did not run");
    assert.equal(t.engine.runtime("price-feed").lifecycle, "expired");
    assert.throws(() => t.engine.resume("price-feed"), /has expired; change policy\.expires_at with trigger_update to use it again/);

    t.install({ policy: { expires_at: "2026-10-14T09:00:00Z" } }, { revision: 2 });
    t.engine.reload("price-feed");
    assert.equal(t.engine.runtime("price-feed").lifecycle, "active");
    assert.equal((await t.engine.runNow("price-feed"))?.ok, true);
  });

  it("keeps a pause when the trigger changes, and checks as soon as it is resumed", async () => {
    t.install();
    server.price = 120;
    await t.engine.runNow("price-feed");
    t.engine.pause("price-feed");

    t.install({ probe: { params: { url: server.origin, threshold: 100 }, permissions: { net: [server.host] } } }, { revision: 2 });
    t.engine.reload("price-feed");
    assert.equal(t.engine.runtime("price-feed").revision, 2);
    assert.equal(t.engine.runtime("price-feed").pausedReason, USER_PAUSE);
    assert.equal(await t.engine.runNow("price-feed"), undefined, "a paused trigger does not run");

    t.clock.at += 5 * 60_000;
    assert.equal(t.engine.resume("price-feed").nextRunAt, new Date(t.clock.at).toISOString());
    const record = await t.engine.runNow("price-feed");
    assert.ok(record?.fireId, "120 is above the new threshold of 100");
  });

  it("does not fire on what a run found when the trigger was paused, changed or deleted meanwhile", async () => {
    t.install({}, { code: WAITING_PROBE });
    /** Starts a run that waits until `during` has happened, then sees a price of 200. */
    const runAround = async (during: () => void) => {
      server.price = 0;
      const hits = server.hits;
      const run = t.engine.runNow("price-feed");
      await eventually(() => server.hits > hits);
      during();
      server.price = 200;
      return run;
    };

    const paused = await runAround(() => t.engine.pause("price-feed"));
    assert.equal(paused?.fire, true, "the probe saw the price above 150");
    assert.equal(t.engine.runtime("price-feed").lifecycle, "paused");
    t.engine.resume("price-feed");

    const changed = await runAround(() => {
      t.install({ probe: { params: { url: server.origin, threshold: 300 }, permissions: { net: [server.host] } } }, { code: WAITING_PROBE, revision: 2 });
      t.engine.reload("price-feed");
    });
    assert.equal(changed, undefined, "the run used the old threshold");

    // Deleted by hand, so the engine is not told.
    const deleted = await runAround(() => t.store.deleteTrigger("price-feed"));
    assert.equal(deleted, undefined);
    assert.equal(existsSync(t.store.triggerDir("price-feed")), false, "nothing was written back");
    assert.equal(t.fires.forTrigger("price-feed").length, 0, "and nothing fired");
  });
});
