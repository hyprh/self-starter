import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { bundledDeno, DEFAULT_CONFIG, type Config } from "../../src/engine/config.js";
import { Engine } from "../../src/engine/engine.js";
import { Executor } from "../../src/engine/executor.js";
import { FireLog } from "../../src/engine/fires.js";
import { Secrets } from "../../src/engine/secrets.js";
import { ServiceError, TriggerService, type Caller } from "../../src/engine/service.js";
import { Store } from "../../src/engine/store.js";
import { EVENT_PROBE, eventually, FakeClaude, FakeCodex, FakeZCode, RecordingNotifier, STATE_PROBE, startServer, tempHome, view, type TestServer } from "./fixtures.js";

const deno = bundledDeno();
const ORIGIN = "thread-origin";
const fromThread = (extra: Partial<Caller> = {}): Caller => ({ via: "mcp", threadId: ORIGIN, turnId: "turn-1", ...extra });

function setup(server: TestServer, configChanges: Partial<Config> = {}, zcodeInstalled = true, opencodeInstalled = true) {
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
  const clock: { at: number; uptime?: number } = { at: Date.now() };
  const now = () => new Date(clock.at);
  const log = (line: string) => logs.push(line);
  // Claude Code: sessions that a process shows take fires into their inbox; the others run headless.
  const claude = new FakeClaude();
  const zcode = new FakeZCode();
  const opencode = new FakeZCode("ses");
  const openSessions = new Set<string>();
  const inboxes: Array<{ sessionId: string; text: string }> = [];
  const deliverToSession = async (sessionId: string, text: string) => {
    if (!openSessions.has(sessionId)) return undefined;
    inboxes.push({ sessionId, text });
    return "relayed" as const;
  };
  const executor = new Executor({ store, fires, paths, config, notifier, codex: () => codex, claude: () => claude, zcode: () => zcodeInstalled ? zcode : undefined, opencode: () => opencodeInstalled ? opencode : undefined, deliverToSession, log, now, uptime: () => clock.uptime ?? clock.at });
  const engine = new Engine({ store, executor, secrets, paths, config, deno: () => deno, log, now });
  const recipesDir = join(paths.home, "recipes");
  const service = new TriggerService({ store, fires, engine, executor, paths, config, version: "test", recipesDir, deno: () => deno, codexBin: () => "/fake/codex", log, now });

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

  return { home, paths, store, fires, secrets, notifier, codex, claude, zcode, opencode, openSessions, inboxes, logs, clock, executor, engine, service, definition, activate, recipesDir, cleanup: home.cleanup };
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

  it("lets the turn that handles a fire make that trigger quieter, keeping its state, and tells the user", async () => {
    await t.activate();
    await t.activate({ id: "other", name: "Other" });
    server.price = 180;
    const fired = await t.engine.runNow("price-alert");
    assert.ok(fired?.fireId);
    const queued = await eventually(() => t.codex.queued[0]);
    assert.match(queued.message, /How often it fired: 1 time\(s\) in the last 24 hours, 1 in the last hour\./);
    assert.match(queued.message, /trigger_tune can make it quieter/);
    // The turn that handles the fire, in the trigger's own thread.
    const handling = fromThread({ threadId: queued.threadId, turnId: "fire-turn" });

    const tune = (changes: Record<string, unknown>) => t.service.tuneTrigger({ triggerId: "price-alert", reason: "It fired 14 times in an hour on a flapping feed.", ...changes }, handling);
    await assert.rejects(tune({ checkEvery: "30s" }), /check_every can only be longer than now \(1m\)/);
    await assert.rejects(tune({ maxFires: 0 }), /max_fires must be a whole number of at least 1/);
    await assert.rejects(tune({}), /needs at least one of/);
    await assert.rejects(t.service.tuneTrigger({ triggerId: "price-alert", cooldown: "1h" }, handling), /reason is required/);
    await assert.rejects(t.service.tuneTrigger({ triggerId: "other", reason: "noisy", cooldown: "1h" }, handling), (error: ServiceError) => error.code === "refused");
    assert.throws(() => t.service.updateTrigger({ triggerId: "price-alert", changes: { policy: { cooldown: "1h" } } }, handling), (error: ServiceError) => error.code === "refused");

    const tuned = await tune({ checkEvery: "15m", cooldown: "2h" });
    assert.deepEqual(tuned.changes, ["checks every 15m (was 1m)", "waits 2h after a fire (was no wait)"]);
    const notice = await eventually(() => t.notifier.sent.find((sent) => sent.title === "Price above 150: Codex made it quieter"));
    assert.equal(notice.body, "checks every 15m (was 1m); waits 2h after a fire (was no wait). Why: It fired 14 times in an hour on a flapping feed.");

    const runtime = t.engine.runtime("price-alert");
    assert.equal(runtime.revision, 2);
    assert.equal(runtime.fireCount, 1, "the trigger kept its state");
    assert.equal(runtime.cooldownUntil, new Date(Date.parse(runtime.lastFireAt!) + 2 * 3_600_000).toISOString(), "the longer cooldown counts from the last fire");
    assert.equal(Date.parse(runtime.nextRunAt!) - Date.parse(runtime.last!.ranAt), 15 * 60_000, "and the next check moved out");
    assert.equal((await t.engine.runNow("price-alert"))?.fireId, undefined, "the price is still above 150, but that fired already");
  });

  it("can pause the trigger that fired, or end it with a lower max_fires", async () => {
    await t.activate();
    server.price = 180;
    await t.engine.runNow("price-alert");
    const queued = await eventually(() => t.codex.queued[0]);
    const tuned = await t.service.tuneTrigger({ triggerId: "price-alert", reason: "The user only wanted the first one.", maxFires: 1 }, fromThread({ threadId: queued.threadId, turnId: "fire-turn" }));
    assert.deepEqual(tuned.changes, ["stops after 1 fire(s) (was no limit)"]);
    assert.equal(t.engine.runtime("price-alert").lifecycle, "exhausted");

    await t.activate({ id: "second", name: "Second" }, STATE_PROBE, fromThread({ turnId: "turn-20" }));
    const paused = await t.service.tuneTrigger({ triggerId: "second", reason: "Noisy at night.", pause: true }, fromThread({ turnId: "turn-21" }));
    assert.deepEqual(paused.changes, ["paused until you resume it"]);
    assert.equal(t.engine.runtime("second").lifecycle, "paused");
    assert.equal(t.notifier.sent.filter((sent) => /made it quieter/.test(sent.title)).length, 1, "only the change made while handling a fire is announced");
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
    assert.equal(fullView.trial?.ok, true, fullView.trial?.error ?? "probe trial failed");
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

  it("wakes one thread at a time when there is one run slot", async () => {
    const t = setup(server);
    try {
      await t.activate({ target: { kind: "origin" } });
      await t.activate({ id: "other", name: "Other", target: { kind: "origin" } }, STATE_PROBE, fromThread({ threadId: "thread-other" }));
      let finish = () => {};
      t.codex.wakeGate = new Promise((resolve) => (finish = resolve));
      server.price = 200;
      const fireIds = [(await t.engine.runNow("price-alert"))!.fireId!, (await t.engine.runNow("other"))!.fireId!];
      await eventually(() => fireIds.every((fireId) => t.fires.get(fireId)?.status === "delivered"));
      t.clock.at += 21_000;
      await t.executor.tick();
      await eventually(() => t.codex.wakes.length === 1);
      await t.executor.tick();
      assert.equal(t.codex.wakes.length, 1, "the other thread waits for the run slot");
      finish();
      await eventually(() => t.codex.wakes.length === 2);
      assert.deepEqual(t.codex.wakes.map((wake) => wake.threadId).sort(), [ORIGIN, "thread-other"].sort());
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

describe("triggers made in Claude Code", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let t: ReturnType<typeof setup>;
  const fromSession = (sessionId = "s1"): Caller => ({ via: "mcp", threadId: `cc:${sessionId}` });
  /** What the plugin's hooks record about a session. */
  const record = (sessionId: string, fields: Record<string, unknown> = {}) => {
    mkdirSync(t.paths.sessions, { recursive: true });
    writeFileSync(join(t.paths.sessions, `${sessionId}.json`), JSON.stringify({ sessionId, cwd: t.paths.home, startedAt: new Date().toISOString(), ...fields }));
  };
  /** Fires the trigger and returns the fire once it is in its session, or running there, or done. */
  const fire = async (id = "price-alert") => {
    server.price += 100;
    const fireId = (await t.engine.runNow(id))!.fireId!;
    return eventually(() => (t.fires.get(fireId)?.target?.via || t.fires.get(fireId)?.receipt ? t.fires.get(fireId) : undefined));
  };
  /** Fires the trigger and returns the fire's id once it is handed to its session. */
  const handOver = async (id = "price-alert") => {
    server.price += 100;
    const fireId = (await t.engine.runNow(id))!.fireId!;
    await eventually(() => t.fires.get(fireId)?.status === "delivered");
    return fireId;
  };
  /** What the plugin's hooks record when a turn starts (running) or ends. */
  const turn = (sessionId: string, running: boolean, minutesAgo = 0) =>
    record(sessionId, { turn: { at: new Date(t.clock.at - minutesAgo * 60_000).toISOString(), running, trigger: false } });

  beforeEach(async () => {
    server = await startServer();
    t = setup(server);
  });
  afterEach(async () => {
    t.cleanup();
    await server.close();
  });

  it("brings a fire into the session it was made in while a terminal shows it", async () => {
    const { view } = await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    assert.match(view.description, /Claude works on this back in the session where the trigger was created \(if no terminal has it open, Self-Starter resumes it in the background: can edit files in its folder\)/);
    t.openSessions.add("s1");
    const delivered = await fire();
    assert.deepEqual(delivered.target, { kind: "origin", threadId: "cc:s1", via: "inbox" });
    assert.match(t.inboxes[0]!.text, new RegExp(`call the trigger_report tool with fire_id="${delivered.fireId}"`));

    t.service.report({ fireId: delivered.fireId, summary: "It moved on earnings", notify: true }, fromSession());
    assert.equal(t.fires.get(delivered.fireId)?.receipt?.source, "tool");
    assert.equal((await eventually(() => t.notifier.sent[0])).threadId, "cc:s1");
    assert.equal(t.claude.runs.length, 0, "nothing ran headless");
    assert.throws(() => t.service.report({ fireId: delivered.fireId, summary: "again", notify: false }, fromSession("s2")), /already has a receipt/);
  });

  it("resumes the session headless when no terminal shows it, in its folder and with the trigger's permissions", async () => {
    record("s1", { cwd: t.paths.logs, configDir: "/somewhere/claude" });
    mkdirSync(t.paths.logs, { recursive: true });
    await t.activate({ target: { kind: "origin" }, action: { type: "agent", prompt: "Find out why.", sandbox: "read-only" } }, STATE_PROBE, fromSession());
    const delivered = await fire();
    const run = await eventually(() => t.claude.runs[0]);
    assert.deepEqual({ ...run, message: "" }, { sessionId: "s1", cwd: t.paths.logs, message: "", sandbox: "read-only", configDir: "/somewhere/claude", timeoutMs: 20 * 60_000 });
    assert.match(run.message, /^\[self-starter\] Price above 150 \(price-alert · fire #1 · fire_/);
    const done = await eventually(() => (t.fires.get(delivered.fireId)?.receipt ? t.fires.get(delivered.fireId) : undefined));
    assert.deepEqual(done.target, { kind: "origin", threadId: "cc:s1", via: "headless" });
    assert.ok(done.wokenAt);
    assert.deepEqual([done.receipt?.source, done.receipt?.summary], ["final-answer", "Looked into it: the price moved on earnings."]);
  });

  it("takes the report the headless turn made, and runs one turn per session at a time", async () => {
    // Two run slots, so that only the session holds the second fire back.
    t.cleanup();
    t = setup(server, { budget: { ...DEFAULT_CONFIG.budget, maxConcurrentAgentRuns: 2 } });
    record("s1");
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    await t.activate({ id: "other", name: "Other", target: { kind: "origin" } }, STATE_PROBE, fromSession());
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.claude.during = async (options) => {
      const fireId = /fire_id="(fire_\w+)"/.exec(options.message)![1]!;
      await gate;
      t.service.report({ fireId, summary: `reported ${fireId}`, notify: false }, fromSession());
    };
    const first = (await fire()).fireId;
    const second = await handOver("other");
    await eventually(() => t.claude.runs.length === 1);
    await t.executor.tick();
    assert.equal(t.claude.runs.length, 1, "the second fire waits for the session's turn to end");
    release();
    await eventually(() => t.claude.runs.length === 2);
    for (const fireId of [first, second]) {
      const receipt = await eventually(() => t.fires.get(fireId)?.receipt);
      assert.deepEqual([receipt.source, receipt.summary], ["tool", `reported ${fireId}`]);
    }
  });

  it("brings the fire into the session after all when the user opened it meanwhile", async () => {
    record("s1");
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    await t.activate({ id: "other", name: "Other", target: { kind: "origin" } }, STATE_PROBE, fromSession("s2"));
    record("s2");
    // A run in another session takes the only run slot.
    let release = () => {};
    t.claude.during = (options) => (options.sessionId === "s2" ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    await fire("other");
    await eventually(() => t.claude.runs.length === 1);
    const waiting = await handOver();
    await t.executor.tick();
    assert.equal(t.fires.get(waiting)?.target?.via, undefined, "handed over, waiting for a run slot");
    t.openSessions.add("s1");
    release();
    await eventually(() => t.inboxes.length === 1);
    assert.equal(t.claude.runs.length, 1, "s1 never ran headless");
    assert.equal(t.fires.get(waiting)?.target?.via, "inbox");
  });

  it("waits for the turn running in the session, and brings the fire in once it is over", async () => {
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.openSessions.add("s1");
    turn("s1", true); // the user's turn
    const fireId = await handOver();
    await t.executor.tick();
    assert.deepEqual(t.inboxes, [], "not in the middle of the user's turn");
    assert.equal(t.claude.runs.length, 0, "nor headless: the session is open");

    turn("s1", false);
    await t.executor.tick();
    await eventually(() => t.inboxes.length === 1);
    assert.equal(t.fires.get(fireId)?.target?.via, "inbox");
  });

  it("waits for a long turn while it writes to the session, but not for one the user interrupted", async () => {
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.openSessions.add("s1");
    // A turn started 40 minutes ago, whose subagent is still at work.
    const transcript = join(t.paths.home, "projects", "s1.jsonl");
    const subagent = join(t.paths.home, "projects", "s1", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(subagent), { recursive: true });
    const written = (path: string, minutesAgo: number) => {
      writeFileSync(path, "{}\n");
      utimesSync(path, new Date(t.clock.at - minutesAgo * 60_000), new Date(t.clock.at - minutesAgo * 60_000));
    };
    written(transcript, 40);
    written(subagent, 1);
    record("s1", { transcript, turn: { at: new Date(t.clock.at - 40 * 60_000).toISOString(), running: true, trigger: false } });
    await handOver();
    await t.executor.tick();
    assert.deepEqual(t.inboxes, [], "the turn is still at work");

    // The user pressed Esc, which runs no hook, and the session has been quiet since.
    written(subagent, 16);
    await t.executor.tick();
    await eventually(() => t.inboxes.length === 1);
  });

  it("does not give up on a fire that waits to go into its session, and counts its time from when it goes in", async () => {
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.openSessions.add("s1");
    turn("s1", true);
    const fireId = await handOver();
    t.clock.at += 31 * 60_000;
    turn("s1", true); // the user is still at it
    await t.executor.tick();
    assert.equal(t.fires.get(fireId)?.receipt, undefined, "no \"no reply\" receipt for a fire Claude has not seen");
    await eventually(() => t.notifier.sent.find((sent) => sent.body.endsWith("(waiting for Claude in your session)")));

    turn("s1", false);
    await t.executor.tick();
    await eventually(() => t.inboxes.length === 1);
    t.clock.at += 29 * 60_000;
    await t.executor.tick();
    assert.equal(t.fires.get(fireId)?.receipt, undefined);
    t.clock.at += 2 * 60_000;
    await t.executor.tick();
    await eventually(() => t.fires.get(fireId)?.receipt?.source === "timeout");
  });

  it("sends a second fire for the same session after the first one's turn", async () => {
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    await t.activate({ id: "other", name: "Other", target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.openSessions.add("s1");
    await handOver();
    await eventually(() => t.inboxes.length === 1);
    const second = await handOver("other");
    await t.executor.tick();
    assert.equal(t.inboxes.length, 1, "the first fire's turn has not started yet");
    t.clock.at += 1000;
    turn("s1", true); // it starts...
    await t.executor.tick();
    assert.equal(t.inboxes.length, 1);
    turn("s1", false); // ...and ends
    await t.executor.tick();
    await eventually(() => t.inboxes.length === 2);
    assert.equal(t.fires.get(second)?.target?.via, "inbox");
  });

  it("starts a session of its own for a dedicated trigger and runs its fires there", async () => {
    await t.activate({ target: { kind: "dedicated", cwd: t.paths.home } }, STATE_PROBE, fromSession());
    const start = await eventually(() => t.claude.runs[0]);
    assert.deepEqual(start.start, { name: "Trigger: Price above 150" });
    assert.match(start.message, /^\[self-starter\] This session belongs to the trigger "Price above 150" \(price-alert\)\./);
    const ref = await eventually(() => t.store.loadTrigger("price-alert").definition.target.thread_id);
    assert.equal(ref, `cc:${start.sessionId}`);

    const delivered = await fire();
    const run = await eventually(() => t.claude.runs[1]);
    assert.deepEqual([run.sessionId, run.start, run.cwd], [start.sessionId, undefined, t.paths.home]);
    assert.deepEqual(t.fires.get(delivered.fireId)?.target, { kind: "dedicated", threadId: ref, via: "headless" });
  });

  it("uses a session of its own once the origin session is gone", async () => {
    record("s1", { transcript: join(t.paths.home, "cleaned-up.jsonl") });
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    const delivered = await fire();
    const [start, run] = await eventually(() => (t.claude.runs.length === 2 ? t.claude.runs : undefined));
    assert.ok(start!.start, "a new session for the trigger");
    assert.equal(run!.sessionId, start!.sessionId);
    assert.deepEqual(t.fires.get(delivered.fireId)?.target, { kind: "dedicated", threadId: `cc:${start!.sessionId}`, via: "headless" });
  });

  it("replaces a missing dedicated session and runs the waiting fire in its replacement", async () => {
    await t.activate({ target: { kind: "dedicated", cwd: t.paths.home } }, STATE_PROBE, fromSession());
    const oldRef = await eventually(() => t.store.loadTrigger("price-alert").definition.target.thread_id);
    const oldSession = t.claude.runs[0]!.sessionId;
    assert.equal(oldRef, `cc:${oldSession}`);
    t.claude.during = (options) => {
      t.claude.error = options.sessionId === oldSession ? `claude -p: No conversation found with session ID: ${oldSession}` : undefined;
    };
    server.price = 200;
    const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
    await eventually(() => t.fires.get(fireId)?.status === "pending" && t.fires.get(fireId)?.failures === 1);
    t.clock.at += 31_000;
    await t.executor.tick();
    const done = await eventually(() => t.fires.get(fireId)?.receipt ? t.fires.get(fireId) : undefined);
    const [original, failed, replacement, resumed] = t.claude.runs;
    assert.equal(t.claude.runs.length, 4, "one failed resume creates and runs just one replacement");
    assert.equal(failed!.sessionId, original!.sessionId);
    assert.ok(replacement!.start);
    assert.notEqual(replacement!.sessionId, oldSession);
    assert.equal(resumed!.sessionId, replacement!.sessionId);
    const newRef = `cc:${replacement!.sessionId}`;
    assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, newRef);
    assert.deepEqual(done.target, { kind: "dedicated", threadId: newRef, via: "headless" });
    assert.equal(done.receipt?.source, "final-answer");
  });

  it("hands the fire to a session of its own when claude no longer finds the origin session", async () => {
    record("s1"); // no transcript recorded, so only claude can tell that it is gone
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.claude.during = (options) => {
      t.claude.error = options.sessionId === "s1" ? "claude -p: No conversation found with session ID: s1" : undefined;
    };
    server.price = 200;
    const fireId = (await t.engine.runNow("price-alert"))!.fireId!;
    await eventually(() => t.fires.get(fireId)?.status === "pending" && t.fires.get(fireId)?.failures === 1);
    t.clock.at += 31_000; // the retry
    await t.executor.tick();
    const done = await eventually(() => (t.fires.get(fireId)?.receipt ? t.fires.get(fireId) : undefined));
    const [gone, start, run] = t.claude.runs;
    assert.deepEqual([gone?.sessionId, start?.start?.name, run?.sessionId], ["s1", "Trigger: Price above 150", start?.sessionId]);
    assert.deepEqual(done.target, { kind: "dedicated", threadId: `cc:${start!.sessionId}`, via: "headless" });
    assert.equal(done.receipt?.source, "final-answer");
  });

  it("does not let a turn that a fire started create or change triggers, except to make that one quieter", async () => {
    await t.activate({ target: { kind: "origin" } }, STATE_PROBE, fromSession());
    t.openSessions.add("s1");
    const delivered = await fire();
    // The hook saw the fire start the session's turn; then the turn reported.
    record("s1", { turn: { at: new Date().toISOString(), trigger: true, line: `[self-starter] Price above 150 (price-alert · fire #1 · ${delivered.fireId})` } });
    t.service.report({ fireId: delivered.fireId, summary: "Reported", notify: false }, fromSession());
    await assert.rejects(t.service.createDraft({ definition: t.definition({ id: "more" }), code: STATE_PROBE }, fromSession()), /this turn was started by a Self-Starter message/);
    const tuned = await t.service.tuneTrigger({ triggerId: "price-alert", reason: "Fired on every check.", cooldown: "1h" }, fromSession());
    assert.deepEqual(tuned.changes, ["waits 1h after a fire (was no wait)"]);
    assert.ok(await eventually(() => t.notifier.sent.find((sent) => sent.title === "Price above 150: Claude made it quieter")));
    // The user's next message starts a turn of their own.
    record("s1", { turn: { at: new Date().toISOString(), trigger: false } });
    assert.ok((await t.service.createDraft({ definition: t.definition({ id: "more" }), code: STATE_PROBE }, fromSession())).draftId);
  });
});

for (const { host, name, refPrefix, idPrefix, otherHost, otherPrefix } of [
  { host: "zcode", name: "ZCode", refPrefix: "zc:", idPrefix: "sess", otherHost: "opencode", otherPrefix: "oc:" },
  { host: "opencode", name: "OpenCode", refPrefix: "oc:", idPrefix: "ses", otherHost: "zcode", otherPrefix: "zc:" },
] as const) describe(`triggers made in ${name}`, { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let t: ReturnType<typeof setup>;
  const fromHost = (extra: Partial<Caller> = {}): Caller => ({ via: "mcp", threadId: `${refPrefix}${idPrefix}_origin`, turnId: "turn-1", cwd: t.paths.home, ...extra });
  const ownSession = (id = "price-alert") => eventually(() => t.store.loadTrigger(id).definition.target.thread_id || undefined);
  const fire = async (id = "price-alert") => {
    server.price = 200;
    const result = await t.engine.runNow(id);
    assert.ok(result?.fireId);
    return result.fireId;
  };
  const noOtherHostRuns = () => {
    assert.equal(t.codex.started.length + t.codex.queued.length + t.codex.wakes.length, 0, "CLI never falls back to Codex");
    assert.equal(t.claude.runs.length + t.inboxes.length, 0, "CLI does not use Claude sessions");
    assert.equal(t[otherHost].runs.length, 0, "the other CLI host remains unused");
  };
  const replaceWithClaude = async () => {
    const caller = fromThread({ threadId: "cc:replacement" });
    const draft = await t.service.createDraft({ definition: t.definition({ target: { kind: "origin" }, action: { type: "agent", prompt: "New task for Claude" } }), code: STATE_PROBE, replace: true }, caller);
    t.service.activateDraft({ draftId: draft.draftId }, caller);
  };

  beforeEach(async () => {
    server = await startServer();
    t = setup(server);
  });
  afterEach(async () => {
    t.executor.close();
    await eventually(() => t.executor.status().activeAgentRuns === 0);
    t.cleanup();
    await server.close();
  });

  it("defaults even one-shot triggers to a dedicated session in the caller's folder, and receives each fire once", async () => {
    const { trigger } = await t.activate({ policy: { max_fires: 1 } }, STATE_PROBE, fromHost({ cwd: t.paths.logs }));
    assert.equal(trigger.target, "dedicated");
    assert.equal(trigger.host, host);
    const ref = await ownSession();
    assert.equal(ref, `${refPrefix}${idPrefix}_1`);
    const definition = t.store.loadTrigger("price-alert").definition;
    assert.equal(definition.meta.origin_thread_id, `${refPrefix}${idPrefix}_origin`);
    assert.equal(definition.target.cwd, t.paths.logs);
    const seed = t[host].runs[0]!;
    assert.equal(seed.sessionId, undefined, "the runner creates the session and returns its id");
    assert.equal(seed.cwd, t.paths.logs);
    assert.match(seed.message, /^\[self-starter\] This session belongs to the trigger "Price above 150"/);

    t[host].answer = "Earnings beat; volume rose.\nThe detailed investigation follows.";
    const fireId = await fire();
    const done = await eventually(() => t.fires.get(fireId)?.receipt ? t.fires.get(fireId) : undefined);
    assert.deepEqual(done.target, { kind: "dedicated", threadId: ref, via: "headless" });
    assert.equal(done.receipt?.source, "final-answer");
    assert.equal(done.receipt?.summary, "Earnings beat; volume rose.");
    const resumed = t[host].runs[1]!;
    assert.deepEqual({ sessionId: resumed.sessionId, cwd: resumed.cwd, sandbox: resumed.sandbox, timeoutMs: resumed.timeoutMs }, { sessionId: `${idPrefix}_1`, cwd: t.paths.logs, sandbox: "workspace-write", timeoutMs: 20 * 60_000 });
    assert.match(resumed.message, /Find out why the price moved\./);
    assert.match(resumed.message, /<trigger-data trust="untrusted">[\s\S]*"price": 200/);
    const notification = await eventually(() => t.notifier.sent[0]);
    assert.equal(notification.threadId, ref);
    assert.equal(notification.body, "Earnings beat; volume rose.");
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(t[host].runs.length, 2, "one seed and one fire, even after later ticks");
    assert.equal(t.notifier.sent.length, 1);
    noOtherHostRuns();
  });

  it("rejects an origin target both when drafting and when updating an existing CLI trigger", async () => {
    await assert.rejects(t.service.createDraft({ definition: t.definition({ target: { kind: "origin" } }), code: STATE_PROBE }, fromHost()), new RegExp(`${name} currently supports dedicated result sessions`));
    assert.equal(t.store.hasTrigger("price-alert"), false);
    await t.activate({}, STATE_PROBE, fromHost());
    const ref = await ownSession();
    assert.throws(() => t.service.updateTrigger({ triggerId: "price-alert", changes: { target: { kind: "origin" } } }, fromHost()), new RegExp(`${name} currently supports dedicated result sessions`));
    assert.deepEqual(t.store.loadTrigger("price-alert").definition.target, { kind: "dedicated", cwd: t.paths.home, thread_id: ref });
    noOtherHostRuns();
  });

  it("replaces a missing result session, recovers the same fire, and reuses its replacement", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    const oldRef = await ownSession();
    const oldId = oldRef.slice(3);
    const run = t[host].run.bind(t[host]);
    t[host].run = async (options) => {
      const result = await run(options);
      return options.sessionId === oldId ? { ok: false, sessionGone: true, error: "native resume target is missing" } : result;
    };
    const fireId = await fire();
    await eventually(() => t.fires.get(fireId)?.failures === 1 && t.executor.status().activeAgentRuns === 0);
    assert.equal(t.fires.get(fireId)?.status, "pending");
    assert.equal(t.fires.get(fireId)?.receipt, undefined);
    assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, null);
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(t[host].runs.length, 2, "a missing target uses the bounded retry delay");
    t.clock.at += 30_000;
    await t.executor.tick();
    const done = await eventually(() => t.fires.get(fireId)?.status === "done" ? t.fires.get(fireId) : undefined);
    const replacement = await ownSession();
    assert.notEqual(replacement, oldRef);
    assert.equal(done.target?.threadId, replacement);
    assert.equal(done.receipt?.source, "final-answer");
    assert.equal(t.fires.forTrigger("price-alert").length, 1, "recovery keeps the original fire id and budget entry");
    assert.equal(t[host].runs.length, 4, "one failed resume, one seed, one successful retry");
    server.price = 100;
    await t.engine.runNow("price-alert");
    const second = await fire();
    await eventually(() => t.fires.get(second)?.status === "done");
    assert.equal(t[host].runs.length, 5);
    assert.equal(t[host].runs.at(-1)?.sessionId, replacement.slice(3));
    assert.equal(t.notifier.sent.length, 2, "each completed event sends one result notification");
    noOtherHostRuns();
  });

  it("recovers an already charged fire at the daily budget limit without admitting another fire", async () => {
    t.cleanup();
    t = setup(server, { budget: { ...DEFAULT_CONFIG.budget, maxAgentRunsPerDay: 1 } });
    await t.activate({}, STATE_PROBE, fromHost());
    const oldId = (await ownSession()).slice(3);
    const run = t[host].run.bind(t[host]);
    t[host].run = async (options) => {
      const result = await run(options);
      return options.sessionId === oldId ? { ok: false, sessionGone: true, error: "native resume target is missing" } : result;
    };
    const fireId = await fire();
    await eventually(() => t.fires.get(fireId)?.failures === 1);
    t.clock.at += 30_000;
    await t.executor.tick();
    await eventually(() => t.fires.get(fireId)?.status === "done");
    server.price = 100;
    await t.engine.runNow("price-alert");
    const second = await fire();
    await eventually(() => t.fires.get(second)?.status === "skipped");
    assert.match(t.fires.get(second)?.skippedBecause ?? "", /daily agent budget/);
    assert.equal(t[host].runs.length, 4, "budget recovery cannot start another event");
  });

  it("bounds recovery when every replacement session is also missing", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    await ownSession();
    const run = t[host].run.bind(t[host]);
    t[host].run = async (options) => {
      const result = await run(options);
      return options.sessionId ? { ok: false, sessionGone: true, error: "native resume target is missing" } : result;
    };
    const fireId = await fire();
    await eventually(() => t.fires.get(fireId)?.failures === 1 && t.executor.status().activeAgentRuns === 0);
    for (const [index, delay] of [30_000, 120_000, 600_000].entries()) {
      t.clock.at += delay;
      await t.executor.tick();
      await eventually(() => (index === 2 ? t.fires.get(fireId)?.status === "failed" : t.fires.get(fireId)?.failures === index + 2)
        && t.executor.status().activeAgentRuns === 0);
    }
    const count = t[host].runs.length;
    t.clock.at += 24 * 60 * 60_000;
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(t.fires.get(fireId)?.status, "failed");
    assert.equal(t.fires.get(fireId)?.receipt, undefined);
    assert.equal(t[host].runs.filter((options) => options.sessionId).length, 4);
    assert.equal(t[host].runs.length, count, "an exhausted fire cannot recreate sessions indefinitely");
    assert.equal(t.notifier.sent.length, 1);
  });

  it("does not replay a missing-session result after the fire has already reported", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    const ref = await ownSession();
    const run = t[host].run.bind(t[host]);
    let fireId: string;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t[host].run = async (options) => {
      await run(options);
      await gate;
      t.service.report({ fireId, summary: "Already handled", notify: false }, fromHost({ threadId: ref }));
      return { ok: false, sessionGone: true, error: "native resume target is missing" };
    };
    try {
      fireId = await fire();
      await eventually(() => t[host].runs.length === 2);
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
      t.clock.at += 30_000;
      await t.executor.tick();
      assert.equal(t.fires.get(fireId)?.receipt?.source, "tool");
      assert.equal(t.fires.get(fireId)?.failures, 0);
      assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, ref);
      assert.equal(t[host].runs.length, 2);
    } finally {
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
    }
  });

  it("does not switch hosts when an imported missing session has no matching origin", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    const ref = await ownSession();
    const definition = t.store.loadTrigger("price-alert").definition;
    definition.meta.origin_thread_id = null;
    t.store.saveDefinition(definition);
    const run = t[host].run.bind(t[host]);
    t[host].run = async (options) => {
      await run(options);
      return { ok: false, sessionGone: true, error: "native resume target is missing" };
    };
    const fireId = await fire();
    await eventually(() => t.executor.status().activeAgentRuns === 0 && t.logs.some((line) => /no matching host origin/.test(line)));
    t.clock.at += 30_000;
    await t.executor.tick();
    assert.equal(t.fires.get(fireId)?.failures, 0);
    assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, ref);
    assert.equal(t[host].runs.length, 2);
    noOtherHostRuns();
  });

  for (const change of ["revision", "host", "binding", "deletion and recreation"] as const) {
    it(`does not replace a newer result session after an old missing-session failure and ${change}`, async () => {
      await t.activate({}, STATE_PROBE, fromHost());
      const oldRef = await ownSession();
      const run = t[host].run.bind(t[host]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      t[host].run = async (options) => {
        const result = await run(options);
        if (!options.sessionId) return result;
        await gate;
        return { ok: false, sessionGone: true, error: "native resume target is missing" };
      };
      try {
        const fireId = await fire();
        await eventually(() => t[host].runs.length === 2);
        if (change === "revision") t.service.updateTrigger({ triggerId: "price-alert", changes: { action: { prompt: "A newer task" } } }, fromHost());
        else if (change === "host") await replaceWithClaude();
        else if (change === "binding") {
          const definition = t.store.loadTrigger("price-alert").definition;
          definition.target.thread_id = `${refPrefix}${idPrefix}_replacement`;
          t.store.saveDefinition(definition);
        } else {
          t.service.delete({ triggerId: "price-alert" }, { via: "cli" });
          t.clock.at += 1;
          await t.activate({}, STATE_PROBE, fromHost());
        }
        const expected = change === "host" ? t.store.loadTrigger("price-alert").definition.target.thread_id : await ownSession();
        release();
        await eventually(() => t.executor.status().activeAgentRuns === 0);
        assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, expected);
        if (change !== "revision") assert.notEqual(expected, oldRef);
        assert.equal(t.fires.get(fireId)?.failures, 0);
        assert.equal(t.fires.get(fireId)?.status, change === "deletion and recreation" ? "done" : "skipped");
        t.clock.at += 30_000;
        await t.executor.tick();
        assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, expected);
      } finally {
        release();
        await eventually(() => t.executor.status().activeAgentRuns === 0);
      }
    });
  }

  it("does not conflate identical session and turn ids from different hosts", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    const ref = await ownSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t[host].during = (options) => options.sessionId ? gate : undefined;
    try {
      const fireId = await fire();
      await eventually(() => t[host].runs.length === 2);
      const sameTurn = "shared-turn-id";
      assert.throws(() => t.service.report({ fireId, summary: "Wrong host", notify: false }, fromHost({ threadId: `${otherPrefix}${idPrefix}_1`, turnId: sameTurn })), /delivered to a different thread/);
      assert.equal(t.fires.get(fireId)?.receipt, undefined, "another host cannot report this session's fire");
      t.service.report({ fireId, summary: "Handled", notify: false }, fromHost({ threadId: ref, turnId: sameTurn }));
      await assert.rejects(t.service.createDraft({ definition: t.definition({ id: "refused" }), code: STATE_PROBE }, fromHost({ threadId: ref, turnId: sameTurn })), (error: ServiceError) => error.code === "refused");
      for (const threadId of [`${idPrefix}_1`, `cc:${idPrefix}_1`, `${otherPrefix}${idPrefix}_1`, `${refPrefix}${idPrefix}_other`]) {
        const draft = await t.service.createDraft({ definition: t.definition({ id: `from-${threadId.replace(/[:_]/g, "-")}` }), code: STATE_PROBE }, fromThread({ threadId, turnId: sameTurn }));
        assert.ok(draft.draftId, `an unrelated conversation ${threadId} remains free`);
      }
    } finally {
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
    }
    noOtherHostRuns();
  });

  it("keeps trusted trigger turns guarded after a receipt and a new turn id, while allowing only their trigger to become quieter", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    await t.activate({ id: "other", name: "Other" }, STATE_PROBE, fromHost());
    const ref = await ownSession();
    const other = await ownSession("other");
    assert.notEqual(ref, other, "each dedicated trigger owns a separate session");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t[host].during = (options) => options.sessionId ? gate : undefined;
    try {
      const fireId = await fire();
      await eventually(() => t[host].runs.some((run) => run.sessionId));
      const caller = fromHost({ threadId: ref, turnId: "fire-turn", turnTrigger: "self-starter" });
      t.service.report({ fireId, summary: "Handled", notify: false }, caller);
      const later = { ...caller, turnId: "another-tool-turn" };
      await assert.rejects(t.service.createDraft({ definition: t.definition({ id: "injected" }), code: STATE_PROBE }, later), /this turn was started by Self-Starter/);
      assert.throws(() => t.service.updateTrigger({ triggerId: "price-alert", changes: { policy: { cooldown: "1h" } } }, later), /this turn was started by Self-Starter/);
      await assert.rejects(t.service.tuneTrigger({ triggerId: "other", reason: "Too noisy", cooldown: "1h" }, later), (error: ServiceError) => error.code === "refused");
      const tuned = await t.service.tuneTrigger({ triggerId: "price-alert", reason: "Only report substantial changes", cooldown: "1h" }, later);
      assert.deepEqual(tuned.changes, ["waits 1h after a fire (was no wait)"]);
      await eventually(() => t.notifier.sent.find((notice) => notice.title === `Price above 150: ${name} made it quieter`));
    } finally {
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
    }
  });

  it("shares concurrency and daily budgets with the other hosts", async () => {
    t.cleanup();
    t = setup(server, { budget: { maxAgentRunsPerDay: 2, maxConcurrentAgentRuns: 1 } });
    await t.activate({}, STATE_PROBE, fromHost());
    await ownSession();
    await t.activate({ id: "claude-watch", target: { kind: "origin" } }, STATE_PROBE, fromThread({ threadId: "cc:shared" }));
    await t.activate({ id: "codex-watch", target: { kind: "origin" } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.claude.during = () => gate;
    try {
      const claudeFire = await fire("claude-watch");
      await eventually(() => t.claude.runs.length === 1);
      const cliFire = await fire();
      await eventually(() => t.fires.get(cliFire)?.status === "delivered");
      await t.executor.tick();
      assert.equal(t[host].runs.length, 1, "the CLI fire waits for the shared run slot");
      const overBudget = await fire("codex-watch");
      await eventually(() => t.fires.get(overBudget)?.status === "skipped");
      assert.equal(t.codex.queued.length, 0, "other hosts share the two-run daily limit");
      await eventually(() => t.notifier.sent.find((notice) => /daily limit of 2 runs is used up/.test(notice.body)));
      release();
      await eventually(() => t.fires.get(claudeFire)?.status === "done" && t.fires.get(cliFire)?.status === "done");
      assert.equal(t[host].runs.length, 2);
    } finally {
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
    }
  });

  it("waits for a CLI turn to exit after its tool receipt before resuming the same session for another event", async () => {
    t.cleanup();
    t = setup(server, { budget: { ...DEFAULT_CONFIG.budget, maxConcurrentAgentRuns: 2 } });
    await t.activate({ mode: "event", policy: { concurrency: "queue" } }, EVENT_PROBE, fromHost());
    const ref = await ownSession();
    await t.engine.runNow("price-alert"); // The empty feed is the baseline.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t[host].during = (options) => options.sessionId && t[host].runs.length === 2 ? gate : undefined;
    try {
      server.events.push({ id: "first", title: "First event" });
      const first = (await t.engine.runNow("price-alert"))!.fireId!;
      await eventually(() => t[host].runs.length === 2);
      t.service.report({ fireId: first, summary: "First event handled", notify: false }, fromHost({ threadId: ref, turnId: "first-fire" }));
      assert.equal(t.fires.get(first)?.status, "done");
      assert.equal(t.executor.status().activeAgentRuns, 1, "the reported turn still owns its session");

      server.events.push({ id: "second", title: "Second event" });
      const second = (await t.engine.runNow("price-alert"))!.fireId!;
      assert.ok(second);
      await eventually(() => t.fires.get(second)?.status === "delivered");
      for (let n = 0; n < 3; n++) await t.executor.tick();
      assert.equal(t[host].runs.length, 2, "a free global run slot cannot overlap turns in the same session");
      assert.equal(t.fires.get(second)?.target?.via, undefined, "the second event has not started its turn");

      release();
      await eventually(() => t.fires.get(second)?.status === "done");
      assert.equal(t[host].runs.length, 3);
      assert.equal(t[host].runs[2]!.sessionId, t[host].runs[1]!.sessionId);
      assert.equal(t.fires.get(first)?.receipt?.source, "tool", "finishing the old turn preserves its tool receipt");
      assert.equal(t.fires.get(second)?.receipt?.source, "final-answer");
    } finally {
      release();
      await eventually(() => t.executor.status().activeAgentRuns === 0);
    }
    noOtherHostRuns();
  });

  for (const replacementHost of ["codex", "claude-code"] as const) {
    it(`starts the replacement ${replacementHost} conversation independently of a pending CLI seed`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      t[host].during = () => gate;
      try {
        await t.activate({}, STATE_PROBE, fromHost());
        await eventually(() => t[host].runs.length === 1);
        assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, null);
        const caller = fromThread({ threadId: replacementHost === "codex" ? ORIGIN : "cc:replacement" });
        const draft = await t.service.createDraft({ definition: t.definition({ name: "Replacement", target: { kind: "dedicated", cwd: t.paths.home } }), code: STATE_PROBE, replace: true }, caller);
        t.service.activateDraft({ draftId: draft.draftId }, caller);
        const replacement = await ownSession();
        if (replacementHost === "codex") assert.equal(replacement, "thread-dedicated-1");
        else assert.match(replacement, /^cc:/);
        assert.equal(t.service.get({ triggerId: "price-alert" }).host, replacementHost);

        release();
        await eventually(() => t.logs.some((line) => line.includes("the trigger changed while its result session was being created")));
        assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, replacement, "the stale CLI result cannot bind to the replacement");
        assert.equal(t[host].runs.length, 1);
      } finally {
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
  }

  for (const change of ["revision update", "deletion and recreation"] as const) {
    it(`discards a CLI seed that completes after a ${change}, while a fresh seed is still pending`, async () => {
      let releaseOld!: () => void;
      let releaseCurrent!: () => void;
      const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
      const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
      t[host].during = () => t[host].runs.length === 1 ? oldGate : currentGate;
      try {
        await t.activate({}, STATE_PROBE, fromHost());
        await eventually(() => t[host].runs.length === 1);
        const before = t.store.loadTrigger("price-alert").definition;
        if (change === "revision update") {
          t.service.updateTrigger({ triggerId: "price-alert", changes: { target: { cwd: t.paths.logs } } }, fromHost());
          assert.equal(t.store.loadTrigger("price-alert").definition.meta.revision, before.meta.revision + 1);
        } else {
          t.service.delete({ triggerId: "price-alert" }, { via: "cli" });
          t.clock.at += 1;
          await t.activate({ target: { cwd: t.paths.logs } }, STATE_PROBE, fromHost());
          assert.notEqual(t.store.loadTrigger("price-alert").definition.meta.created_at, before.meta.created_at);
        }
        await eventually(() => t[host].runs.length === 2);
        assert.equal(t[host].runs[1]!.cwd, t.paths.logs, "the replacement starts its own seed using the new definition");

        releaseOld();
        await eventually(() => t.logs.some((line) => line.includes("the trigger changed while its result session was being created")));
        assert.equal(t.store.loadTrigger("price-alert").definition.target.thread_id, null, "the old session cannot bind while the current seed waits");
        releaseCurrent();
        assert.equal(await ownSession(), `${refPrefix}${idPrefix}_2`);
        noOtherHostRuns();
      } finally {
        releaseOld();
        releaseCurrent();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
  }

  it("keeps a busy CLI session queued without starting its receipt clock or retrying rapidly", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    const ref = await ownSession();
    t.clock.uptime = t.clock.at;
    t[host].busy = true;
    let attempts = 0;
    const run = t[host].run.bind(t[host]);
    t[host].run = async (options) => {
      attempts += 1;
      return run(options);
    };
    const fireId = await fire();
    await eventually(() => attempts === 1 && t.executor.status().activeAgentRuns === 0);
    assert.equal(t.fires.get(fireId)?.status, "delivered");
    assert.deepEqual(t.fires.get(fireId)?.target, { kind: "dedicated", threadId: ref });
    assert.equal(t.fires.get(fireId)?.wokenAt, undefined);
    assert.equal(t.fires.get(fireId)?.receipt, undefined);

    t.clock.at += 31 * 60_000; // Sleep advances wall time, but not the retry timer's uptime.
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(attempts, 1, "a busy session waits for the retry interval despite repeated ticks");
    assert.equal(t.fires.get(fireId)?.status, "delivered", "a queued fire is neither dropped nor timed out");
    assert.equal(t.fires.get(fireId)?.wokenAt, undefined);
    assert.equal(t.fires.get(fireId)?.receipt, undefined, "the receipt deadline starts only after the prompt starts");

    t.service.updateTrigger({ triggerId: "price-alert", changes: { probe: { interval: { default: "2m" } } } }, fromHost());
    t[host].busy = false;
    t.clock.uptime += 59_999;
    await t.executor.tick();
    assert.equal(attempts, 1);
    t.clock.uptime += 1;
    await t.executor.tick();
    const done = await eventually(() => t.fires.get(fireId)?.status === "done" ? t.fires.get(fireId) : undefined);
    assert.equal(done.receipt?.source, "final-answer");
    assert.equal(done.target?.via, "headless");
    assert.equal(done.wokenAt, new Date(t.clock.at).toISOString());
    assert.equal(done.deliveredAt, done.wokenAt, "time waiting for the session does not consume the receipt window");
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(attempts, 2, "one busy response and one actual execution of this fire");
    assert.equal(t.fires.forTrigger("price-alert").length, 1);
    noOtherHostRuns();
  });

  for (const change of ["another host", "notification only"] as const) {
    it(`discards a queued CLI fire when its watch changes to ${change}`, async () => {
      await t.activate({}, STATE_PROBE, fromHost());
      await ownSession();
      t[host].busy = true;
      const fireId = await fire();
      await eventually(() => t[host].runs.length === 2 && t.executor.status().activeAgentRuns === 0);
      assert.equal(t.fires.get(fireId)?.target?.via, undefined);
      if (change === "another host") await replaceWithClaude();
      else t.service.updateTrigger({ triggerId: "price-alert", changes: { action: { type: "notify" } } }, fromHost());

      t[host].busy = false;
      t.clock.at += 60_000;
      await t.executor.tick();
      assert.equal(t.fires.get(fireId)?.status, "skipped");
      assert.match(t.fires.get(fireId)?.skippedBecause ?? "", /action or result session changed/);
      assert.equal(t[host].runs.length, 2, "the old session never runs the changed action");
      assert.equal(t.fires.get(fireId)?.wokenAt, undefined);
      noOtherHostRuns();
    });
  }

  for (const [change, update] of [
    ["another host", replaceWithClaude],
    ["notification only", () => t.service.updateTrigger({ triggerId: "price-alert", changes: { action: { type: "notify" } } }, fromHost())],
    ["deletion", () => t.service.delete({ triggerId: "price-alert" }, { via: "cli" })],
    ["read-only permissions", () => t.service.updateTrigger({ triggerId: "price-alert", changes: { action: { sandbox: "read-only" } } }, fromHost())],
    ["a new task", () => t.service.updateTrigger({ triggerId: "price-alert", changes: { action: { prompt: "Report without changing anything" } } }, fromHost())],
    ["a different folder", () => t.service.updateTrigger({ triggerId: "price-alert", changes: { target: { cwd: t.paths.logs } } }, fromHost())],
  ] as const) {
    it(`cancels a CLI action before CLI authorization after ${change}`, async () => {
      await t.activate({}, STATE_PROBE, fromHost());
      await ownSession();
      let entered = false;
      let ran = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const run = t[host].run.bind(t[host]);
      t[host].run = async (options) => {
        entered = true;
        await gate; // The session owner has not called onStart or launched the CLI yet.
        try { return await run(options); }
        catch (error) { return { ok: false, error: (error as Error).message }; }
      };
      t[host].during = () => { ran = true; };
      try {
        const fireId = await fire();
        await eventually(() => entered);
        assert.equal(t.fires.get(fireId)?.target?.via, undefined);
        await update();

        release();
        await eventually(() => t.executor.status().activeAgentRuns === 0);
        const cancelled = t.fires.get(fireId)!;
        assert.equal(cancelled.status, change === "deletion" ? "done" : "skipped");
        assert.equal(cancelled.receipt?.source, change === "deletion" ? "closed" : undefined);
        assert.equal(cancelled.target?.via, undefined, "cancellation cannot become a failed execution attempt");
        assert.equal(cancelled.wokenAt, undefined);
        assert.equal(ran, false, "the owner's authorization callback stops the CLI before it can run");
        await t.executor.tick();
        assert.equal(t.fires.get(fireId)?.status, cancelled.status, "the cancelled fire stays closed");
        noOtherHostRuns();
      } finally {
        release();
        await eventually(() => t.executor.status().activeAgentRuns === 0);
      }
    });
  }

  it("records a missing CLI runner as a retryable delivery failure without choosing another host", async () => {
    t.cleanup();
    t = setup(server, {}, host !== "zcode", host !== "opencode");
    await t.activate({}, STATE_PROBE, fromHost());
    const fireId = await fire();
    const failed = await eventually(() => t.fires.get(fireId)!.failures >= 1 ? t.fires.get(fireId) : undefined);
    assert.equal(failed.status, "pending");
    assert.match(failed.error ?? "", new RegExp(`the ${host} CLI was not found`));
    assert.equal(failed.target, undefined);
    assert.equal(failed.receipt, undefined);
    assert.equal(t[host].runs.length, 0);
    noOtherHostRuns();
  });

  it("does not turn a failed CLI run into a successful receipt or duplicate it on later ticks", async () => {
    await t.activate({}, STATE_PROBE, fromHost());
    await ownSession();
    t[host].error = `${host}: authentication failed`;
    const fireId = await fire();
    await eventually(() => t.logs.find((line) => line.includes("authentication failed")));
    assert.equal(t.fires.get(fireId)?.receipt, undefined);
    assert.equal(t.fires.get(fireId)?.target?.via, "headless");
    for (let n = 0; n < 3; n++) await t.executor.tick();
    assert.equal(t[host].runs.length, 2, "a failed task is not silently executed again");
    t.clock.at += 31 * 60_000;
    await t.executor.tick();
    assert.equal(t.fires.get(fireId)?.receipt?.source, "timeout");
    assert.match((await eventually(() => t.notifier.sent[0])).body, new RegExp(`no reply from ${name}`));
    noOtherHostRuns();
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
      assert.equal(view.trial?.ok, true, view.trial?.error ?? "probe trial failed");
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
