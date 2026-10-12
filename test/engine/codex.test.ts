import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CodexCli, parseExecJsonl } from "../../src/engine/codex.js";
import { tempHome } from "./fixtures.js";

// Stands in for the codex CLI: records its arguments and answers like the real one.
const FAKE_CODEX = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "queue") {
  if (args[2] === "missing") { console.error("Error: thread not found: missing"); process.exit(1); }
  console.log("Queued message q-123 for thread " + args[2] + ".");
} else if (args[0] === "exec") {
  const threadId = args[1] === "resume" ? args[args.length - 2] : "thread-new-1";
  console.error("WARNING: proceeding, even though we could not update PATH");
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: '{"summary":"ok","notify":false}' } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
} else if (args[0] === "app-server") {
  // JSON-RPC over stdio. Threads live in FAKE_THREADS: { [id]: { turns: [...], queued: [text] } }.
  const { createInterface } = await import("node:readline");
  const { existsSync, readFileSync, renameSync, writeFileSync } = await import("node:fs");
  const file = process.env.FAKE_THREADS;
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const save = (threads) => {
    writeFileSync(file + ".tmp", JSON.stringify(threads));
    renameSync(file + ".tmp", file);
  };
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
  const turnOf = (text, reply) => ({ id: "turn-" + Math.random().toString(36).slice(2), status: "completed", items: [{ type: "userMessage", text }, { type: "agentMessage", text: reply }] });
  const announce = (threadId, turn) => {
    send({ method: "turn/started", params: { threadId, turn: { id: turn.id, status: "inProgress", items: [] } } });
    send({ method: "turn/completed", params: { threadId, turn } });
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params = {} } = JSON.parse(line);
    if (id === undefined) return;
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: ["app-server", method], params, cwd: process.cwd() }) + "\\n");
    if (method === "initialize" || method === "thread/name/set") return send({ id, result: {} });
    if (method === "thread/start") return send({ id, result: { thread: { id: "thread-app-1" } } });
    if (method === "turn/start") {
      send({ id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      return announce(params.threadId, turnOf(params.input[0].text, '{"summary":"ready","notify":false}'));
    }
    if (method === "thread/turns/list") return send({ id, result: { data: [...(load()[params.threadId]?.turns ?? [])].reverse() } });
    if (method === "thread/resume") {
      send({ id, result: { thread: { id: params.threadId } } });
      const threads = load();
      const thread = threads[params.threadId] ?? { turns: [], queued: [] };
      const next = (thread.queued ?? []).shift();
      if (next === undefined) return;
      const turn = turnOf(next, "handled: " + next);
      thread.turns.push(turn);
      save({ ...threads, [params.threadId]: thread }); // before the turn is announced, like a rollout on disk
      return announce(params.threadId, turn);
    }
    send({ id, error: { code: -32601, message: "unknown method " + method } });
  });
}
`;

describe("codex CLI wrapper", () => {
  let home: ReturnType<typeof tempHome>;
  let codex: CodexCli;
  let logFile: string;
  const calls = () => readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string });

  before(() => {
    home = tempHome();
    const script = join(home.paths.home, "codex.mjs");
    writeFileSync(script, FAKE_CODEX);
    logFile = join(home.paths.home, "calls.jsonl");
    writeFileSync(logFile, "");
    process.env.FAKE_CODEX_LOG = logFile;
    codex = new CodexCli(script);
  });
  after(() => home.cleanup());

  it("queues a message into a thread", async () => {
    assert.deepEqual(await codex.queue("thread-1", "hello"), { submissionId: "q-123" });
    assert.deepEqual(calls().at(-1)!.args, ["queue", "--thread", "thread-1", "--message", "hello"]);
    await assert.rejects(codex.queue("missing", "hello"), /codex queue failed: Error: thread not found: missing/);
  });

  it("creates a thread with codex exec", async () => {
    const result = await codex.exec({ cwd: home.paths.home, prompt: "seed", sandbox: "read-only", outputSchemaPath: "/s.json", timeoutMs: 10_000 });
    assert.deepEqual(result, { ok: true, threadId: "thread-new-1", lastMessage: '{"summary":"ok","notify":false}' });
    assert.deepEqual(calls().at(-1)!.args, ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", home.paths.home, "--output-schema", "/s.json", "seed"]);
  });

  it("runs a turn in an existing thread with codex exec resume", async () => {
    const result = await codex.resume({ threadId: "thread-7", cwd: home.paths.home, prompt: "fire!", sandbox: "workspace-write", timeoutMs: 10_000 });
    assert.equal(result.ok, true);
    assert.equal(result.threadId, "thread-7");
    const call = calls().at(-1)!;
    assert.deepEqual(call.args, ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "thread-7", "fire!"]);
    assert.equal(call.cwd, home.paths.home);
  });

  describe("through the app server", () => {
    const threads = (state: Record<string, { turns: Array<{ status: string; items?: unknown[] }>; queued?: string[] }>) =>
      writeFileSync(process.env.FAKE_THREADS!, JSON.stringify(state));
    const appServerCalls = (method: string) =>
      calls().filter((call) => call.args[0] === "app-server" && call.args[1] === method) as Array<{ args: string[]; cwd: string; params: Record<string, unknown> }>;

    before(() => {
      process.env.FAKE_THREADS = join(home.paths.home, "threads.json");
    });

    it("creates and names a thread, and returns its first turn", async () => {
      const result = await codex.startThread({ cwd: home.paths.home, name: "Trigger: CI", prompt: "seed", outputSchema: { type: "object" }, timeoutMs: 10_000 });
      assert.deepEqual(result, { ok: true, threadId: "thread-app-1", lastMessage: '{"summary":"ready","notify":false}' });
      assert.deepEqual(appServerCalls("thread/name/set").at(-1)!.params, { threadId: "thread-app-1", name: "Trigger: CI" });
      assert.deepEqual(appServerCalls("turn/start").at(-1)!.params.outputSchema, { type: "object" });
    });

    it("looks at a thread without loading it", async () => {
      threads({
        idle: { turns: [{ status: "completed", items: [{ type: "userMessage", text: "[self-starter] CI failed (ci · fire #1 · fire_abc)" }] }] },
        busy: { turns: [{ status: "completed" }, { status: "inProgress" }] },
      });
      assert.deepEqual(await codex.inspectThread("idle", "fire_abc"), { mentions: true, busy: false });
      assert.deepEqual(await codex.inspectThread("idle", "fire_zzz"), { mentions: false, busy: false });
      assert.deepEqual(await codex.inspectThread("busy", "fire_abc"), { mentions: false, busy: true });
      assert.equal(appServerCalls("thread/resume").length, 0, "inspecting never resumes");
    });

    it("wakes a thread so the message queued for it runs there", async () => {
      threads({ closed: { turns: [], queued: ["[self-starter] CI failed (ci · fire #2 · fire_q1)"] } });
      const result = await codex.wakeThread({ threadId: "closed", cwd: home.paths.home, sandbox: "workspace-write", timeoutMs: 10_000 });
      assert.deepEqual(result, { ok: true, threadId: "closed", lastMessage: "handled: [self-starter] CI failed (ci · fire #2 · fire_q1)" });
      const resume = appServerCalls("thread/resume").at(-1)!;
      assert.equal(resume.params.approvalPolicy, "never", "nobody is there to approve anything");
      assert.equal(resume.params.sandbox, "workspace-write");
      assert.equal(resume.cwd, home.paths.home);

      const nothing = await codex.wakeThread({ threadId: "closed", sandbox: "workspace-write", timeoutMs: 10_000, startTimeoutMs: 300 });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error ?? "", /waiting for the queued message to start/);
    });
  });

  it("reads failures from the JSON event stream", () => {
    const failed = parseExecJsonl(
      [JSON.stringify({ type: "thread.started", thread_id: "t" }), JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })].join("\n"),
    );
    assert.deepEqual(failed, { ok: false, threadId: "t", error: "usage limit reached" });
    assert.equal(parseExecJsonl("garbage\n").error, "the turn did not complete");
  });
});
