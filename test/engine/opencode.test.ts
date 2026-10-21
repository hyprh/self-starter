import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findOpenCode, OpenCodeCli, type OpenCodeRunOptions } from "../../src/engine/opencode.js";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "ss-opencode-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A real subprocess speaking the native `opencode run --format json` stream. */
function fakeOpenCode(body: string): string {
  const bin = join(scratch, "opencode.mjs");
  writeFileSync(bin, `
    const args = process.argv.slice(2);
    const sessionId = args.includes('--session') ? args[args.indexOf('--session') + 1] : 'ses_new';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString();
    const emit = (type, part) => console.log(JSON.stringify({type, timestamp:Date.now(), sessionID:sessionId, part}));
    const done = (text='All checked') => { emit('step_start', {}); emit('text', {text}); emit('step_finish', {reason:'stop'}); };
    ${body}
  `);
  return bin;
}

function run(bin: string, options: Partial<OpenCodeRunOptions> = {}) {
  return new OpenCodeCli(bin, join(scratch, "sessions")).run({ cwd: scratch, message: "[self-starter] inspect the event", sandbox: "workspace-write", timeoutMs: 5000, ...options });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for child process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function spawnParent(bin: string, sessionId: string | undefined, timeoutMs: number, crashBeforeStart = false) {
  const script = join(scratch, "daemon.mjs");
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    const [module, bin, sessions, cwd, sessionId, timeoutMs, crash] = process.argv.slice(2);
    const { OpenCodeCli } = await import(module);
    await new OpenCodeCli(bin, sessions).run({
      cwd, sessionId:sessionId || undefined, message:'continue', sandbox:'workspace-write', timeoutMs:Number(timeoutMs),
      onStart: () => {
        if (crash !== '1') return;
        writeFileSync('acquired', 'yes');
        process.kill(process.pid, 'SIGKILL');
      }
    });
  `);
  return spawn(process.execPath, [
    script, new URL("../../src/engine/opencode.js", import.meta.url).href,
    bin, join(scratch, "sessions"), scratch, sessionId ?? "", String(timeoutMs), crashBeforeStart ? "1" : "0",
  ], { cwd: scratch, stdio: "ignore" });
}

describe("OpenCode's dedicated CLI sessions", () => {
  it("starts and resumes the exact session, sends literal stdin, and retains only the final step's answer", async () => {
    const bin = fakeOpenCode(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('received.json', JSON.stringify({args,prompt,cwd:process.cwd(),host:process.env.SELF_STARTER_HOST,trigger:process.env.SELF_STARTER_TRIGGER_TURN}));
      emit('step_start', {});
      emit('text', {text:'I will inspect it.'});
      emit('tool_use', {tool:'read',state:{status:'completed',output:'content'}});
      emit('step_finish', {reason:'tool-calls'});
      done('Checked: all good');
    `);
    const message = "[self-starter] literal 'quotes' $(touch unexpected) `touch unexpected`\nsecond line";
    let starts = 0;
    const first = await run(bin, { message, onStart: () => { starts++; } });
    assert.deepEqual(first, { ok: true, sessionId: "ses_new", lastMessage: "Checked: all good" });
    const recorded = () => JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
    assert.equal(recorded().prompt, message);
    assert.equal(recorded().cwd, realpathSync(scratch));
    assert.equal(recorded().host, "opencode");
    assert.equal(recorded().trigger, "1");
    assert.deepEqual(recorded().args.slice(0, 6), ["run", "--dir", scratch, "--format", "json", "--agent"]);
    assert.equal(recorded().args.includes(message), false, "the prompt is not exposed as a CLI argument");
    assert.equal(existsSync(join(scratch, "unexpected")), false);
    assert.deepEqual(await run(bin, { sessionId: first.sessionId, onStart: () => { starts++; } }), first);
    assert.deepEqual(recorded().args.slice(-2), ["--session", "ses_new"]);
    assert.equal(starts, 2);
  });

  it("uses an isolated agent policy, preserves provider configuration, and only permits edits in workspace-write", async () => {
    const bin = fakeOpenCode(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('policy.json', JSON.stringify({args,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),dir:process.env.OPENCODE_CONFIG_DIR}));
      done();
    `);
    const saved = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { local: { options: { baseURL: "http://127.0.0.1:1234" } } }, agent: { user: { permission: { "*": "allow" } } } });
    try {
      const runner = new OpenCodeCli(bin, join(scratch, "sessions"), join(scratch, "global"));
      let previous: string | undefined;
      for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
        assert.equal((await runner.run({ cwd: scratch, message: "check", sandbox, timeoutMs: 5000 })).ok, true);
        const value = JSON.parse(readFileSync(join(scratch, "policy.json"), "utf8"));
        const agent = value.args[value.args.indexOf("--agent") + 1];
        const permission = value.config.agent[agent].permission;
        assert.notEqual(agent, previous, "a fresh name avoids inheriting global or project agent permissions");
        previous = agent;
        assert.equal(value.config.provider.local.options.baseURL, "http://127.0.0.1:1234");
        assert.deepEqual(value.config.agent.user, { permission: { "*": "allow" } });
        assert.equal(value.dir, process.env.OPENCODE_CONFIG_DIR);
        assert.ok(value.config.plugin.includes(pathToFileURL(join(scratch, "global", "plugins", "self-starter.js")).href));
        assert.equal(permission["*"], sandbox === "danger-full-access" ? "allow" : "deny");
        assert.equal(permission.edit, sandbox === "workspace-write" ? "allow" : undefined);
        assert.equal(permission.bash, undefined, "workspace-write does not grant arbitrary shell commands");
        assert.equal(permission.question, "deny");
        assert.equal(permission["trigger_*"], "allow");
        assert.equal(permission.service_status, "allow");
        if (sandbox !== "danger-full-access") assert.equal(permission.external_directory, "deny");
      }
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = saved;
    }
  });

  it("rejects errors, nonzero exits, incomplete tool loops and truncated generations", async () => {
    const cases = [
      { body: "done(); console.error('login expired'); process.exitCode=1;", error: /login expired/ },
      { body: "console.log(JSON.stringify({type:'error',sessionID:sessionId,error:{name:'APIError',data:{message:'provider unavailable'}}}));", error: /provider unavailable/ },
      { body: "emit('step_start', {}); emit('text',{text:'still working'}); emit('step_finish',{reason:'tool-calls'});", error: /session did not finish.*tool-calls/ },
      { body: "emit('step_start', {}); emit('text',{text:'cut off'}); emit('step_finish',{reason:'length'});", error: /session did not finish.*length/ },
      { body: "emit('text',{text:'partial'});", error: /session did not finish/ },
      { body: "console.error('could not authenticate'); process.exitCode=2;", error: /could not authenticate/ },
    ];
    for (const { body, error } of cases) {
      const result = await run(fakeOpenCode(body));
      assert.equal(result.ok, false);
      assert.equal(result.busy, undefined);
      assert.match(result.error!, error);
    }
  });

  it("requires valid JSON, one valid session and a nonempty final response", async () => {
    const cases = [
      { body: "console.log('not JSON');", error: /no valid JSON/ },
      { body: "console.log(JSON.stringify({type:'text',sessionID:'../outside',part:{text:'wrong'}}));", error: /valid sessionID/ },
      { body: "done('  ');", error: /no final response/ },
      { body: "done(); console.log(JSON.stringify({type:'text',sessionID:'ses_other',part:{text:'wrong'}}));", error: /different session/ },
    ];
    for (const { body, error } of cases) {
      const result = await run(fakeOpenCode(body));
      assert.equal(result.ok, false);
      assert.match(result.error!, error);
    }
    const mismatch = await run(fakeOpenCode("console.log(JSON.stringify({type:'step_start',sessionID:'ses_other'}));"), { sessionId: "ses_original" });
    assert.match(mismatch.error!, /different session/);
    for (const sessionId of ["", "ses_a b", "ses_../outside", "ses_x\n", "ses_$(id)", "ses_\u0000x"]) {
      const result = await run(fakeOpenCode("import {writeFileSync} from 'node:fs'; writeFileSync('invoked','yes'); done();"), { sessionId });
      assert.match(result.error!, /invalid sessionId/);
    }
    assert.equal(existsSync(join(scratch, "invoked")), false);
  });

  it("identifies only a native pre-turn missing resume target", async () => {
    const native = "console.error('\\u001b[91m\\u001b[1mError: \\u001b[0mSession not found'); process.exitCode=1;";
    assert.equal((await run(fakeOpenCode(native), { sessionId: "ses_deleted" })).sessionGone, true);
    for (const body of [
      native, // Without an explicit resume target this cannot justify recreating a session.
      "console.error('Error: provider not found'); process.exitCode=1;",
      "console.error('Error: Session not found in provider response'); process.exitCode=1;",
      "done(); console.error('Error: Session not found'); process.exitCode=1;",
      "console.log(JSON.stringify({type:'error',sessionID:sessionId,error:{name:'APIError',data:{message:'Session not found'}}})); process.exitCode=1;",
    ]) {
      const result = await run(fakeOpenCode(body), body === native ? {} : { sessionId: "ses_deleted" });
      assert.equal(result.sessionGone, undefined, body);
    }
  });

  it("bounds CLI output and flushes responses larger than a pipe buffer", async () => {
    const large = await run(fakeOpenCode("done('x'.repeat(128 * 1024));"));
    assert.equal(large.ok, true);
    assert.equal(large.lastMessage?.length, 128 * 1024);
    const excessive = await run(fakeOpenCode("done('x'.repeat(2 * 1024 * 1024));"));
    assert.equal(excessive.ok, false);
    assert.match(excessive.error!, /output exceeded/);
  });

  it("keeps a session leased until process exit and excludes duplicate runners", async () => {
    const bin = fakeOpenCode(`
      import { appendFileSync, existsSync } from 'node:fs';
      appendFileSync(sessionId + '.started', 'x');
      const timer = setInterval(() => {
        if (!existsSync(sessionId + '.release')) return;
        clearInterval(timer);
        done();
      }, 10);
    `);
    const first = run(bin, { sessionId: "ses_first" });
    const second = run(bin, { sessionId: "ses_second" });
    try {
      await waitFor(() => existsSync(join(scratch, "ses_first.started")) && existsSync(join(scratch, "ses_second.started")));
      let starts = 0;
      const duplicate = await run(bin, { sessionId: "ses_first", onStart: () => { starts++; } });
      assert.equal(duplicate.busy, true);
      assert.equal(starts, 0);
      assert.equal(readFileSync(join(scratch, "ses_first.started"), "utf8"), "x");
    } finally {
      for (const id of ["ses_first", "ses_second"]) writeFileSync(join(scratch, `${id}.release`), "go");
      assert.ok((await Promise.all([first, second])).every((result) => result.ok));
    }
    assert.equal(existsSync(join(scratch, "sessions", "ses_first.opencode.lock")), false);
    assert.equal((await run(bin, { sessionId: "ses_first" })).ok, true);
  });

  it("does not launch a turn if the fire start cannot be recorded", async () => {
    const bin = fakeOpenCode("import {writeFileSync} from 'node:fs'; writeFileSync('invoked','yes'); done();");
    const result = await run(bin, { sessionId: "ses_receipt", onStart: () => { throw new Error("disk full"); } });
    assert.match(result.error!, /could not record turn start: disk full/);
    assert.equal(existsSync(join(scratch, "invoked")), false);
  });

  it("releases the lease without starting if the daemon dies during authorization", async () => {
    const bin = fakeOpenCode("import {writeFileSync} from 'node:fs'; writeFileSync('invoked','yes'); done();");
    const parent = spawnParent(bin, "ses_handshake", 5000, true);
    await new Promise((resolve) => parent.once("close", resolve));
    assert.equal(existsSync(join(scratch, "acquired")), true);
    await waitFor(() => !existsSync(join(scratch, "sessions", "ses_handshake.opencode.lock")));
    assert.equal(existsSync(join(scratch, "invoked")), false);
  });

  it("retains the lease after daemon death and stops detached tools and their stubborn descendants at the deadline", async () => {
    writeFileSync(join(scratch, "leaf.mjs"), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync('leaf.pid', String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => appendFileSync('leaf-heartbeat','x'),10);
    `);
    writeFileSync(join(scratch, "tool.mjs"), `
      import { spawn } from 'node:child_process';
      import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync('tool.pid', String(process.pid));
      spawn(process.execPath, ['leaf.mjs'], {detached:true,stdio:['ignore',process.stdout,process.stderr]});
      process.on('SIGTERM', () => {});
      setInterval(() => appendFileSync('heartbeat','x'),10);
    `);
    const bin = fakeOpenCode(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      writeFileSync('cli.pid', String(process.pid));
      spawn(process.execPath, ['tool.mjs'], {detached:true,stdio:['ignore',process.stdout,process.stderr]});
      process.on('SIGTERM', () => {});
      setInterval(() => { process.stdout.write('still working\\n'); }, 20);
    `);
    const parent = spawnParent(bin, "ses_deadline", 1400);
    const parentExit = new Promise((resolve) => parent.once("close", resolve));
    const lock = join(scratch, "sessions", "ses_deadline.opencode.lock");
    let owner: number | undefined;
    try {
      await waitFor(() => existsSync(join(scratch, "heartbeat")) && existsSync(join(scratch, "leaf-heartbeat")));
      owner = JSON.parse(readFileSync(lock, "utf8")).pid;
      parent.kill("SIGKILL");
      await parentExit;
      assert.equal(existsSync(lock), true);
      assert.equal((await run(bin, { sessionId: "ses_deadline" })).busy, true);
      await waitFor(() => !existsSync(lock));
      const heartbeat = readFileSync(join(scratch, "heartbeat"), "utf8");
      const leafHeartbeat = readFileSync(join(scratch, "leaf-heartbeat"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(readFileSync(join(scratch, "heartbeat"), "utf8"), heartbeat);
      assert.equal(readFileSync(join(scratch, "leaf-heartbeat"), "utf8"), leafHeartbeat);
      const cliPid = Number(readFileSync(join(scratch, "cli.pid"), "utf8"));
      assert.throws(() => process.kill(cliPid, 0), { code: "ESRCH" });
      assert.equal((await run(fakeOpenCode("done();"), { sessionId: "ses_deadline" })).ok, true);
    } finally {
      parent.kill("SIGKILL");
      await parentExit;
      if (owner && existsSync(lock)) {
        try { process.kill(owner, "SIGTERM"); } catch { /* already closed */ }
        await waitFor(() => !existsSync(lock));
      }
      for (const file of ["tool.pid", "leaf.pid"]) {
        if (!existsSync(join(scratch, file))) continue;
        try { process.kill(Number(readFileSync(join(scratch, file), "utf8")), "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  });

  it("stops detached tools before resolving an ordinary timeout and releasing the session", async () => {
    writeFileSync(join(scratch, "tool.mjs"), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync('tool.pid', String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => appendFileSync('heartbeat','x'),10);
    `);
    const bin = fakeOpenCode(`
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['tool.mjs'], {detached:true,stdio:'ignore'});
      setInterval(() => {}, 1000);
    `);
    try {
      const result = await run(bin, { sessionId: "ses_timeout", timeoutMs: 600 });
      assert.match(result.error!, /timed out/);
      assert.equal(existsSync(join(scratch, "sessions", "ses_timeout.opencode.lock")), false);
      const heartbeat = readFileSync(join(scratch, "heartbeat"), "utf8");
      assert.ok(heartbeat.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(readFileSync(join(scratch, "heartbeat"), "utf8"), heartbeat);
      assert.equal((await run(fakeOpenCode("done();"), { sessionId: "ses_timeout" })).ok, true);
    } finally {
      if (existsSync(join(scratch, "tool.pid"))) {
        try { process.kill(Number(readFileSync(join(scratch, "tool.pid"), "utf8")), "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  });

  it("runs Node-based installations without node on the service PATH", async () => {
    const script = fakeOpenCode("done(process.execPath);");
    const bin = join(scratch, "opencode");
    symlinkSync(script, bin);
    const saved = process.env.PATH;
    process.env.PATH = join(scratch, "empty");
    try {
      assert.equal((await run(bin)).lastMessage, process.execPath);
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });

  it("finds an explicit executable, then PATH, then the shell installer location", () => {
    const saved = { OPENCODE_BIN: process.env.OPENCODE_BIN, PATH: process.env.PATH, HOME: process.env.HOME };
    const explicit = join(scratch, "explicit");
    const pathBin = join(scratch, "bin");
    const localBin = join(scratch, ".opencode", "bin");
    mkdirSync(pathBin);
    mkdirSync(localBin, { recursive: true });
    for (const bin of [explicit, join(pathBin, "opencode"), join(localBin, "opencode")]) writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    Object.assign(process.env, { OPENCODE_BIN: explicit, PATH: pathBin, HOME: scratch });
    try {
      assert.equal(findOpenCode(), explicit);
      delete process.env.OPENCODE_BIN;
      assert.equal(findOpenCode(), join(pathBin, "opencode"));
      process.env.PATH = "";
      assert.equal(findOpenCode(), join(localBin, "opencode"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
