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
import { Executor } from "../../src/engine/executor.js";
import { FireLog, type FireRecord } from "../../src/engine/fires.js";
import { HostDelivery, type HostDeliveryStrategy } from "../../src/engine/host-delivery.js";
import { Store } from "../../src/engine/store.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { makeDefinition } from "../helpers.js";
import { eventually, FakeCodex, RecordingNotifier, tempHome } from "./fixtures.js";

describe("HOST_SPECS declarative host registry", () => {
  it("round-trips conversation references and metadata across every registered host", () => {
    for (const host of HOSTS) {
      const spec = hostSpec(host);
      assert.equal(spec, HOST_SPECS[host]);
      assert.equal(spec.host, host);
      assert.equal(agentName(host), spec.agentName);
      assert.equal(conversationNoun(host), spec.noun);
      assert.equal(supportsOrigin(host), spec.supportsOrigin);

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

    assert.equal(parseRef(null), undefined);
    assert.equal(parseRef(undefined), undefined);
    assert.equal(hostOf(null), "codex");
    assert.equal(hostOf(undefined), "codex");
    assert.deepEqual(
      HOSTS.filter((h) => supportsOrigin(h)),
      ["codex", "claude-code"],
    );
  });

  it("keeps src/core free of node:* runtime imports", () => {
    const coreDir = join(PACKAGE_ROOT, "src", "core");
    for (const entry of readdirSync(coreDir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(coreDir, entry), "utf8");
      assert.doesNotMatch(source, /from\s+["']node:/, `src/core/${entry} must stay pure TypeScript`);
    }
  });
});

describe("HostDelivery strategy registry (Open/Closed Principle)", () => {
  it("dispatches prepareDedicated, deliver, follow, and forgetClosed to an injected strategy", async () => {
    const home = tempHome();
    try {
      const store = new Store(home.paths);
      store.ensureLayout();
      const fires = new FireLog(home.paths.fires);
      const notifier = new RecordingNotifier();
      const calls: string[] = [];
      let releaseTurn: (() => void) | undefined;

      let deliveryRef!: HostDelivery;
      const customZcodeStrategy: HostDeliveryStrategy = {
        host: "zcode",
        prepareDedicated(triggerId: string) {
          calls.push(`prepare:${triggerId}`);
          const loaded = store.loadTrigger(triggerId);
          deliveryRef.bindDedicated(loaded.definition, formatRef("zcode", "sess_custom"));
        },
        async deliver(_definition: TriggerDefinition, fire: FireRecord) {
          calls.push(`deliver:${fire.fireId}`);
          fires.record({
            type: "delivered",
            fireId: fire.fireId,
            target: { kind: "dedicated", threadId: formatRef("zcode", "sess_custom") },
            at: new Date().toISOString(),
          });
        },
        async follow(fire: FireRecord) {
          calls.push(`follow:${fire.fireId}`);
          if (fire.target?.via !== undefined || !deliveryRef.runSlotFree()) return;
          deliveryRef.wentIn(fire, "headless");
          deliveryRef.runTurn(fire, "custom zcode strategy", async () => {
            await new Promise<void>((resolve) => {
              releaseTurn = resolve;
            });
            await deliveryRef.completeTurn(fire, "Custom strategy completed the task.");
          });
        },
        forgetClosed(open: ReadonlySet<string>) {
          calls.push(`forget:${open.size}`);
        },
      };

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
        strategies: [customZcodeStrategy],
        log: () => {},
      });
      // Access the internal delivery coordinator only to let the custom strategy bind runtime helpers in this test.
      deliveryRef = (executor as unknown as { delivery: HostDelivery }).delivery;

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

      // While the custom strategy holds the single run slot, activeAgentRuns reflects it globally.
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
});
