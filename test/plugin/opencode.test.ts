import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tool, type PluginInput, type ToolContext } from "@opencode-ai/plugin";
import { startControlServer } from "../../src/daemon/control.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { resolvePaths } from "../../src/engine/paths.js";
import type { Caller } from "../../src/engine/service.js";
import { TOOLS } from "../../src/mcp/server.js";
import { createSelfStarterPlugin } from "../../src/opencode/plugin.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { makeDefinition } from "../helpers.js";

function context(messageID = "assistant-1", sessionID = "ses_result"): ToolContext {
  return {
    sessionID, messageID, directory: "/project/worktree", worktree: "/project", agent: "build",
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  };
}

function host(messages: Record<string, { id: string; role: "user" } | { id: string; role: "assistant"; parentID: string }>) {
  const requests: unknown[] = [];
  const input = {
    client: { session: { message: async (request: { path: { messageID: string } }) => {
      requests.push(request);
      return { data: { info: messages[request.path.messageID], parts: [] } };
    } } },
  } as unknown as PluginInput;
  return { input, requests };
}

describe("OpenCode's native trigger tools", () => {
  it("shares the tool definitions, preserves probe objects, and appends its instructions", async () => {
    const { input } = host({});
    const plugin = await createSelfStarterPlugin(input);
    assert.deepEqual(Object.keys(plugin.tool!), TOOLS.map(({ name }) => name));
    const definition = { id: "watch", probe: { params: { file: "a.log" } }, target: { kind: "dedicated" } };
    const draft = tool.schema.object(plugin.tool!.trigger_draft!.args);
    assert.deepEqual(draft.parse({ definition, code: "console.log('{}');" }), { definition, code: "console.log('{}');" });
    assert.equal(draft.safeParse({ code: "missing definition" }).success, false);
    const tune = tool.schema.object(plugin.tool!.trigger_tune!.args);
    for (const max_fires of [0, 1.5, "2"]) {
      assert.equal(tune.safeParse({ trigger_id: "watch", reason: "too noisy", max_fires }).success, false);
    }
    assert.equal(tune.safeParse({ trigger_id: "watch", reason: "too noisy", max_fires: 2 }).success, true);
    const output = { system: ["Existing instructions"] };
    await plugin["experimental.chat.system.transform"]!({ model: {} as never }, output);
    assert.equal(output.system[0], "Existing instructions");
    assert.match(output.system[1]!, /dedicated CLI session/);
    assert.match(output.system[1]!, /<trigger-data trust="untrusted">/);
    assert.match(output.system[1]!, /restriction still applies after reporting/);
    assert.doesNotMatch(output.system[1]!, /^---/);
  });

  it("binds calls to the host's session, user turn and directory rather than tool arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "ss-opencode-tool-"));
    const paths = resolvePaths(home);
    const requests: Array<{ params: Record<string, unknown>; caller: Caller }> = [];
    const server = await startControlServer(paths.socket, {
      "trigger.get": (params, caller) => { requests.push({ params, caller }); return { id: params.triggerId }; },
    }, () => {});
    let starts = 0;
    const { input, requests: messages } = host({
      "assistant-1": { id: "assistant-1", role: "assistant", parentID: "user-1" },
      "assistant-2": { id: "assistant-2", role: "assistant", parentID: "user-1" },
      "user-2": { id: "user-2", role: "user" },
    });
    try {
      const plugin = await createSelfStarterPlugin(input, { home, ensureDaemon: async (seen) => {
        assert.equal(seen.home, home);
        starts++;
      } });
      for (const message of ["assistant-1", "assistant-2", "user-2"]) {
        const result = await plugin.tool!.trigger_get!.execute({
          trigger_id: "watch", caller: { via: "cli", threadId: "other" }, sessionID: "other", cwd: "/other",
        }, context(message));
        assert.match(String(result), /"id": "watch"/);
      }
      assert.equal(starts, 3);
      assert.deepEqual(requests, ["user-1", "user-1", "user-2"].map((turnId) => ({
        params: { triggerId: "watch" },
        caller: { via: "mcp", threadId: "oc:ses_result", turnId, cwd: "/project/worktree" },
      })));
      assert.deepEqual(messages[0], {
        path: { id: "ses_result", messageID: "assistant-1" },
        query: { directory: "/project/worktree" }, throwOnError: true,
      });
      await assert.rejects(plugin.tool!.trigger_get!.execute({ trigger_id: "watch" }, context("missing")), /user message/);
      assert.equal(requests.length, 3, "missing provenance must not reach the daemon");
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the fire guard after a receipt across assistant messages, and releases it for a new user turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "ss-opencode-guard-"));
    const daemon = await startDaemon({ paths: resolvePaths(home), codex: () => undefined });
    daemon.engine.stop();
    daemon.executor.close();
    const { input } = host({
      "assistant-1": { id: "assistant-1", role: "assistant", parentID: "user-fire" },
      "assistant-2": { id: "assistant-2", role: "assistant", parentID: "user-fire" },
      "assistant-3": { id: "assistant-3", role: "assistant", parentID: "user-next" },
    });
    try {
      const definition = makeDefinition({ target: { kind: "dedicated", thread_id: "oc:ses_result" } });
      daemon.store.saveDefinition(definition);
      writeFileSync(join(daemon.store.triggerDir(definition.id), definition.probe.entry), "console.log('{}');");
      const fire = daemon.fires.create({ triggerId: definition.id, revision: 1, fireNumber: 1, reason: "condition", summary: "Ready" });
      daemon.fires.record({ type: "delivered", fireId: fire.fireId, target: { kind: "dedicated", threadId: "oc:ses_result", via: "headless" }, at: new Date().toISOString() });
      const plugin = await createSelfStarterPlugin(input, { home, ensureDaemon: async () => {} });
      const pause = (messageID: string) => plugin.tool!.trigger_pause!.execute({ trigger_id: definition.id }, context(messageID));
      await assert.rejects(pause("assistant-1"), /Cannot pause/);
      await assert.rejects(plugin.tool!.trigger_report!.execute({ fire_id: fire.fireId, summary: "Done", notify: false }, context("assistant-1", "ses_wrong")), /different thread/);
      await plugin.tool!.trigger_report!.execute({ fire_id: fire.fireId, summary: "Done", notify: false }, context());
      assert.equal(daemon.fires.get(fire.fireId)?.status, "done");
      await assert.rejects(pause("assistant-2"), /this turn handled a trigger fire/);
      await pause("assistant-3");
      assert.equal(daemon.store.loadRuntime(definition.id)?.lifecycle, "paused");
    } finally {
      await daemon.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks every tool call from a background process as a fire turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "ss-opencode-provenance-"));
    const paths = resolvePaths(home);
    let caller: Caller | undefined;
    const server = await startControlServer(paths.socket, { status: (_params, value) => { caller = value; return {}; } }, () => {});
    const saved = process.env.SELF_STARTER_TRIGGER_TURN;
    try {
      process.env.SELF_STARTER_TRIGGER_TURN = "1";
      const { input } = host({ "assistant-1": { id: "assistant-1", role: "assistant", parentID: "user-fire" } });
      const plugin = await createSelfStarterPlugin(input, { home, ensureDaemon: async () => {} });
      delete process.env.SELF_STARTER_TRIGGER_TURN;
      await plugin.tool!.service_status!.execute({}, context());
      assert.equal(caller?.turnTrigger, "self-starter", "provenance belongs to the plugin instance, not later environment changes");
    } finally {
      if (saved === undefined) delete process.env.SELF_STARTER_TRIGGER_TURN;
      else process.env.SELF_STARTER_TRIGGER_TURN = saved;
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("honors native tool approval before contacting the service", async () => {
    const { input, requests } = host({});
    let started = false;
    const plugin = await createSelfStarterPlugin(input, { ensureDaemon: async () => { started = true; } });
    const denied = context();
    denied.ask = async (request) => {
      assert.equal(request.permission, "trigger_activate");
      throw new Error("permission denied");
    };
    await assert.rejects(plugin.tool!.trigger_activate!.execute({ draft_id: "draft-example" }, denied), /permission denied/);
    assert.equal(started, false);
    assert.equal(requests.length, 0, "a denied call does not query the session or start the service");
  });

  it("has one plugin entry point so OpenCode does not register it twice", async () => {
    const entry = new URL("../../../opencode-plugin/index.mjs", import.meta.url);
    const module = await import(entry.href);
    assert.deepEqual(Object.keys(module), ["default"]);
    assert.equal(module.default, createSelfStarterPlugin);
    assert.match(readFileSync(join(PACKAGE_ROOT, "opencode-plugin", "README.md"), "utf8"), /1\.19\.3/);
  });
});
