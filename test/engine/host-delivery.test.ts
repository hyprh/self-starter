import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  agentName,
  conversationNoun,
  formatRef,
  HOST_SPECS,
  hostOf,
  HOSTS,
  hostSpec,
  parseRef,
  reopen,
  supportsOrigin,
} from "../../src/core/conversations.js";
import type { TriggerDefinition } from "../../src/core/definition.js";
import { describeAction } from "../../src/core/describe.js";
import { DEFAULT_CONFIG, type Config } from "../../src/engine/config.js";
import { CliSessionDeliveryStrategy } from "../../src/engine/delivery/cli-session-delivery.js";
import { Executor } from "../../src/engine/executor.js";
import { FireLog, type FireRecord } from "../../src/engine/fires.js";
import type { DeliveryRuntime, HostDeliveryStrategy } from "../../src/engine/host-delivery.js";
import { Store } from "../../src/engine/store.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { makeDefinition } from "../helpers.js";
import { eventually, FakeCodex, FakeZCode, RecordingNotifier, tempHome } from "./fixtures.js";

describe("HOST_SPECS declarative host registry", () => {
  it("round-trips conversation references, enforces unambiguous prefixes, and aligns origin capabilities", () => {
    const nonEmptyPrefixes: string[] = [];
    for (const host of HOSTS) {
      const spec = hostSpec(host);
      assert.equal(spec, HOST_SPECS[host]);
      assert.equal(spec.host, host);
      assert.equal(agentName(host), spec.agentName);
      assert.equal(conversationNoun(host), spec.noun);
      assert.equal(supportsOrigin(host), spec.supportsOrigin);
      assert.equal(typeof spec.originBackgroundNote === "function", spec.supportsOrigin);

      if (host === "codex") {
        assert.equal(spec.prefix, "");
      } else {
        assert.ok(spec.prefix.endsWith(":"), `${host} prefix "${spec.prefix}" must end with ":"`);
        nonEmptyPrefixes.push(spec.prefix);
      }

      const sampleId = "conv_12345";
      const ref = formatRef(host, sampleId);
      assert.deepEqual(parseRef(ref), { host, id: sampleId });
      assert.equal(hostOf(ref), host);
      assert.deepEqual(reopen(ref), spec.reopen(sampleId));

      const def = makeDefinition({
        target: { kind: "dedicated", thread_id: ref, cwd: "/tmp/work" },
        action: { type: "agent", prompt: "Inspect it.", sandbox: "workspace-write" },
      });
      const text = describeAction(def);
      assert.ok(text.startsWith(`${spec.agentName} works on this in ${spec.dedicatedTargetPhrase}`));
      assert.ok(text.includes(spec.sandboxDescriptions["workspace-write"]));
    }

    assert.equal(new Set(nonEmptyPrefixes).size, nonEmptyPrefixes.length, "non-empty host prefixes must be unique");
    for (let i = 0; i < nonEmptyPrefixes.length; i++) {
      for (let j = 0; j < nonEmptyPrefixes.length; j++) {
        if (i !== j) {
          assert.equal(
            nonEmptyPrefixes[i]!.startsWith(nonEmptyPrefixes[j]!),
            false,
            `prefix "${nonEmptyPrefixes[j]}" collides as a prefix of "${nonEmptyPrefixes[i]}"`,
          );
        }
      }
    }

    assert.equal(parseRef(null), undefined);
    assert.equal(parseRef(undefined), undefined);
    assert.equal(hostOf(null), "codex");
    assert.equal(hostOf(undefined), "codex");
    assert.deepEqual(
      HOSTS.filter((h) => supportsOrigin(h)),
      ["codex", "claude-code"],
    );
  });

  it("keeps src/core free of node:* runtime imports and upward layer dependencies", () => {
    const coreDir = join(PACKAGE_ROOT, "src", "core");
    for (const entry of readdirSync(coreDir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(coreDir, entry), "utf8");
      assert.doesNotMatch(source, /["']node:/, `src/core/${entry} must stay pure TypeScript without node:* imports`);
      assert.doesNotMatch(
        source,
        /from\s+["']\.\.\/(?!core\/)/,
        `src/core/${entry} must not import outer runtime layers`,
      );
    }
  });
});

describe("HostDelivery strategy registry (Open/Closed & Dependency Inversion)", () => {
  it("injects custom strategies via DeliveryRuntime factory without exposing internal primitives on HostDelivery", async () => {
    const home = tempHome();
    try {
      const store = new Store(home.paths);
      store.ensureLayout();
      const fires = new FireLog(home.paths.fires);
      const notifier = new RecordingNotifier();
      const calls: string[] = [];
      let releaseTurn: (() => void) | undefined;

      const customStrategyFactory = (runtime: DeliveryRuntime): HostDeliveryStrategy => ({
        host: "zcode",
        prepareDedicated(triggerId: string) {
          calls.push(`prepare:${triggerId}`);
          const loaded = runtime.store.loadTrigger(triggerId);
          runtime.bindDedicated(loaded.definition, formatRef("zcode", "sess_custom"));
        },
        async deliver(_definition: TriggerDefinition, fire: FireRecord) {
          calls.push(`deliver:${fire.fireId}`);
          runtime.fires.record({
            type: "delivered",
            fireId: fire.fireId,
            target: { kind: "dedicated", threadId: formatRef("zcode", "sess_custom") },
            at: runtime.now().toISOString(),
          });
        },
        async follow(fire: FireRecord) {
          calls.push(`follow:${fire.fireId}`);
          if (fire.target?.via !== undefined || !runtime.runSlotFree()) return;
          runtime.wentIn(fire, "headless");
          runtime.runTurn(fire, "custom zcode strategy", async () => {
            await new Promise<void>((resolve) => {
              releaseTurn = resolve;
            });
            await runtime.completeTurn(fire, "Custom strategy completed the task.");
          });
        },
        forgetClosed(open: ReadonlySet<string>) {
          calls.push(`forget:${open.size}`);
        },
      });

      const config: Config = {
        ...DEFAULT_CONFIG,
        budget: { ...DEFAULT_CONFIG.budget, maxConcurrentAgentRuns: 1 },
      };

      const executor = new Executor({
        store,
        fires,
        paths: home.paths,
        config,
        notifier,
        codex: () => new FakeCodex(),
        strategies: [customStrategyFactory],
        log: () => {},
      });

      const def = makeDefinition({
        id: "custom-zcode",
        target: { kind: "dedicated" },
        meta: {
          created_at: new Date().toISOString(),
          activated_at: new Date().toISOString(),
          origin_thread_id: formatRef("zcode", "sess_origin"),
          revision: 1,
        },
      });
      const draft = store.createDraft(def, "console.log('{}');", { originThreadId: def.meta.origin_thread_id ?? null });
      store.promoteDraft(draft.meta.draftId, def);

      executor.prepareDedicatedThread(def.id);
      assert.equal(store.loadTrigger(def.id).definition.target.thread_id, "zc:sess_custom");

      const fire = executor.submit(
        store.loadTrigger(def.id).definition,
        { reason: "threshold crossed", summary: "Value is 42" },
        1,
      );
      await eventually(() => fires.get(fire.fireId)?.status === "delivered");
      await executor.tick();

      assert.equal(executor.status().activeAgentRuns, 1);
      assert.ok(releaseTurn, "custom strategy turn should be running");
      releaseTurn!();

      await eventually(() => fires.get(fire.fireId)?.receipt?.summary === "Custom strategy completed the task.");
      assert.equal(executor.status().activeAgentRuns, 0);

      await executor.tick();
      assert.ok(calls.includes("prepare:custom-zcode"));
      assert.ok(calls.includes(`deliver:${fire.fireId}`));
      assert.ok(calls.includes(`follow:${fire.fireId}`));
      assert.ok(calls.includes("forget:0"));
    } finally {
      home.cleanup();
    }
  });

  it("ignores foreign host refs in CliSessionDeliveryStrategy.follow without mutating the fire", async () => {
    const home = tempHome();
    try {
      const store = new Store(home.paths);
      store.ensureLayout();
      const fires = new FireLog(home.paths.fires);
      let recordedRuntime!: DeliveryRuntime;

      new Executor({
        store,
        fires,
        paths: home.paths,
        config: DEFAULT_CONFIG,
        notifier: new RecordingNotifier(),
        codex: () => new FakeCodex(),
        strategies: [
          (runtime) => {
            recordedRuntime = runtime;
            return new CliSessionDeliveryStrategy(runtime, "zcode", () => new FakeZCode());
          },
        ],
        log: () => {},
      });

      const agyDef = makeDefinition({
        id: "agy-only",
        target: { kind: "dedicated", thread_id: "agy:conv_1" },
        meta: {
          created_at: new Date().toISOString(),
          activated_at: new Date().toISOString(),
          origin_thread_id: "agy:conv_origin",
          revision: 1,
        },
      });
      const draft = store.createDraft(agyDef, "console.log('{}');", { originThreadId: agyDef.meta.origin_thread_id ?? null });
      store.promoteDraft(draft.meta.draftId, agyDef);

      const fire = fires.create({
        triggerId: agyDef.id,
        revision: 1,
        fireNumber: 1,
        reason: "test",
        summary: "test",
      });
      fires.record({
        type: "delivered",
        fireId: fire.fireId,
        target: { kind: "dedicated", threadId: "agy:conv_1" },
        at: new Date().toISOString(),
      });

      const zcodeStrategy = new CliSessionDeliveryStrategy(recordedRuntime, "zcode", () => new FakeZCode());
      await zcodeStrategy.follow(fires.get(fire.fireId)!, 0);
      assert.equal(fires.get(fire.fireId)?.status, "delivered", "foreign-host ref must not be marked skipped");
    } finally {
      home.cleanup();
    }
  });
});
