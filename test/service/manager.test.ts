import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { callDaemon, waitForDaemon } from "../../src/client/client.js";
import { initialRuntime } from "../../src/core/state-machine.js";
import { loadConfig, saveConfig } from "../../src/engine/config.js";
import { FireLog } from "../../src/engine/fires.js";
import { resolvePaths } from "../../src/engine/paths.js";
import type { FireView, TriggerSummary } from "../../src/engine/service.js";
import { Store } from "../../src/engine/store.js";
import { VERSION } from "../../src/runtime.js";
import { compareVersions, daemonVersion, ensureDaemon, installService, launchdPlist, serviceSpec, stopRunningDaemon, systemdUnit, type ServiceManager, type ServiceSpec } from "../../src/service/manager.js";
import { tempHome } from "../engine/fixtures.js";
import { makeDefinition } from "../helpers.js";

/** Listens on the daemon's socket like a daemon of `version`, and stops when asked to. */
async function fakeDaemon(socket: string, version: string): Promise<{ stopped: boolean; close: () => Promise<void> }> {
  const state = { stopped: false, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  const server: Server = createServer((connection) => {
    connection.setEncoding("utf8");
    connection.on("data", (line: string) => {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      connection.end(`${JSON.stringify({ id, result: method === "ping" ? { version, pid: 1 } : {} })}\n`);
      if (method === "daemon.stop") {
        state.stopped = true;
        server.close();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return state;
}

describe("service manager", () => {
  for (const present of [false, true]) it(`pins the resolved state directory in service definitions when the caller's override is ${present ? "different" : "absent"}`, () => {
    const home = tempHome();
    const paths = resolvePaths(join(home.paths.home, `custom home 'single' "double" & <state>`));
    const saved = process.env.SELF_STARTER_HOME;
    try {
      if (present) process.env.SELF_STARTER_HOME = join(home.paths.home, "another-home");
      else delete process.env.SELF_STARTER_HOME;
      const spec = serviceSpec(paths, []);
      assert.equal(spec.env.SELF_STARTER_HOME, paths.home);
      assert.ok(launchdPlist(spec).includes(`<key>SELF_STARTER_HOME</key>\n      <string>${home.paths.home}/custom home 'single' "double" &amp; &lt;state&gt;</string>`));
      assert.ok(systemdUnit(spec).includes(`Environment="SELF_STARTER_HOME=${home.paths.home}/custom home 'single' \\"double\\" & <state>"`));
    } finally {
      if (saved === undefined) delete process.env.SELF_STARTER_HOME;
      else process.env.SELF_STARTER_HOME = saved;
      home.cleanup();
    }
  });

  it("keeps triggers, history and its command in a custom home after service reconstruction without the original override", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ss-service-home-"));
    const paths = resolvePaths(join(scratch, `custom home 'single' "double" $dollar`));
    const fallback = resolvePaths(join(scratch, "user", ".self-starter"));
    const other = resolvePaths(join(scratch, "another-home"));
    const saved = process.env.SELF_STARTER_HOME;
    const children: ChildProcess[] = [];
    const specs: ServiceSpec[] = [];
    // All possible fallback homes are isolated and opt out of native services,
    // so even a regression cannot touch the user's systemd/launchd registration.
    for (const p of [paths, fallback, other]) saveConfig(p, { ...loadConfig(p), service: false });
    const callerEnv: NodeJS.ProcessEnv = { ...process.env, HOME: join(scratch, "user") };
    delete callerEnv.SELF_STARTER_HOME;
    const manager: ServiceManager = {
      kind: "none", file: null, installed: () => false,
      install(spec) {
        specs.push(spec);
        const child = spawn(spec.node, [spec.script, "daemon"], { env: { ...callerEnv, ...spec.env }, stdio: "ignore" });
        child.once("error", () => {});
        children.push(child);
      },
      uninstall() {}, start: () => false, stop: () => false, restart: () => false,
    };
    const definition = makeDefinition({ id: "custom-home-check", action: { type: "notify" } });
    const store = new Store(paths);
    store.ensureLayout();
    const draft = store.createDraft(definition, "throw new Error('a paused trigger must not run');", { originThreadId: null });
    store.promoteDraft(draft.meta.draftId, definition);
    store.saveRuntime(definition.id, { ...initialRuntime(definition.meta.revision), lifecycle: "paused", fireCount: 1 });
    const fires = new FireLog(paths.fires);
    const fire = fires.create({ triggerId: definition.id, revision: definition.meta.revision, fireNumber: 1, reason: "stored before restart", summary: "custom-home history survives" });
    fires.record({ type: "receipt", fireId: fire.fireId, at: new Date().toISOString(), receipt: {
      summary: "recorded before restart", notify: false, at: new Date().toISOString(), source: "notify",
    } });
    try {
      process.env.SELF_STARTER_HOME = paths.home;
      await installService(paths, manager);
      assert.equal(await waitForDaemon(paths.socket, 5000), true, "initial service starts in the selected home");
      const first = await callDaemon<{ pid: number }>(paths.socket, "ping");
      assert.deepEqual((await callDaemon<TriggerSummary[]>(paths.socket, "trigger.list")).map((entry) => entry.id), [definition.id]);
      await stopRunningDaemon(paths);

      delete process.env.SELF_STARTER_HOME;
      await installService(paths, manager);
      assert.equal(await waitForDaemon(paths.socket, 5000), true, "rebuilt service must keep the selected home");
      assert.notEqual((await callDaemon<{ pid: number }>(paths.socket, "ping")).pid, first.pid);
      assert.deepEqual(specs.map((spec) => spec.env.SELF_STARTER_HOME), [paths.home, paths.home]);
      const after = await callDaemon<TriggerSummary[]>(paths.socket, "trigger.list");
      assert.equal(after[0]?.id, definition.id);
      assert.equal(after[0]?.lifecycle, "paused");
      const history = await callDaemon<FireView[]>(paths.socket, "fire.history", { triggerId: definition.id });
      assert.equal(history[0]?.fireId, fire.fireId);
      assert.equal(history[0]?.status, "done");

      const command = join(paths.home, "bin", "self-starter");
      for (const env of [callerEnv, { ...callerEnv, SELF_STARTER_HOME: other.home }]) {
        assert.match(execFileSync(command, ["list"], { env, encoding: "utf8", timeout: 15_000 }), /custom-home-check/);
        assert.match(execFileSync(command, ["history", definition.id], { env, encoding: "utf8", timeout: 15_000 }), /custom-home history survives/);
      }
    } finally {
      if (saved === undefined) delete process.env.SELF_STARTER_HOME;
      else process.env.SELF_STARTER_HOME = saved;
      for (const p of [paths, fallback, other]) await stopRunningDaemon(p);
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps OpenCode config and storage paths without persisting inline configuration", () => {
    const home = tempHome();
    const keys = ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_CONTENT"];
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) process.env[key] = join(home.paths.home, key);
      const { env } = serviceSpec(home.paths, []);
      assert.equal(env.OPENCODE_CONFIG_DIR, process.env.OPENCODE_CONFIG_DIR);
      assert.equal(env.OPENCODE_CONFIG, process.env.OPENCODE_CONFIG);
      assert.equal(env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
      assert.equal(env.XDG_DATA_HOME, process.env.XDG_DATA_HOME);
      assert.equal(env.XDG_STATE_HOME, process.env.XDG_STATE_HOME);
      assert.equal(env.XDG_CACHE_HOME, process.env.XDG_CACHE_HOME);
      assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      home.cleanup();
    }
  });

  it("compares versions", () => {
    assert.equal(compareVersions("0.0.1", "0.1.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), 0);
  });

  it("records a supported opencode binary and adds its directory to the service PATH", async () => {
    const home = tempHome();
    const specs: ServiceSpec[] = [];
    const manager: ServiceManager = {
      kind: "launchd", file: join(home.paths.home, "agent.plist"), installed: () => false,
      install(spec) { specs.push(spec); },
      uninstall() {}, start: () => false, stop: () => false, restart: () => false,
    };
    const makeOpenCode = (dirName: string, version: string) => {
      const dir = join(home.paths.home, dirName);
      const bin = join(dir, "opencode");
      saveConfig(home.paths, { ...loadConfig(home.paths), opencodeBin: undefined });
      rmSync(dir, { recursive: true, force: true });
      execFileSync("/bin/mkdir", ["-p", dir]);
      writeFileSync(bin, `#!/bin/sh\necho "${version}"\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    const saved = process.env.OPENCODE_BIN;
    try {
      process.env.OPENCODE_BIN = makeOpenCode("old-oc", "1.18.0");
      await installService(home.paths, manager);
      assert.equal(loadConfig(home.paths).opencodeBin, undefined, "incompatible OpenCode is not persisted");

      const supported = makeOpenCode("good-oc", "1.19.3");
      process.env.OPENCODE_BIN = supported;
      await installService(home.paths, manager);
      assert.equal(loadConfig(home.paths).opencodeBin, supported);
      assert.ok(specs.at(-1)?.env.PATH?.split(delimiter).includes(dirname(supported)));
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = saved;
      home.cleanup();
    }
  });

  it("leaves a newer daemon running, and replaces an older one with this version", async () => {
    const home = tempHome();
    // A test must not touch the user's launchd or systemd services.
    saveConfig(home.paths, { ...loadConfig(home.paths), service: false });
    try {
      const newer = await fakeDaemon(home.paths.socket, "99.0.0");
      assert.equal(await ensureDaemon(home.paths), "running");
      assert.equal(newer.stopped, false);
      await newer.close();

      const older = await fakeDaemon(home.paths.socket, "0.0.0");
      assert.equal(await ensureDaemon(home.paths), "started");
      assert.equal(older.stopped, true);
      assert.equal(await daemonVersion(home.paths.socket), VERSION);
      assert.equal(execFileSync(join(home.paths.home, "bin", "self-starter"), ["version"], { encoding: "utf8" }).trim(), VERSION, "and its command runs this installation");
    } finally {
      await stopRunningDaemon(home.paths);
      home.cleanup();
    }
  });
});
