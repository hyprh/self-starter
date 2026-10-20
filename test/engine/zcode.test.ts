import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findZCode, ZCodeCli, type ZCodeRunOptions } from "../../src/engine/zcode.js";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "ss-zcode-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A real CLI process speaking ZCode's documented --output-format json schema. */
function fakeZCode(body: string): string {
  const path = join(scratch, "zcode.mjs");
  writeFileSync(path, body);
  return path;
}

function run(bin: string, options: Partial<ZCodeRunOptions> = {}) {
  return new ZCodeCli(bin, join(scratch, "sessions")).run({ cwd: scratch, message: "[self-starter] inspect the event", sandbox: "workspace-write", timeoutMs: 5000, ...options });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for child process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function spawnParent(bin: string, sessionId: string, timeoutMs: number, crashBeforeStart = false) {
  const script = join(scratch, "daemon.mjs");
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    const [module, bin, sessions, cwd, sessionId, timeoutMs, crash] = process.argv.slice(2);
    const { ZCodeCli } = await import(module);
    await new ZCodeCli(bin, sessions).run({
      cwd, sessionId, message:'continue', sandbox:'workspace-write', timeoutMs:Number(timeoutMs),
      onStart: () => {
        if (crash !== '1') return;
        writeFileSync('acquired', 'yes');
        process.kill(process.pid, 'SIGKILL');
      }
    });
  `);
  return spawn(process.execPath, [
    script, new URL("../../src/engine/zcode.js", import.meta.url).href,
    bin, join(scratch, "sessions"), scratch, sessionId, String(timeoutMs), crashBeforeStart ? "1" : "0",
  ], { cwd: scratch, stdio: "ignore" });
}

describe("ZCode's dedicated CLI sessions", () => {
  it("starts a session, resumes that exact session, and passes literal arguments and turn provenance", async () => {
    const bin = fakeZCode(`
      import { writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const args = process.argv.slice(2);
      const resumed = args.includes('--resume');
      const sessionId = resumed ? args[args.indexOf('--resume') + 1] : 'sess_new';
      // The MCP subprocess receives the runner's provenance, just as ZCode's
      // buildMcpStdioEnv preserves non-runtime variables from its environment.
      const inherited = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({host:process.env.SELF_STARTER_HOST,trigger:process.env.SELF_STARTER_TRIGGER_TURN}))'], {encoding:'utf8'});
      writeFileSync('received.json', JSON.stringify({args,cwd:process.cwd(),mcp:JSON.parse(inherited.stdout)}));
      console.log(JSON.stringify({sessionId, traceId:'trace_a', response:'Checked: all good', eventCount:4, projection:{status:'idle',turnCount:resumed ? 2 : 1}}));
    `);
    const message = "[self-starter] literal 'quotes' $(touch unexpected) `touch unexpected`\nsecond line";
    let starts = 0;
    const first = await run(bin, { message, sandbox: "read-only", onStart: () => { starts++; } });
    assert.equal(starts, 1);
    assert.deepEqual(first, { ok: true, sessionId: "sess_new", lastMessage: "Checked: all good" });
    const recorded = () => JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
    assert.deepEqual(recorded(), {
      args: ["--prompt", message, "--cwd", scratch, "--mode", "plan", "--output-format", "json"],
      cwd: realpathSync(scratch),
      mcp: { host: "zcode", trigger: "1" },
    });
    assert.equal(existsSync(join(scratch, "unexpected")), false);
    assert.deepEqual(await run(bin, { sessionId: first.sessionId, onStart: () => { starts++; } }), first);
    assert.equal(starts, 2);
    assert.deepEqual(recorded().args.slice(-6), ["--mode", "edit", "--output-format", "json", "--resume", "sess_new"]);
    await run(bin, { sessionId: first.sessionId, sandbox: "danger-full-access" });
    assert.equal(recorded().args[recorded().args.indexOf("--mode") + 1], "yolo");
  });

  it("does not treat a nonzero exit, structured error, or unfinished projection as success", async () => {
    const cases = [
      { body: "console.log(JSON.stringify({sessionId:'sess_1',response:'partial'})); console.error('login expired'); process.exitCode=1;", error: /login expired/ },
      { body: "console.log(JSON.stringify({error:{message:'session is already owned'}}));", error: /session is already owned/ },
      { body: "console.log(JSON.stringify({sessionId:'sess_1',response:'partial',projection:{status:'error'}}));", error: /session did not finish/ },
      { body: "console.log(JSON.stringify({sessionId:'sess_1',response:'waiting',projection:{status:'running'}}));", error: /session did not finish/ },
      { body: "console.error('provider unavailable'); process.exitCode=3;", error: /provider unavailable/ },
    ];
    for (const { body, error } of cases) {
      const result = await run(fakeZCode(body));
      assert.equal(result.ok, false);
      assert.equal(result.busy, undefined, "CLI failure must not impersonate the lease owner's busy message");
      assert.match(result.error!, error);
    }
  });

  it("requires a usable result and refuses a resumed result for a different session", async () => {
    for (const value of [null, [], {}, { response: "no id" }, { sessionId: "sess_1" }, { sessionId: "sess_1", response: "  " }]) {
      const result = await run(fakeZCode(`console.log(${JSON.stringify(JSON.stringify(value))});`));
      assert.equal(result.ok, false, JSON.stringify(value));
    }
    const mismatched = await run(fakeZCode("console.log(JSON.stringify({sessionId:'sess_other',response:'wrong conversation'}));"), { sessionId: "sess_1" });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.error!, /different session/);
    const invalid = await run(fakeZCode("console.log('Not JSON');"));
    assert.match(invalid.error!, /no valid JSON result/);
  });

  it("rejects malformed session ids before they can be saved or used to resume a turn", async () => {
    for (const sessionId of ["", " ", "sess_1\n", "sess_a b", "sess_1;touch-unexpected", "sess_$(id)", "sess_../outside", "sess_\u0000x"]) {
      const bin = fakeZCode(`
        import { writeFileSync } from 'node:fs';
        writeFileSync('invoked', 'yes');
        console.log(${JSON.stringify(JSON.stringify({ sessionId, response: "done" }))});
      `);
      const malformed = await run(bin);
      assert.equal(malformed.ok, false, JSON.stringify(sessionId));
      assert.match(malformed.error!, /no valid sessionId/);
      rmSync(join(scratch, "invoked"));
      const resumed = await run(bin, { sessionId });
      assert.match(resumed.error!, /invalid sessionId to resume/);
      assert.equal(existsSync(join(scratch, "invoked")), false, "invalid resume must not silently start a new conversation");
    }
  });

  it("bounds noisy output and surfaces startup errors", async () => {
    const noisy = await run(fakeZCode("process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);"));
    assert.equal(noisy.ok, false);
    assert.match(noisy.error!, /output exceeded/);
    const missing = await run(join(scratch, "not-installed"));
    assert.equal(missing.ok, false);
    assert.match(missing.error!, /could not start ZCode/);
  });

  it("flushes a resumed response larger than the pipe buffer before the wrapper exits", async () => {
    const response = "x".repeat(128 * 1024);
    const result = await run(fakeZCode("console.log(JSON.stringify({sessionId:'sess_large',response:'x'.repeat(128 * 1024)}));"), { sessionId: "sess_large" });
    assert.deepEqual(result, { ok: true, sessionId: "sess_large", lastMessage: response });
  });

  it("keeps one resumed turn per session, while different sessions can run concurrently", async () => {
    const bin = fakeZCode(`
      import { appendFileSync, existsSync } from 'node:fs';
      const sessionId = process.argv[process.argv.indexOf('--resume') + 1];
      appendFileSync(sessionId + '.started', 'x');
      const timer = setInterval(() => {
        if (!existsSync(sessionId + '.release')) return;
        clearInterval(timer);
        console.log(JSON.stringify({sessionId,response:'done'}));
      }, 10);
    `);
    let starts = 0;
    const first = run(bin, { sessionId: "sess_first", onStart: () => { starts++; } });
    const second = run(bin, { sessionId: "sess_second", onStart: () => { starts++; } });
    try {
      await waitFor(() => existsSync(join(scratch, "sess_first.started")) && existsSync(join(scratch, "sess_second.started")));
      const duplicate = await run(bin, { sessionId: "sess_first", onStart: () => { starts++; } });
      assert.equal(duplicate.busy, true);
      assert.equal(duplicate.ok, false);
      assert.equal(starts, 2, "a busy session does not consume a fire receipt");
      assert.equal(readFileSync(join(scratch, "sess_first.started"), "utf8"), "x", "the duplicate never launches ZCode");
    } finally {
      for (const id of ["sess_first", "sess_second"]) writeFileSync(join(scratch, `${id}.release`), "go");
      const results = await Promise.all([first, second]);
      assert.ok(results.every((result) => result.ok));
    }
    assert.equal(existsSync(join(scratch, "sessions", "sess_first.zcode.lock")), false);
    assert.equal((await run(bin, { sessionId: "sess_first" })).ok, true);
    assert.equal(readFileSync(join(scratch, "sess_first.started"), "utf8"), "xx");
  });

  it("recovers a dead owner's lease, but leaves malformed leases for manual recovery", async () => {
    const bin = fakeZCode("console.log(JSON.stringify({sessionId:'sess_stale',response:'recovered'}));");
    const sessions = join(scratch, "sessions");
    mkdirSync(sessions);
    const lock = join(sessions, "sess_stale.zcode.lock");
    const expired = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => expired.once("close", resolve));
    writeFileSync(lock, JSON.stringify({ pid: expired.pid, token: randomUUID() }));
    assert.equal((await run(bin, { sessionId: "sess_stale" })).ok, true);
    assert.equal(existsSync(lock), false);
    for (const malformed of ["", "{", "{}", '{"pid":-1,"token":"bad"}']) {
      writeFileSync(lock, malformed);
      let starts = 0;
      const result = await run(bin, { sessionId: "sess_stale", onStart: () => { starts++; } });
      assert.equal(result.ok, false);
      assert.equal(result.busy, undefined);
      assert.match(result.error!, /Invalid ZCode lease.*manually/);
      assert.equal(starts, 0);
      assert.equal(readFileSync(lock, "utf8"), malformed);
    }
  });

  it("does not launch a resumed turn if saving the fire receipt fails", async () => {
    const bin = fakeZCode("import {writeFileSync} from 'node:fs'; writeFileSync('invoked', 'yes');");
    const result = await run(bin, { sessionId: "sess_receipt", onStart: () => { throw new Error("disk full"); } });
    assert.equal(result.ok, false);
    assert.match(result.error!, /could not record turn start: disk full/);
    assert.equal(existsSync(join(scratch, "invoked")), false);
  });

  it("holds the lease after the daemon is SIGKILLed, drains orphan output, and releases on CLI completion", async () => {
    const bin = fakeZCode(`
      import { appendFileSync, existsSync } from 'node:fs';
      appendFileSync('orphan.started', 'x');
      const timer = setInterval(() => {
        appendFileSync('orphan.heartbeat', 'x');
        process.stdout.write('still working\\n');
        process.stderr.write('diagnostic\\n');
        if (!existsSync('orphan.release')) return;
        clearInterval(timer);
      }, 10);
    `);
    const sessions = join(scratch, "sessions");
    const parent = spawnParent(bin, "sess_orphan", 30_000);
    const parentExit = new Promise((resolve) => parent.once("close", resolve));
    const lock = join(sessions, "sess_orphan.zcode.lock");
    let owner: number | undefined;
    try {
      await waitFor(() => existsSync(join(scratch, "orphan.heartbeat")));
      owner = JSON.parse(readFileSync(lock, "utf8")).pid;
      parent.kill("SIGKILL");
      await parentExit;
      const heartbeat = readFileSync(join(scratch, "orphan.heartbeat"), "utf8").length;
      await waitFor(() => readFileSync(join(scratch, "orphan.heartbeat"), "utf8").length > heartbeat + 5);
      let starts = 0;
      const duplicate = await run(bin, { sessionId: "sess_orphan", onStart: () => { starts++; } });
      assert.equal(duplicate.busy, true);
      assert.equal(starts, 0);
      assert.equal(readFileSync(join(scratch, "orphan.started"), "utf8"), "x");
      writeFileSync(join(scratch, "orphan.release"), "go");
      await waitFor(() => !existsSync(lock));
      const next = fakeZCode("console.log(JSON.stringify({sessionId:'sess_orphan',response:'resumed'}));");
      assert.equal((await run(next, { sessionId: "sess_orphan" })).ok, true);
    } finally {
      parent.kill("SIGKILL");
      await parentExit;
      if (owner && existsSync(lock)) {
        try { process.kill(owner, "SIGTERM"); } catch { /* already closed */ }
        await waitFor(() => !existsSync(lock));
      }
    }
  });

  it("releases an acquired lease if the daemon dies before authorizing the CLI", async () => {
    const bin = fakeZCode("import {writeFileSync} from 'node:fs'; writeFileSync('invoked', 'yes');");
    const sessions = join(scratch, "sessions");
    const parent = spawnParent(bin, "sess_handshake", 5000, true);
    await new Promise((resolve) => parent.once("close", resolve));
    assert.equal(existsSync(join(scratch, "acquired")), true);
    await waitFor(() => !existsSync(join(sessions, "sess_handshake.zcode.lock")));
    assert.equal(existsSync(join(scratch, "invoked")), false);
  });

  it("times out an orphaned turn after the daemon dies and makes its session available again", async () => {
    const bin = fakeZCode(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('cli.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const sessions = join(scratch, "sessions");
    const lock = join(sessions, "sess_deadline.zcode.lock");
    const parent = spawnParent(bin, "sess_deadline", 900);
    const parentExit = new Promise((resolve) => parent.once("close", resolve));
    let owner: number | undefined;
    try {
      await waitFor(() => existsSync(join(scratch, "cli.pid")));
      owner = JSON.parse(readFileSync(lock, "utf8")).pid;
      const cliPid = Number(readFileSync(join(scratch, "cli.pid"), "utf8"));
      parent.kill("SIGKILL");
      await parentExit;
      assert.equal(existsSync(lock), true, "the running CLI keeps its lease after losing the daemon");
      await waitFor(() => !existsSync(lock));
      assert.throws(() => process.kill(cliPid, 0), { code: "ESRCH" }, "the lease is released only after the CLI is reaped");
      const next = fakeZCode("console.log(JSON.stringify({sessionId:'sess_deadline',response:'resumed'}));");
      assert.equal((await run(next, { sessionId: "sess_deadline" })).ok, true);
    } finally {
      parent.kill("SIGKILL");
      await parentExit;
      if (owner && existsSync(lock)) {
        try { process.kill(owner, "SIGTERM"); } catch { /* already closed */ }
        await waitFor(() => !existsSync(lock));
      }
    }
  });

  it("times out the owned process group, including a tool that outlives the CLI", async () => {
    const childScript = join(scratch, "tool.mjs");
    writeFileSync(childScript, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync('tool.pid', String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => appendFileSync('heartbeat', 'x'), 10);
    `);
    const bin = fakeZCode(`
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['tool.mjs'], {stdio:['ignore',process.stdout,process.stderr]});
      child.unref();
      process.exit(0);
    `);
    try {
      const result = await run(bin, { sessionId: "sess_timeout", timeoutMs: 700 });
      assert.equal(result.ok, false);
      assert.match(result.error!, /timed out/);
      const stoppedAt = readFileSync(join(scratch, "heartbeat"), "utf8");
      assert.ok(stoppedAt.length > 0, "the tool actually ran");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(readFileSync(join(scratch, "heartbeat"), "utf8"), stoppedAt, "the tool must stop writing when the turn times out");
      const recovered = await run(fakeZCode("console.log(JSON.stringify({sessionId:'sess_timeout',response:'recovered'}));"), { sessionId: "sess_timeout" });
      assert.equal(recovered.ok, true, "the killed wrapper's lease must be recoverable");
    } finally {
      if (existsSync(join(scratch, "tool.pid"))) {
        try { process.kill(Number(readFileSync(join(scratch, "tool.pid"), "utf8")), "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  });

  it("runs a Node-based CLI even when the service PATH contains no node", async () => {
    const script = fakeZCode("console.log(JSON.stringify({sessionId:'sess_1',response:process.execPath}));");
    const bin = join(scratch, "zcode");
    symlinkSync(script, bin);
    const saved = process.env.PATH;
    process.env.PATH = join(scratch, "empty");
    try {
      assert.deepEqual(await run(bin), { ok: true, sessionId: "sess_1", lastMessage: process.execPath });
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });

  it("finds the explicit CLI first, then PATH, then the local installer location", () => {
    const saved = { ZCODE_BIN: process.env.ZCODE_BIN, PATH: process.env.PATH, HOME: process.env.HOME };
    const explicit = join(scratch, "explicit");
    const pathBin = join(scratch, "bin");
    const localBin = join(scratch, ".local", "bin");
    mkdirSync(pathBin);
    mkdirSync(localBin, { recursive: true });
    for (const path of [explicit, join(pathBin, "zcode"), join(localBin, "zcode")]) writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    Object.assign(process.env, { ZCODE_BIN: explicit, PATH: pathBin, HOME: scratch });
    try {
      assert.equal(findZCode(), explicit);
      delete process.env.ZCODE_BIN;
      assert.equal(findZCode(), join(pathBin, "zcode"));
      process.env.PATH = "";
      assert.equal(findZCode(), join(localBin, "zcode"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
