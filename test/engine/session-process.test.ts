import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { callDaemon, waitForDaemon } from "../../src/client/client.js";
import { DEFAULT_CONFIG, saveConfig } from "../../src/engine/config.js";
import { OpenCodeCli } from "../../src/engine/opencode.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { killSessionProcesses, markedPsProcesses, markedSessionProcesses, sessionProcesses, SHARED_DAEMON_SCOPE } from "../../src/engine/session-processes.js";
import { ZCodeCli } from "../../src/engine/zcode.js";
import type { DraftView } from "../../src/engine/service.js";
import { stopRunningDaemon } from "../../src/service/manager.js";
import { makeDefinition } from "../helpers.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the test process");
    await pause(20);
  }
}

it("matches complete macOS ps environment markers without matching another run", () => {
  const marker = "SELF_STARTER_RUN_TOKEN=unique-run";
  assert.deepEqual([...markedPsProcesses([
    ` 101 node tool.js HOME=/tmp ${marker} PATH=/bin`,
    ` 102 node other.js SELF_STARTER_RUN_TOKEN=other-run`,
    ` 103 node other.js PREFIX_${marker}`,
    ` 104 node other.js ${marker}-suffix`,
  ].join("\n"), marker)], [101]);
});

it("kills frozen descendants even when a child rejects SIGSTOP with EPERM or ps fails mid-scan", () => {
  const marker = "SELF_STARTER_RUN_TOKEN=run-1";
  const signals: Array<[number, NodeJS.Signals]> = [];
  const table = [
    { pid: 10, parent: 1, uid: 501 },
    { pid: 11, parent: 10, uid: 501 }, // e.g. restricted helper returning EPERM
    { pid: 12, parent: 10, uid: 0 },   // root-owned child: skipped by uid check
    { pid: 13, parent: 10, uid: 501 }, // normal child
    { pid: 14, parent: 10, uid: 501 }, // shared daemon scope: preserved
  ];
  killSessionProcesses(marker, {
    uid: 501,
    list: () => table,
    marked: (_procs, m) => m === marker ? new Set([10]) : new Set([14]),
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      if (pid === 11) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  });
  assert.deepEqual(signals.filter(([, sig]) => sig === "SIGKILL"), [
    [13, "SIGKILL"],
    [10, "SIGKILL"],
  ]);
  assert.equal(signals.some(([pid]) => pid === 12 || pid === 14), false);

  const errorSignals: Array<[number, NodeJS.Signals]> = [];
  let scans = 0;
  assert.throws(() => killSessionProcesses(marker, {
    uid: 501,
    list: () => {
      if (++scans > 1) throw new Error("ps failed");
      return [{ pid: 20, parent: 1, uid: 501 }];
    },
    marked: (_procs, m) => m === marker ? new Set([20]) : new Set(),
    kill: (pid, sig) => { errorSignals.push([pid, sig]); },
  }), /ps failed/);
  assert.deepEqual(errorSignals, [[20, "SIGSTOP"], [20, "SIGKILL"]], "already-frozen PIDs are never left stopped");
});

for (const host of ["opencode", "zcode"] as const) describe(`${host}'s detached tool ownership`, () => {
  let scratch: string;
  const sessionId = host === "opencode" ? "ses_owned" : "sess_owned";
  const siblingId = host === "opencode" ? "ses_other" : "sess_other";
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "ss-process-owner-")); });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const killTool = () => {
    try { process.kill(Number(readFileSync(join(scratch, "tool.pid"), "utf8")), "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const lock = () => join(scratch, "sessions", `${sessionId}.${host}.lock`);
  const heartbeat = () => readFileSync(join(scratch, "heartbeat"), "utf8");
  const tool = () => writeFileSync(join(scratch, "tool.mjs"), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    writeFileSync('tool.pid', String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => appendFileSync('heartbeat', 'x'), 10);
  `);
  const cli = (body: string) => {
    const bin = join(scratch, "cli.mjs");
    writeFileSync(bin, `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      const args = process.argv.slice(2);
      const option = ${JSON.stringify(host === "opencode" ? "--session" : "--resume")};
      const sessionId = args[args.indexOf(option) + 1];
      for await (const chunk of process.stdin) {}
      const done = () => {
        if (${JSON.stringify(host)} === 'opencode') {
          for (const [type, part] of [['text', {text:'Done'}], ['step_finish', {reason:'stop'}]]) {
            console.log(JSON.stringify({type, sessionID:sessionId, part}));
          }
        } else console.log(JSON.stringify({sessionId, response:'Done'}));
      };
      writeFileSync(sessionId + '.token', process.env.SELF_STARTER_RUN_TOKEN ?? '');
      ${body}
    `);
    return bin;
  };
  const runner = (bin: string) => host === "opencode"
    ? new OpenCodeCli(bin, join(scratch, "sessions")) : new ZCodeCli(bin, join(scratch, "sessions"));
  const run = (bin: string, id = sessionId, timeoutMs = 800) => runner(bin).run({
    sessionId: id, cwd: scratch, message: "continue", sandbox: "workspace-write", timeoutMs,
  });

  for (const exitCode of [0, 2]) it(`reclaims a detached pipe holder after its CLI exits ${exitCode}, without stopping another session`, async () => {
    tool();
    const bin = cli(`
      if (sessionId === ${JSON.stringify(siblingId)}) {
        const interval = setInterval(() => {
          appendFileSync('sibling-heartbeat', 'x');
          if (!existsSync('release-sibling')) return;
          clearInterval(interval); done();
        }, 10);
      } else {
        const child = spawn(process.execPath, ['tool.mjs'], {detached:true,stdio:['ignore',process.stdout,process.stderr]});
        child.unref();
        const interval = setInterval(() => {
          if (!existsSync('heartbeat')) return;
          writeFileSync('cli-exiting', 'yes'); process.exit(${exitCode});
        }, 10);
      }
    `);
    const sibling = run(bin, siblingId, 5000);
    const pending = run(bin);
    try {
      await until(() => existsSync(join(scratch, "cli-exiting")) && existsSync(join(scratch, "sibling-heartbeat")));
      const token = readFileSync(join(scratch, `${sessionId}.token`), "utf8");
      assert.ok(token);
      const marked = markedSessionProcesses(sessionProcesses(), `SELF_STARTER_RUN_TOKEN=${token}`);
      assert.ok(marked.has(Number(readFileSync(join(scratch, "tool.pid"), "utf8"))));
      assert.equal(marked.has(process.pid), false, "the caller does not inherit a child's run marker");
      assert.equal(marked.has(JSON.parse(readFileSync(lock(), "utf8")).pid), false, "the wrapper and its scanner are outside the CLI run");
      const result = await Promise.race([pending, pause(3000).then(() => undefined)]);
      assert.ok(result, "a dead CLI's detached tool must not hold its run slot forever");
      assert.match(result.error!, /timed out/);
      assert.equal(existsSync(lock()), false);
      const stopped = heartbeat();
      const siblingBefore = readFileSync(join(scratch, "sibling-heartbeat"), "utf8").length;
      await pause(80);
      assert.equal(heartbeat(), stopped);
      assert.ok(readFileSync(join(scratch, "sibling-heartbeat"), "utf8").length > siblingBefore);
      assert.notEqual(readFileSync(join(scratch, `${sessionId}.token`), "utf8"), readFileSync(join(scratch, `${siblingId}.token`), "utf8"));
      assert.equal((await run(cli("done();"))).ok, true, "the same session can be resumed after cleanup");
    } finally {
      writeFileSync(join(scratch, "release-sibling"), "yes");
      killTool();
      await Promise.all([pending, sibling]);
    }
  });

  it("keeps the detached tool deadline after both the CLI and daemon have exited", async () => {
    tool();
    const bin = cli(`
      const child = spawn(process.execPath, ['tool.mjs'], {detached:true,stdio:['ignore',process.stdout,process.stderr]});
      child.unref();
      setInterval(() => {
        if (!existsSync('heartbeat')) return;
        writeFileSync('cli-exiting', 'yes'); process.exit(2);
      }, 10);
    `);
    const parentScript = join(scratch, "daemon.mjs");
    const module = new URL(`../../src/engine/${host}.js`, import.meta.url).href;
    writeFileSync(parentScript, `
      const { ${host === "opencode" ? "OpenCodeCli" : "ZCodeCli"}: Runner } = await import(${JSON.stringify(module)});
      await new Runner(${JSON.stringify(bin)}, ${JSON.stringify(join(scratch, "sessions"))}).run({
        sessionId:${JSON.stringify(sessionId)},cwd:${JSON.stringify(scratch)},message:'continue',sandbox:'workspace-write',timeoutMs:1200,
      });
    `);
    const parentArgs = [parentScript];
    const parent = spawn(process.execPath, parentArgs, { cwd: scratch, stdio: "ignore" });
    const exited = new Promise((resolve) => parent.once("close", resolve));
    try {
      await until(() => existsSync(join(scratch, "cli-exiting")));
      parent.kill("SIGKILL");
      await exited;
      assert.equal(existsSync(lock()), true);
      await until(() => !existsSync(lock()));
      const stopped = heartbeat();
      await pause(80);
      assert.equal(heartbeat(), stopped);
      assert.equal((await run(cli("done();"))).ok, true);
    } finally {
      parent.kill("SIGKILL");
      await exited;
      killTool();
      await until(() => !existsSync(lock()));
    }
  });

  it("still stops an ordinary tool with a clean environment while its CLI parent is running", async () => {
    tool();
    const pending = run(cli(`
      spawn(process.execPath, ['tool.mjs'], {env:{},detached:true,stdio:['ignore',process.stdout,process.stderr]});
      setInterval(() => {}, 1000);
    `));
    try {
      await until(() => existsSync(join(scratch, "heartbeat")));
      const result = await Promise.race([pending, pause(3000).then(() => undefined)]);
      assert.ok(result, "constructing an ordinary tool's environment must not disable descendant cleanup");
      assert.match(result.error!, /timed out/);
      const stopped = heartbeat();
      await pause(80);
      assert.equal(heartbeat(), stopped);
      assert.equal(existsSync(lock()), false);
    } finally {
      killTool();
      await pending;
    }
  });

  it("leaves a successful task's detached background service running when it closes its pipes", async () => {
    tool();
    const bin = cli(`
      const child = spawn(process.execPath, ['tool.mjs'], {detached:true,stdio:'ignore'});
      child.unref();
      done();
    `);
    try {
      assert.equal((await run(bin, sessionId, 500)).ok, true);
      await until(() => existsSync(join(scratch, "heartbeat")));
      const before = heartbeat().length;
      await pause(650);
      assert.ok(heartbeat().length > before, "a completed run does not later kill its authorized background service");
      assert.equal(existsSync(lock()), false);
    } finally { killTool(); }
  });

  it("does not stop a shared daemon started by a still-running headless caller", async () => {
    const shared = resolvePaths(join(scratch, "shared-daemon"));
    saveConfig(shared, { ...DEFAULT_CONFIG, service: false });
    const managerModule = new URL("../../src/service/manager.js", import.meta.url).href;
    const pathsModule = new URL("../../src/engine/paths.js", import.meta.url).href;
    const runnerModule = new URL(`../../src/engine/${host}.js`, import.meta.url).href;
    const scopedBin = join(scratch, "scoped-cli.mjs");
    const scopedScript = join(scratch, "scoped-run.mjs");
    writeFileSync(scopedBin, `
      import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(join(scratch, "scoped.token"))}, process.env.SELF_STARTER_RUN_TOKEN ?? '');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(scopedScript, `
      const {${host === "opencode" ? "OpenCodeCli" : "ZCodeCli"}:Runner} = await import(${JSON.stringify(runnerModule)});
      const result = await new Runner(${JSON.stringify(scopedBin)}, ${JSON.stringify(join(scratch, "scoped-sessions"))}).run({
        sessionId:${JSON.stringify(siblingId)},cwd:${JSON.stringify(scratch)},message:'continue',sandbox:'workspace-write',timeoutMs:300,
      });
      if (result.ok || !result.error?.includes('timed out')) throw new Error(JSON.stringify(result));
      console.log('scoped-timeout');
    `);
    const bin = cli(`
      const { spawnDetachedDaemon } = await import(${JSON.stringify(managerModule)});
      const { resolvePaths } = await import(${JSON.stringify(pathsModule)});
      process.env.SELF_STARTER_TEST_ENV = 'kept';
      process.env.SELF_STARTER_HOME = 'the-caller-home';
      spawnDetachedDaemon(resolvePaths(${JSON.stringify(shared.home)}));
      setInterval(() => {}, 1000);
    `);
    const pending = run(bin, sessionId, 2000);
    try {
      assert.equal(await waitForDaemon(shared.socket, 1500), true);
      const initial = await callDaemon<{ pid: number }>(shared.socket, "ping");
      const token = readFileSync(join(scratch, `${sessionId}.token`), "utf8");
      assert.equal(markedSessionProcesses(sessionProcesses(), `SELF_STARTER_RUN_TOKEN=${token}`).has(initial.pid), false);
      const result = await Promise.race([pending, pause(4000).then(() => undefined)]);
      assert.ok(result);
      assert.match(result.error!, /timed out/);
      assert.equal((await callDaemon<{ pid: number }>(shared.socket, "ping")).pid, initial.pid,
        "the shared service outlives the action that started it");
      const view = await callDaemon<DraftView>(shared.socket, "draft.create", {
        definition: makeDefinition({ action: { type: "notify" }, target: { cwd: scratch } }),
        code: `
          const scope = await new Deno.Command(${JSON.stringify(process.execPath)}, {args:[${JSON.stringify(scopedScript)}]}).output();
          if (!scope.success) throw new Error(new TextDecoder().decode(scope.stderr));
          console.log(JSON.stringify({fire:false,summary:JSON.stringify({
          token:Deno.env.get('SELF_STARTER_RUN_TOKEN') ?? null,
          kept:Deno.env.get('SELF_STARTER_TEST_ENV'), home:Deno.env.get('SELF_STARTER_HOME'),
          scoped:new TextDecoder().decode(scope.stdout).trim() === 'scoped-timeout',
        })}));`,
      });
      assert.equal(view.trial?.ok, true, view.trial?.error ?? "the environment probe failed");
      assert.deepEqual(JSON.parse(view.trial!.summary!), { token: SHARED_DAEMON_SCOPE, kept: "kept", home: shared.home, scoped: true },
        "the independent daemon's probe children keep its environment without the caller's ownership marker");
      assert.notEqual(readFileSync(join(scratch, "scoped.token"), "utf8"), SHARED_DAEMON_SCOPE,
        "a new scoped run replaces its shared daemon's lifetime marker");
    } finally {
      await pending;
      await stopRunningDaemon(shared);
    }
  });
});
