import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ANTIGRAVITY_SESSION_VARIABLES,
  AntigravityCli,
  findAntigravity,
  type AntigravityRunOptions,
} from "../../src/engine/antigravity.js";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "ss-agy-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in CLI speaking Antigravity's `--print --output-format json` contract. */
function fakeAgy(body: string): string {
  const path = join(scratch, "agy.mjs");
  writeFileSync(path, body);
  return path;
}

function run(bin: string, options: Partial<AntigravityRunOptions> = {}) {
  return new AntigravityCli(bin, join(scratch, "sessions")).run({
    cwd: scratch,
    message: "[self-starter] inspect the event",
    sandbox: "workspace-write",
    timeoutMs: 5000,
    ...options,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for child process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Antigravity's dedicated CLI sessions", () => {
  it("starts a session, resumes with --conversation, passes sandbox env, and strips active session variables", async () => {
    const bin = fakeAgy(`
      import { writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      const resumed = args.includes('--conversation');
      const conversation_id = resumed ? args[args.indexOf('--conversation') + 1] : 'conv-new-1';
      const leaked = ${JSON.stringify(ANTIGRAVITY_SESSION_VARIABLES)}.filter((key) => process.env[key] !== undefined);
      writeFileSync('received.json', JSON.stringify({
        args,
        cwd: process.cwd(),
        host: process.env.SELF_STARTER_HOST,
        trigger: process.env.SELF_STARTER_TRIGGER_TURN,
        sandbox: process.env.SELF_STARTER_SANDBOX,
        workspace: process.env.SELF_STARTER_WORKSPACE,
        leaked,
      }));
      console.log(JSON.stringify({ conversation_id, status: 'SUCCESS', response: 'Checked: all good' }));
    `);
    const saved = Object.fromEntries(ANTIGRAVITY_SESSION_VARIABLES.map((key) => [key, process.env[key]]));
    for (const key of ANTIGRAVITY_SESSION_VARIABLES) process.env[key] = `parent-${key}`;
    try {
      const message = "[self-starter] literal 'quotes' $(touch unexpected) `touch unexpected`\nsecond line";
      let starts = 0;
      const first = await run(bin, { message, sandbox: "read-only", onStart: () => { starts++; } });
      assert.equal(starts, 1);
      assert.deepEqual(first, { ok: true, sessionId: "conv-new-1", lastMessage: "Checked: all good" });
      const recorded = () => JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
      assert.deepEqual(recorded(), {
        args: ["--print", message, "--dangerously-skip-permissions", "--output-format", "json"],
        cwd: realpathSync(scratch),
        host: "antigravity",
        trigger: "1",
        sandbox: "read-only",
        workspace: scratch,
        leaked: [],
      });
      assert.equal(existsSync(join(scratch, "unexpected")), false);

      assert.deepEqual(await run(bin, { sessionId: first.sessionId, onStart: () => { starts++; } }), first);
      assert.equal(starts, 2);
      assert.deepEqual(recorded().args.slice(-2), ["--conversation", "conv-new-1"]);
      assert.equal(recorded().sandbox, "workspace-write");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not treat a nonzero exit, structured error, or non-SUCCESS status as success", async () => {
    const cases = [
      { body: "console.log(JSON.stringify({conversation_id:'conv_1',status:'SUCCESS',response:'partial'})); console.error('auth expired'); process.exitCode=1;", error: /auth expired/ },
      { body: "console.log(JSON.stringify({error:{message:'quota exceeded'}}));", error: /quota exceeded/ },
      { body: "console.log(JSON.stringify({conversation_id:'conv_1',status:'ERROR',response:'failed'}));", error: /session did not finish/ },
      { body: "console.error('server unavailable'); process.exitCode=3;", error: /server unavailable/ },
    ];
    for (const { body, error } of cases) {
      const result = await run(fakeAgy(body));
      assert.equal(result.ok, false);
      assert.equal(result.busy, undefined);
      assert.match(result.error!, error);
    }
  });

  it("requires a usable JSON result and refuses a resumed result for a different conversation", async () => {
    for (const value of [null, [], {}, { response: "no id" }, { conversation_id: "conv_1" }, { conversation_id: "conv_1", response: "  " }]) {
      const result = await run(fakeAgy(`console.log(${JSON.stringify(JSON.stringify(value))});`));
      assert.equal(result.ok, false, JSON.stringify(value));
    }
    const mismatched = await run(
      fakeAgy("console.log(JSON.stringify({conversation_id:'conv_other',status:'SUCCESS',response:'wrong conversation'}));"),
      { sessionId: "conv_1" },
    );
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.sessionGone, undefined);
    assert.match(mismatched.error!, /different session/);
    const invalid = await run(fakeAgy("console.log('Not JSON');"));
    assert.match(invalid.error!, /no valid JSON result/);
  });

  it("identifies missing conversations on stderr both when stdout is empty and when agy allocates a fallback id", async () => {
    const emptyMissing = "console.error('warning: conversation \"conv_deleted\" not found'); process.exitCode=1;";
    assert.equal((await run(fakeAgy(emptyMissing), { sessionId: "conv_deleted" })).sessionGone, true);

    const fallbackMissing = "console.error('warning: conversation \"conv_deleted\" not found'); console.log(JSON.stringify({conversation_id:'conv_brand_new',status:'SUCCESS',response:'started fresh'}));";
    assert.equal((await run(fakeAgy(fallbackMissing), { sessionId: "conv_deleted" })).sessionGone, true);

    for (const body of [
      emptyMissing,
      "console.error('warning: conversation \"conv_other\" not found'); process.exitCode=1;",
      "console.error('warning: conversation \"conv_deleted\" not found'); console.log(JSON.stringify({conversation_id:'conv_deleted',status:'SUCCESS',response:'actual session'}));",
    ]) {
      const result = await run(fakeAgy(body), body === emptyMissing ? {} : { sessionId: "conv_deleted" });
      assert.equal(result.sessionGone, undefined, body);
    }
  });

  it("rejects malformed conversation ids before saving or resuming", async () => {
    for (const sessionId of ["", " ", "conv.bad", "conv_a b", "conv;touch", "conv_$(id)", "conv/../outside", "conv_\u0000x"]) {
      const bin = fakeAgy(`
        import { writeFileSync } from 'node:fs';
        writeFileSync('invoked', 'yes');
        console.log(${JSON.stringify(JSON.stringify({ conversation_id: sessionId, status: "SUCCESS", response: "done" }))});
      `);
      const malformed = await run(bin);
      assert.equal(malformed.ok, false, JSON.stringify(sessionId));
      assert.match(malformed.error!, /no valid conversation_id/);
      rmSync(join(scratch, "invoked"));
      const resumed = await run(bin, { sessionId });
      assert.match(resumed.error!, /invalid sessionId to resume/);
      assert.equal(existsSync(join(scratch, "invoked")), false);
    }
  });

  it("keeps one resumed turn per conversation, while different conversations run concurrently", async () => {
    const bin = fakeAgy(`
      import { appendFileSync, existsSync } from 'node:fs';
      const id = process.argv[process.argv.indexOf('--conversation') + 1];
      appendFileSync(id + '.started', 'x');
      const timer = setInterval(() => {
        if (!existsSync(id + '.release')) return;
        clearInterval(timer);
        console.log(JSON.stringify({ conversation_id: id, status: 'SUCCESS', response: 'done' }));
      }, 10);
    `);
    let starts = 0;
    const first = run(bin, { sessionId: "conv_first", onStart: () => { starts++; } });
    const second = run(bin, { sessionId: "conv_second", onStart: () => { starts++; } });
    try {
      await waitFor(() => existsSync(join(scratch, "conv_first.started")) && existsSync(join(scratch, "conv_second.started")));
      const duplicate = await run(bin, { sessionId: "conv_first", onStart: () => { starts++; } });
      assert.equal(duplicate.busy, true);
      assert.equal(duplicate.ok, false);
      assert.equal(starts, 2);
      assert.equal(readFileSync(join(scratch, "conv_first.started"), "utf8"), "x");
    } finally {
      for (const id of ["conv_first", "conv_second"]) writeFileSync(join(scratch, `${id}.release`), "go");
      const results = await Promise.all([first, second]);
      assert.ok(results.every((result) => result.ok));
    }
    assert.equal(existsSync(join(scratch, "sessions", "conv_first.antigravity.lock")), false);
  });

  it("recovers a dead owner's lease, leaves malformed leases intact, and works when PATH has no node", async () => {
    const script = fakeAgy("console.log(JSON.stringify({conversation_id:'conv_stale',status:'SUCCESS',response:process.execPath}));");
    const bin = join(scratch, "agy");
    symlinkSync(script, bin);
    const sessions = join(scratch, "sessions");
    mkdirSync(sessions);
    const lock = join(sessions, "conv_stale.antigravity.lock");
    const expired = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => expired.once("close", resolve));
    writeFileSync(lock, JSON.stringify({ pid: expired.pid, token: randomUUID() }));
    const savedPath = process.env.PATH;
    process.env.PATH = join(scratch, "empty");
    try {
      assert.deepEqual(await run(bin, { sessionId: "conv_stale" }), { ok: true, sessionId: "conv_stale", lastMessage: process.execPath });
      assert.equal(existsSync(lock), false);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    writeFileSync(lock, "{");
    const malformed = await run(bin, { sessionId: "conv_stale" });
    assert.equal(malformed.ok, false);
    assert.match(malformed.error!, /Invalid Antigravity lease.*manually/);
  });

  it("finds AGY_BIN first, then PATH, then ~/.local/bin/agy and ~/.antigravity/bin/agy", () => {
    const saved = { AGY_BIN: process.env.AGY_BIN, PATH: process.env.PATH, HOME: process.env.HOME };
    const explicit = join(scratch, "explicit-agy");
    const pathBin = join(scratch, "bin");
    const localBin = join(scratch, ".local", "bin");
    const agyHomeBin = join(scratch, ".antigravity", "bin");
    for (const dir of [pathBin, localBin, agyHomeBin]) mkdirSync(dir, { recursive: true });
    for (const file of [explicit, join(pathBin, "agy"), join(localBin, "agy"), join(agyHomeBin, "agy")]) {
      writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    Object.assign(process.env, { AGY_BIN: explicit, PATH: pathBin, HOME: scratch });
    try {
      assert.equal(findAntigravity(), explicit);
      delete process.env.AGY_BIN;
      assert.equal(findAntigravity(), join(pathBin, "agy"));
      process.env.PATH = "";
      assert.equal(findAntigravity(), join(localBin, "agy"));
      rmSync(join(localBin, "agy"));
      assert.equal(findAntigravity(), join(agyHomeBin, "agy"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
