import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { bundledDeno, DEFAULT_CONFIG, type Config } from "../../src/engine/config.js";
import { Engine } from "../../src/engine/engine.js";
import { Executor } from "../../src/engine/executor.js";
import { FireLog } from "../../src/engine/fires.js";
import { Secrets } from "../../src/engine/secrets.js";
import { ServiceError, TriggerService, type Caller } from "../../src/engine/service.js";
import { Store } from "../../src/engine/store.js";
import { EVENT_PROBE, eventually, FakeCodex, RecordingNotifier, STATE_PROBE, startServer, tempHome, view, type TestServer } from "./fixtures.js";

const deno = bundledDeno();
const ORIGIN = "thread-origin";
const fromThread = (extra: Partial<Caller> = {}): Caller => ({ via: "mcp", threadId: ORIGIN, turnId: "turn-1", ...extra });

function setup(server: TestServer, configChanges: Partial<Config> = {}) {
  const home = tempHome();
  const { paths } = home;
  const store = new Store(paths);
  store.ensureLayout();
  const config: Config = { ...DEFAULT_CONFIG, ...configChanges, budget: { ...DEFAULT_CONFIG.budget, ...(configChanges.budget ?? {}) } };
  const fires = new FireLog(paths.fires);
  const secrets = new Secrets(paths);
  const notifier = new RecordingNotifier();
  const codex = new FakeCodex();
  const logs: string[] = [];
  const clock = { at: Date.now() };
  const now = () => new Date(clock.at);
  const log = (line: string) => logs.push(line);
  const executor = new Executor({ store, fires, paths, config, notifier, codex: () => codex, log, now, uptime: () => clock.at });
  const engine = new Engine({ store, executor, secrets, paths, config, deno: () => deno, log, now });
  const recipesDir = join(paths.home, "recipes");
  const service = new TriggerService({ store, fires, engine, executor, paths, config, version: "test", recipesDir, deno: () => deno, codex: () => "/fake/codex", log, now });

  const definition = (overrides: Record<string, unknown> = {}) => ({
    id: "price-alert",
    name: "Price above 150",
    intent: "Tell me when the price goes above 150",
    probe: { params: { url: server.origin, threshold: 150 }, permissions: { net: [server.host] }, interval: { min: "10s", max: "1h", default: "1m" } },
    action: { type: "agent", prompt: "Find out why the price moved." },
    ...overrides,
  });

  /** Drafts and activates a trigger, as the MCP tools would. */
  const activate = async (overrides: Record<string, unknown> = {}, code = STATE_PROBE, caller: Caller = fromThread()) => {
    const view = await service.createDraft({ definition: definition(overrides), code }, caller);
    assert.ok(view.trial?.ok, `trial run failed: ${view.trial?.error}`);
    return { view, trigger: service.activateDraft({ draftId: view.draftId }, caller) };
  };

  return { home, paths, store, fires, secrets, notifier, codex, logs, clock, executor, engine, service, definition, activate, recipesDir, cleanup: home.cleanup };
}

describe("triggers end to end", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let t: ReturnType<typeof setup>;

  beforeEach(async () => {
    server = await startServer();
    t = setup(server);
  });
  afterEach(async () => {
    t.cleanup();
    await server.close();
  });

  it("drafts, activates, fires into the origin thread and takes the receipt", async () => {
    const view = await t.service.createDraft({ definition: t.definition({ policy: { max_fires: 1 } }), code: STATE_PROBE }, fromThread());
    assert.equal(view.trial?.ok, true);
    assert.equal(view.trial?.fire, false);
    assert.match(view.description, /^The trigger "Price above 150" \(price-alert\)/);
    assert.match(view.description, /Probe access: full: runs as you \(files, commands, any network\)/);
    assert.match(view.description, /back in the thread where the trigger was created \(if no Codex app has it open, it runs there in the background: can change files and run commands in its folder\)/);
    assert.equal(t.store.hasTrigger("price-alert"), false, "nothing is live before activation");

    const trigger = t.service.activateDraft({ draftId: view.draftId }, fromThread());
    assert.equal(trigger.lifecycle, "active");
    assert.ok(t.store.loadTrigger("price-alert").definition.meta.activated_at);

    const quiet = await t.engine.runNow("price-alert");
    assert.equal(quiet?.ok, true);
    assert.equal(quiet?.fireId, undefined);

    server.price = 180;
    const fired = await t.engine.runNow("price-alert");
    assert.ok(fired?.fireId, "the trigger fired");
    const queued = await eventually(() => t.codex.queued[0]);
    assert.equal(queued.threadId, ORIGIN);
    assert.match(queued.message, /^\[self-starter\] Price above 150 \(price-alert · fire #1 · fire_/);
    assert.match(queued.message, /Find out why the price moved\./);
    assert.match(queued.message, /<trigger-data trust="untrusted">[\s\S]*"price": 180[\s\S]*<\/trigger-data>/);
    assert.match(queued.message, new RegExp(`trigger_report tool with fire_id="${fired.fireId}"`));
    assert.equal(t.fires.get(fired.fireId)?.status, "delivered");

    // While the fire is open, this thread cannot change triggers.
    await assert.rejects(t.service.createDraft({ definition: t.definition({ id: "other" }), code: STATE_PROBE }, fromThread()), (error: ServiceError) => error.code === "refused");
    assert.throws(() => t.service.pause({ triggerId: "price-alert" }, fromThread()), (error: ServiceError) => error.code === "refused");

    const report = t.service.report({ fireId: fired.fireId, summary: "Earnings beat; volume 3x normal", notify: true }, fromThread({ turnId: "turn-9" }));
    assert.equal(report.status, "done");
    assert.equal(report.userNotified, true);
    const notification = await eventually(() => t.notifier.sent[0]);
    assert.equal(notification.body, "Earnings beat; volume 3x normal");
    assert.equal(notification.threadId, ORIGIN);

    // The turn that handled the fire stays locked out; a later turn of the user is fine.
    assert.throws(() => t.service.pause({ triggerId: "price-alert" }, fromThread({ turnId: "turn-9" })), (error: ServiceError) => error.code === "refused");
    assert.equal(t.service.pause({ triggerId: "price-alert" }, fromThread({ turnId: "turn-10" })).lifecycle, "paused");

    assert.throws(() => t.service.report({ fireId: fired.fireId, summary: "again", notify: false }, fromThread()), /already has a receipt/);
  });

  it("fires only on the transition and stops after max_fires", async () => {
    await t.activate({ policy: { max_fires: 2 } });
    server.price = 200;
    assert.ok((await t.engine.runNow("price-alert"))?.fireId);
    assert.equal((await t.engine.runNow("price-alert"))?.fireId, undefined, "still above: no second fire");
    server.price = 100;
    await t.engine.runNow("price-alert");
    server.price = 200;
    assert.ok((await t.engine.runNow("price-alert"))?.fireId, "fires again after clearing");
    assert.equal(t.engine.runtime("price-alert").lifecycle, "exhausted");
    assert.equal(await t.engine.runNow("price-alert"), undefined, "an exhausted trigger does not run");
  });

  it("creates a dedicated thread and runs fires there", async () => {
    const { trigger } = await t.activate({ target: { cwd: t.paths.home } });
    assert.equal(trigger.target, "dedicated");
    await eventually(() => t.store.loadTrigger("price-alert").definition.target.thread_id);
    assert.equal(t.codex.started.length, 1);
    assert.equal(t.codex.started[0]!.name, "Trigger: Price above 150");
    assert.match(t.codex.started[0]!.prompt, /This thread belongs to the trigger "Price above 150"/);
    assert.equal(t.codex.started[0]!.cwd, t.paths.home);

    server.price = 200;
    const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
    const queued = await eventually(() => t.codex.queued[0]);
    assert.equal(queued.threadId, "thread-dedicated-1");
    assert.match(queued.message, /call the trigger_report tool with fire_id="fire_/);
    await eventually(() => t.fires.get(fireId)?.status === "delivered");

    // No Codex app has the trigger's thread open, so the executor runs the fire there itself.
    await t.executor.tick();
    assert.equal(t.codex.wakes.length, 0, "an open Codex app gets a moment to pick it up");
    t.clock.at += 21_000;
    await t.executor.tick();
    const wake = await eventually(() => t.codex.wakes[0]);
    assert.deepEqual(
      { threadId: wake.threadId, marker: wake.marker, sandbox: wake.sandbox, cwd: wake.cwd },
      { threadId: "thread-dedicated-1", marker: fireId, sandbox: "workspace-write", cwd: t.paths.home },
    );
    const fire = await eventually(() => (t.fires.get(fireId)?.status === "done" ? t.fires.get(fireId) : undefined));
    assert.equal(fire.receipt?.source, "final-answer");
    assert.equal(fire.receipt?.summary, "The price moved on earnings; details in the thread.");
    assert.equal((await eventually(() => t.notifier.sent[0])).threadId, "thread-dedicated-1");
    assert.equal(t.codex.started.length, 1, "the thread is reused");
  });

  it("retries a fire when the trigger's thread cannot be created yet", async () => {
    t.codex.appServerBroken = true;
    await t.activate();
    server.price = 200;
    const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
    await eventually(() => t.fires.get(fireId)!.failures >= 1);
    assert.match(t.fires.get(fireId)!.error ?? "", /could not create the dedicated thread/);

    t.codex.appServerBroken = false;
    t.clock.at += 31_000;
    t.executor.kick();
    assert.equal((await eventually(() => t.codex.queued[0])).threadId, "thread-dedicated-1");
  });

  it("falls back to a thread of its own when the origin thread is gone, and keeps using it", async () => {
    await t.activate({ policy: { max_fires: 2 }, target: { kind: "origin" } });
    t.codex.goneThreads.add(ORIGIN);
    for (const n of [1, 2]) {
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      assert.equal(t.codex.queued[n - 1]?.threadId, "thread-dedicated-1");
      t.executor.report(fireId, { summary: "handled", notify: false });
      server.price = 100;
      await t.engine.runNow("price-alert");
    }
    assert.equal(t.codex.started.length, 1, "one fallback thread, reused");
  });

  it("picks up hand edits to the probe at the next check", async () => {
    await t.activate();
    writeFileSync(join(t.paths.triggers, "price-alert", "probe.ts"), 'console.log(JSON.stringify({ fire: true, summary: "edited by hand" }));');
    const record = await t.engine.runNow("price-alert");
    assert.equal(record?.summary, "edited by hand");
    assert.ok(record?.fireId);
    assert.equal(t.engine.runtime("price-alert").lifecycle, "active");
  });

  it("limits a host-bound secret to sandboxed probes that cannot reach other hosts", async () => {
    const sandboxed = { access: "sandbox", params: { url: server.origin, threshold: 150 }, permissions: { net: [server.host], env: ["API_KEY"] } };
    t.secrets.set("API_KEY", "s3cret", ["api.example.com"]);
    const refused = await t.service.createDraft({ definition: t.definition({ probe: sandboxed }), code: STATE_PROBE }, fromThread());
    assert.equal(refused.trial?.ok, false);
    assert.match(refused.trial?.error ?? "", /API_KEY may only be sent to api\.example\.com, but the probe can also reach 127\.0\.0\.1/);
    assert.match(refused.warnings[0] ?? "", /The trial run failed/);

    t.secrets.set("API_KEY", "s3cret", ["127.0.0.1"]);
    const allowed = await t.service.createDraft({ definition: t.definition({ probe: sandboxed, id: "price-alert-2" }), code: STATE_PROBE }, fromThread());
    assert.equal(allowed.trial?.ok, true);
    assert.match(allowed.description, /Secrets: API_KEY/);
    assert.match(allowed.description, /Probe access: sandbox: network only to 127\.0\.0\.1:\d+; no files, no commands/);

    // A full-access probe runs as the user and gets the secrets it declares.
    t.secrets.set("API_KEY", "s3cret", ["api.example.com"]);
    const full = { params: { url: server.origin, threshold: 150 }, permissions: { env: ["API_KEY"] } };
    const readsKey = `${STATE_PROBE.replace('summary: "price " + price', 'summary: "price " + price + " key " + Deno.env.get("API_KEY")')}`;
    const fullView = await t.service.createDraft({ definition: t.definition({ probe: full, id: "price-alert-3" }), code: readsKey }, fromThread());
    assert.equal(fullView.trial?.ok, true, fullView.trial?.error);
    assert.match(fullView.trial?.summary ?? "", /key s3cret$/);
  });

  it("treats the first event run as a baseline and fires once per new event", async () => {
    server.events = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    const { view } = await t.activate({ mode: "event", action: { type: "notify" } }, EVENT_PROBE);
    assert.match(view.warnings.join(" "), /saw 2 event\(s\)/);
    assert.equal((await t.engine.runNow("price-alert"))?.fireId, undefined, "baseline");
    server.events.push({ id: "c", title: "C" });
    const fired = await t.engine.runNow("price-alert");
    assert.ok(fired?.fireId);
    assert.deepEqual(t.fires.get(fired.fireId)?.events?.map((e) => e.key), ["c"]);
    assert.equal((await eventually(() => t.notifier.sent[0])).body, "3 items (new: C)");
    assert.equal((await t.engine.runNow("price-alert"))?.fireId, undefined, "c is not new any more");
    assert.equal(t.codex.queued.length + t.codex.wakes.length, 0, "notify actions do not involve Codex");
  });

  it("applies updates at once and starts the state over", async () => {
    await t.activate();
    await eventually(() => t.store.loadTrigger("price-alert").definition.target.thread_id);
    server.price = 200;
    await t.engine.runNow("price-alert");
    assert.equal(t.engine.runtime("price-alert").fireCount, 1);

    assert.throws(
      () => t.service.updateTrigger({ triggerId: "price-alert", changes: { mode: "event" } }, fromThread({ turnId: "turn-3" })),
      /cannot change mode: a new probe \(code or mode\) goes through trigger_draft with replace=true/,
    );
    const result = t.service.updateTrigger({ triggerId: "price-alert", changes: { probe: { params: { threshold: 300 } }, policy: { cooldown: "1h" } } }, fromThread({ turnId: "turn-3" }));
    assert.deepEqual(result.changes, ["policy.cooldown: \"1h\" (new)", "probe.params.threshold: 150 → 300"]);
    assert.equal(result.trigger.lifecycle, "active");

    const definition = t.store.loadTrigger("price-alert").definition;
    assert.equal(definition.meta.revision, 2);
    assert.equal(definition.probe.params.threshold, 300);
    assert.equal(definition.target.thread_id, "thread-dedicated-1", "the dedicated thread is kept");
    assert.equal(t.engine.runtime("price-alert").fireCount, 0);
    assert.equal((await t.engine.runNow("price-alert"))?.fireId, undefined, "200 is below the new threshold");
  });

  it("requires replace=true to replace an existing trigger", async () => {
    await t.activate();
    await assert.rejects(
      t.service.createDraft({ definition: t.definition(), code: STATE_PROBE }, fromThread({ turnId: "turn-5" })),
      (error: ServiceError) => error.code === "conflict",
    );
    const view = await t.service.createDraft({ definition: t.definition(), code: `${STATE_PROBE}\n// v2`, replace: true }, fromThread({ turnId: "turn-5" }));
    assert.equal(view.replaces, "price-alert");
    assert.deepEqual(view.changes, ["probe code: new version"]);
  });

  it("rejects invalid definitions with every problem listed", async () => {
    await assert.rejects(
      t.service.createDraft({ definition: { id: "Bad Id", name: "", probe: {}, judge: "x" }, code: STATE_PROBE }, fromThread()),
      (error: ServiceError) => error.code === "invalid" && /judge/.test(error.message) && /id must use/.test(error.message) && /name is required/.test(error.message),
    );
  });
});

describe("delivery rules", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("retries a failed delivery, then gives up and tells the user", async () => {
    const t = setup(server);
    try {
      await t.activate();
      await eventually(() => t.store.loadTrigger("price-alert").definition.target.thread_id);
      t.codex.queueError = new Error("codex queue failed: database is locked");
      server.price = 200;
      const fired = await t.engine.runNow("price-alert");
      const fireId = fired!.fireId!;
      for (let attempt = 1; attempt <= 4; attempt++) {
        await eventually(() => t.fires.get(fireId)!.failures >= attempt || t.fires.get(fireId)!.status === "failed");
        t.clock.at += 11 * 60_000;
        t.executor.kick();
      }
      await eventually(() => t.fires.get(fireId)?.status === "failed");
      assert.equal(t.codex.queueAttempts, 4);
      assert.match((await eventually(() => t.notifier.sent[0])).title, /could not hand the fire to Codex/);
    } finally {
      t.cleanup();
    }
  });

  it("skips agent runs over the daily budget but still notifies", async () => {
    const t = setup(server, { budget: { maxAgentRunsPerDay: 1, maxConcurrentAgentRuns: 1 } });
    try {
      await t.activate({ policy: { concurrency: "queue" }, target: { kind: "origin" } });
      server.price = 200;
      const first = await t.engine.runNow("price-alert");
      await eventually(() => t.fires.get(first!.fireId!)?.status === "delivered");
      server.price = 100;
      await t.engine.runNow("price-alert");
      server.price = 200;
      const second = await t.engine.runNow("price-alert");
      await eventually(() => t.fires.get(second!.fireId!)?.status === "skipped");
      assert.equal(t.codex.queued.length, 1);
      assert.match((await eventually(() => t.notifier.sent[0])).body, /daily limit of 1 runs is used up/);
    } finally {
      t.cleanup();
    }
  });

  it("merges fires that happen while the previous one is open (coalesce)", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      const open: string[] = [];
      for (let i = 0; i < 3; i++) {
        server.price = 200;
        open.push((await t.engine.runNow("price-alert"))!.fireId!);
        server.price = 100;
        await t.engine.runNow("price-alert");
      }
      await eventually(() => t.codex.queued.length === 1);
      assert.equal(t.fires.get(open[1]!)?.status, "pending", "waits while the first is open");
      t.service.report({ fireId: open[0]!, summary: "done", notify: false }, fromThread({ turnId: "turn-7" }));
      await eventually(() => t.codex.queued.length === 2);
      assert.equal(t.fires.get(open[1]!)?.status, "merged");
      assert.match(t.codex.queued[1]!.message, /\(2 fires merged\)/);
      assert.equal(t.notifier.sent.length, 0, "notify=false and when=receipt: no notification");
    } finally {
      t.cleanup();
    }
  });

  it("wakes the origin thread when no Codex app picked the fire up", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");

      await t.executor.tick();
      assert.equal(t.codex.wakes.length, 0, "an open Codex app gets a minute to pick it up");
      t.clock.at += 61_000;
      await t.executor.tick();
      const wake = await eventually(() => t.codex.wakes[0]);
      assert.equal(wake.threadId, ORIGIN);
      assert.equal(wake.marker, fireId, "the answer is taken from the turn this fire started");
      assert.equal(wake.sandbox, "workspace-write");
      const fire = await eventually(() => (t.fires.get(fireId)?.receipt ? t.fires.get(fireId) : undefined));
      assert.equal(fire.receipt?.summary, "The price moved on earnings; details in the thread.");
      assert.ok(fire.wokenAt, "recorded as run in the background");
      assert.equal((await eventually(() => t.notifier.sent[0])).threadId, ORIGIN);
    } finally {
      t.cleanup();
    }
  });

  it("takes a woken turn's answer even when the receipt timed out while it ran", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      let finish = () => {};
      t.codex.wakeGate = new Promise((resolve) => (finish = resolve));
      t.clock.at += 21_000;
      await t.executor.tick();
      await eventually(() => t.codex.wakes.length === 1);
      t.clock.at += 31 * 60_000;
      await t.executor.tick();
      assert.equal(t.fires.get(fireId)?.receipt?.source, "timeout", "the turn is still running when the receipt times out");
      finish();
      const receipt = await eventually(() => (t.fires.get(fireId)?.receipt?.source === "final-answer" ? t.fires.get(fireId)?.receipt : undefined));
      assert.equal(receipt.summary, "The price moved on earnings; details in the thread.");
      assert.ok(t.notifier.sent.some((n) => n.body === receipt.summary), "the user gets the answer");
    } finally {
      t.cleanup();
    }
  });

  it("keeps looking at a thread that a Codex app holds without running the fire", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      t.codex.wakeError = `thread ${ORIGIN} already has an active writer`;
      t.clock.at += 21_000;
      await t.executor.tick();
      await eventually(() => t.codex.wakes.length === 1);
      t.clock.at += 30_000;
      await t.executor.tick();
      assert.equal(t.codex.wakes.length, 1, "it gives the app a minute");

      t.clock.at += 5 * 60_000;
      await t.executor.tick();
      await eventually(() => t.codex.wakes.length === 2);
      t.clock.at += 1000;
      await t.executor.tick();
      assert.match((await eventually(() => t.notifier.sent[0])).body, /waiting for Codex in your thread/);

      t.codex.wakeError = undefined; // the app lets go of the thread
      t.clock.at += 61_000;
      await t.executor.tick();
      await eventually(() => t.fires.get(fireId)?.status === "done");
      assert.ok(t.fires.get(fireId)?.wokenAt);
    } finally {
      t.cleanup();
    }
  });

  it("leaves the fire to an open Codex app, and waits while the user is mid-turn", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" }, policy: { max_fires: 2 } });
      server.price = 200;
      const first = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(first)?.status === "delivered");
      t.codex.threadViews.set(ORIGIN, view({ mentions: true, busy: true }));
      t.clock.at += 61_000;
      await t.executor.tick();
      t.clock.at += 6 * 60_000;
      await t.executor.tick();
      assert.equal(t.codex.wakes.length, 0, "the open app is on it");
      assert.equal(t.notifier.sent.length, 0, "and no reminder is needed");
      t.service.report({ fireId: first, summary: "done in the app", notify: false }, fromThread({ turnId: "turn-30" }));
      assert.equal(t.fires.get(first)?.wokenAt, undefined, "recorded as run in the open app");

      server.price = 100;
      await t.engine.runNow("price-alert");
      server.price = 200;
      const second = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(second)?.status === "delivered");
      t.codex.threadViews.set(ORIGIN, view({ busy: true }));
      t.clock.at += 61_000;
      await t.executor.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(t.codex.wakes.length, 0, "not while the user is in the middle of a turn");
      t.codex.threadViews.set(ORIGIN, view());
      t.clock.at += 61_000;
      await t.executor.tick();
      await eventually(() => t.codex.wakes.length === 1);
    } finally {
      t.cleanup();
    }
  });

  it("reminds about an origin fire nobody picked up when waking is off, and accepts a late receipt", async () => {
    const t = setup(server, { wakeClosedThreads: false });
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      t.clock.at += 6 * 60_000;
      await t.executor.tick();
      assert.match(t.notifier.sent[0]?.body ?? "", /waiting for Codex in your thread/);
      t.clock.at += 30 * 60_000;
      await t.executor.tick();
      assert.equal(t.fires.get(fireId)?.receipt?.source, "timeout");
      assert.equal(t.notifier.sent.length, 1, "the reminder already told the user");
      t.service.report({ fireId, summary: "late but done", notify: true }, fromThread({ turnId: "turn-8" }));
      assert.equal(t.fires.get(fireId)?.receipt?.summary, "late but done");
      assert.equal((await eventually(() => t.notifier.sent[1])).body, "late but done");
    } finally {
      t.cleanup();
    }
  });

  it("starts the fire in the user's thread that the app closed in the middle of a turn", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      // Closing the app mid-turn leaves the thread paused, like Stop, but only fires wait in its queue.
      t.codex.threadViews.set(ORIGIN, view({ paused: true }));
      t.clock.at += 21_000;
      await t.executor.tick();
      const wake = await eventually(() => t.codex.wakes[0]);
      assert.equal(wake.startQueued, "sub-1");
      assert.equal(wake.cwd, undefined, "the user's thread keeps its folder");
      await eventually(() => t.fires.get(fireId)?.status === "done");
    } finally {
      t.cleanup();
    }
  });

  it("leaves a fire in a thread where Codex was stopped with the user's own messages held, and tells the user", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      t.codex.threadViews.set(ORIGIN, view({ paused: true, holdsOthers: true }));
      t.clock.at += 21_000;
      await t.executor.tick();
      const reminder = await eventually(() => t.notifier.sent[0]);
      assert.match(reminder.body, /Codex was stopped there, so it runs when you continue the conversation/);
      assert.equal(reminder.threadId, ORIGIN);
      assert.equal(t.codex.wakes.length, 0, "starting it would release the user's held messages too");
    } finally {
      t.cleanup();
    }
  });

  it("tells the user at once when the stopped thread is open in a Codex app", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      t.codex.threadViews.set(ORIGIN, view({ paused: true }));
      t.codex.wakeError = `thread ${ORIGIN} already has an active writer`;
      t.clock.at += 21_000;
      await t.executor.tick();
      const reminder = await eventually(() => t.notifier.sent[0]);
      assert.match(reminder.body, /Codex was stopped there/);
      t.clock.at += 10 * 60_000;
      await t.executor.tick();
      assert.equal(t.codex.wakes.length, 1, "it waits for the user from then on");
      assert.equal(t.notifier.sent.length, 1);
    } finally {
      t.cleanup();
    }
  });

  it("starts the fire in the trigger's own thread even when a stopped turn paused it", async () => {
    const t = setup(server);
    try {
      await t.activate();
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      assert.equal(t.fires.get(fireId)?.target?.submissionId, "sub-1", "the queued message's id is kept");
      t.codex.threadViews.set("thread-dedicated-1", view({ paused: true, holdsOthers: true }));
      t.clock.at += 21_000;
      await t.executor.tick();
      const wake = await eventually(() => t.codex.wakes[0]);
      assert.equal(wake.startQueued, "sub-1");
      await eventually(() => t.fires.get(fireId)?.status === "done");
    } finally {
      t.cleanup();
    }
  });

  it("still wakes the trigger's own thread when waking is off", async () => {
    const t = setup(server, { wakeClosedThreads: false });
    try {
      await t.activate();
      server.price = 200;
      const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(fireId)?.status === "delivered");
      t.clock.at += 21_000;
      await t.executor.tick();
      assert.equal((await eventually(() => t.codex.wakes[0])).threadId, "thread-dedicated-1");
    } finally {
      t.cleanup();
    }
  });

  it("sends fire notifications to the channels the trigger chose", async () => {
    const t = setup(server);
    try {
      await t.activate({ action: { type: "notify" }, notify: { when: "always", channels: ["email"] } });
      server.price = 200;
      await t.engine.runNow("price-alert");
      const sent = await eventually(() => t.notifier.sent[0]);
      assert.deepEqual(sent.channels, ["email"]);
    } finally {
      t.cleanup();
    }
  });

  it("holds notifications during quiet hours", async () => {
    const t = setup(server);
    try {
      t.clock.at = Date.parse("2026-10-12T03:00:00Z");
      await t.activate({ action: { type: "notify" }, policy: { quiet_hours: { from: "01:00", to: "07:00", tz: "UTC" } } });
      server.price = 200;
      await t.engine.runNow("price-alert");
      await t.executor.tick();
      assert.equal(t.notifier.sent.length, 0);
      t.clock.at = Date.parse("2026-10-12T07:00:30Z");
      await t.executor.tick();
      assert.equal(t.notifier.sent[0]?.body, "price 200");
    } finally {
      t.cleanup();
    }
  });
});

describe("deleting a trigger", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  it("closes its open fires and does not let them block a new trigger with the same id", async () => {
    const server = await startServer();
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      server.price = 200;
      const first = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(first)?.status === "delivered");
      t.service.delete({ triggerId: "price-alert" }, { via: "cli" });
      assert.equal(t.fires.get(first)?.receipt?.source, "closed");
      // The origin thread is free again.
      t.clock.at += 1000;
      server.price = 100;
      await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromThread({ turnId: "turn-11" }));
      server.price = 200;
      const second = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t.fires.get(second)?.status === "delivered");
      assert.equal(t.codex.queued.length, 2);
      assert.doesNotMatch(t.codex.queued[1]!.message, /previous_fire/);
    } finally {
      t.cleanup();
      await server.close();
    }
  });
});

describe("recipes", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  it("drafts a trigger from a ready-made recipe, with the recipe's code and permissions", async () => {
    const server = await startServer();
    const t = setup(server);
    try {
      const dir = join(t.recipesDir, "price-watch");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "probe.ts"), STATE_PROBE);
      writeFileSync(
        join(dir, "recipe.json"),
        JSON.stringify({
          id: "price-watch",
          version: 2,
          title: "Price watch",
          summary: "Fires when a price crosses a threshold.",
          entry: "probe.ts",
          mode: "state",
          permissions: { net: [server.host], env: [] },
          interval: { min: "10s", max: "1h", default: "1m" },
          params: {
            url: { type: "string", required: true, description: "Where the price comes from." },
            threshold: { type: "number", default: 150, description: "Fire above this." },
          },
        }),
      );
      assert.deepEqual(t.service.listRecipes().map((r) => r.id), ["price-watch"]);

      const base = { id: "from-recipe", name: "Price watch", intent: "Tell me when the price goes above 150", action: { type: "notify" } };
      await assert.rejects(t.service.createDraft({ definition: base, recipe: "nope" }, fromThread()), /no recipe named nope \(available: price-watch\)/);
      await assert.rejects(t.service.createDraft({ definition: base, recipe: "price-watch", code: STATE_PROBE }, fromThread()), /either recipe or code/);
      await assert.rejects(
        t.service.createDraft({ definition: { ...base, probe: { params: { url: server.origin, limit: 3 } } }, recipe: "price-watch" }, fromThread()),
        /has no parameter limit/,
      );

      const view = await t.service.createDraft({ definition: { ...base, probe: { params: { url: server.origin } } }, recipe: "price-watch" }, fromThread());
      assert.equal(view.trial?.ok, true, view.trial?.error);
      assert.match(view.description, /Probe: the ready-made recipe price-watch@2, shipped with the plugin/);
      assert.match(view.definitionYaml, /recipe: price-watch@2/);
      assert.match(view.definitionYaml, /threshold: 150/);

      t.service.activateDraft({ draftId: view.draftId }, fromThread());
      assert.equal(t.store.loadTrigger("from-recipe").definition.meta.recipe, "price-watch@2");
      assert.throws(
        () => t.service.updateTrigger({ triggerId: "from-recipe", changes: { probe: { params: { limit: 1 } } } }, fromThread({ turnId: "turn-20" })),
        /do not fit the price-watch recipe/,
      );
      assert.throws(
        () => t.service.updateTrigger({ triggerId: "from-recipe", changes: { probe: { access: "sandbox" } } }, fromThread({ turnId: "turn-20" })),
        /cannot change probe\.access: the price-watch recipe fixes the probe's access and permissions/,
      );
      const update = t.service.updateTrigger({ triggerId: "from-recipe", changes: { probe: { params: { threshold: 300 } } } }, fromThread({ turnId: "turn-21" }));
      assert.deepEqual(update.changes, ["probe.params.threshold: 150 → 300"]);
      const reset = t.service.updateTrigger({ triggerId: "from-recipe", changes: { probe: { params: { threshold: null } } } }, fromThread({ turnId: "turn-22" }));
      assert.deepEqual(reset.changes, ["probe.params.threshold: 300 → 150"], "a removed parameter gets the recipe's default back");
      assert.equal(t.store.loadTrigger("from-recipe").definition.probe.params.threshold, 150);
    } finally {
      t.cleanup();
      await server.close();
    }
  });
});
