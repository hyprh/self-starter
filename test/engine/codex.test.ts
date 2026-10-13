import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CodexCli } from "../../src/engine/codex.js";
import { tempHome } from "./fixtures.js";

// Stands in for the codex CLI: records its arguments and answers like the real one.
const FAKE_CODEX = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "queue") {
  if (args[2] === "missing") { console.error("Error: thread not found: missing"); process.exit(1); }
  console.log("Queued message q-123 for thread " + args[2] + ".");
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
  const started = (threadId, turn) => send({ method: "turn/started", params: { threadId, turn: { id: turn.id, status: "inProgress", items: [] } } });
  // Like the real server, a completed turn carries only its agent messages ("summary" view).
  const completed = (threadId, turn) => send({ method: "turn/completed", params: { threadId, turn: { ...turn, items: turn.items.filter((item) => item.type === "agentMessage") } } });
  const answers = new Map(); // id of a request sent to the client -> what happens once it answers
  const hanging = new Map(); // turn id -> how it ends when interrupted
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
      appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: ["app-server", "answer"], params: message, cwd: process.cwd() }) + "\\n");
      return answers.get(message.id)?.();
    }
    const { id, method, params = {} } = message;
    if (id === undefined) return;
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: ["app-server", method], params, cwd: process.cwd() }) + "\\n");
    if (method === "initialize" || method === "thread/name/set") return send({ id, result: {} });
    if (method === "thread/start") return send({ id, result: { thread: { id: "thread-app-1" } } });
    if (method === "turn/start") {
      send({ id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      const turn = turnOf(params.input[0].text, "Ready.");
      started(params.threadId, turn);
      return completed(params.threadId, turn);
    }
    if (method === "turn/interrupt") {
      send({ id, result: {} });
      return hanging.get(params.turnId)?.();
    }
    if (method === "thread/turns/list") {
      const turns = [...(load()[params.threadId]?.turns ?? [])].reverse();
      return send({ id, result: { data: turns.slice(0, params.limit ?? turns.length) } });
    }
    if (method === "thread/resume") {
      send({ id, result: { thread: { id: params.threadId } } });
      // Each queued message runs as soon as the previous turn ends.
      const runNext = () => {
        const threads = load();
        const thread = threads[params.threadId] ?? { turns: [], queued: [] };
        const next = (thread.queued ?? []).shift();
        if (next === undefined) return;
        const turn = turnOf(next, "handled: " + next);
        thread.turns.push(turn);
        save({ ...threads, [params.threadId]: thread }); // before the turn is announced, like a rollout on disk
        started(params.threadId, turn);
        if (next.includes("HANG")) return hanging.set(turn.id, () => completed(params.threadId, { ...turn, status: "interrupted" }));
        // Mid-turn, it asks to run a command outside the sandbox; the turn ends once the client answers.
        const request = "approval-" + thread.turns.length;
        answers.set(request, () => {
          completed(params.threadId, turn);
          runNext();
        });
        send({ id: request, method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, command: "curl https://example.com" } });
      };
      return runNext();
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

  describe("through the app server", () => {
    const threads = (state: Record<string, { turns: Array<{ status: string; completedAt?: number | null; items?: unknown[] }>; queued?: string[] }>) =>
      writeFileSync(process.env.FAKE_THREADS!, JSON.stringify(state));
    const appServerCalls = (method: string) =>
      calls().filter((call) => call.args[0] === "app-server" && call.args[1] === method) as Array<{ args: string[]; cwd: string; params: Record<string, unknown> }>;

    before(() => {
      process.env.FAKE_THREADS = join(home.paths.home, "threads.json");
    });

    it("creates and names a thread, and returns its first turn", async () => {
      const result = await codex.startThread({ cwd: home.paths.home, name: "Trigger: CI", prompt: "seed", timeoutMs: 10_000 });
      assert.deepEqual(result, { ok: true, threadId: "thread-app-1", lastMessage: "Ready." });
      assert.deepEqual(appServerCalls("thread/name/set").at(-1)!.params, { threadId: "thread-app-1", name: "Trigger: CI" });
      assert.equal(appServerCalls("thread/start").at(-1)!.cwd, home.paths.home);
    });

    it("looks at a thread without loading it", async () => {
      threads({
        idle: { turns: [{ status: "completed", completedAt: 1, items: [{ type: "userMessage", text: "[self-starter] CI failed (ci · fire #1 · fire_abc)" }] }] },
        // Seen from another process, a turn still running is listed as interrupted, without an end time.
        busy: { turns: [{ status: "completed", completedAt: 1 }, { status: "interrupted", completedAt: null }] },
        stopped: { turns: [{ status: "completed", completedAt: 1 }, { status: "interrupted", completedAt: 2 }] },
      });
      assert.deepEqual(await codex.inspectThread("idle", "fire_abc"), { mentions: true, busy: false });
      assert.deepEqual(await codex.inspectThread("idle", "fire_zzz"), { mentions: false, busy: false });
      assert.deepEqual(await codex.inspectThread("busy", "fire_abc"), { mentions: false, busy: true });
      assert.deepEqual(await codex.inspectThread("stopped", "fire_abc"), { mentions: false, busy: false });
      assert.equal(appServerCalls("thread/resume").length, 0, "inspecting never resumes");
    });

    it("wakes a thread and stays until every message queued for it ran", async () => {
      const queued = ["[self-starter] Deploy done (deploy · fire #1 · fire_q0)", "[self-starter] CI failed (ci · fire #2 · fire_q1)"];
      threads({ closed: { turns: [], queued } });
      const result = await codex.wakeThread({ threadId: "closed", marker: "fire_q0", sandbox: "workspace-write", timeoutMs: 10_000 });
      assert.deepEqual(result, { ok: true, threadId: "closed", lastMessage: `handled: ${queued[0]}` }, "the answer to the marker's own message");
      const thread = JSON.parse(readFileSync(process.env.FAKE_THREADS!, "utf8")).closed;
      assert.equal(thread.turns.length, 2, "the second message ran too, instead of being cut off");
      assert.deepEqual(thread.queued, []);
      const resume = appServerCalls("thread/resume").at(-1)!;
      assert.deepEqual(resume.params, { threadId: "closed", sandbox: "workspace-write", excludeTurns: true }, "the thread keeps its own folder and approval policy");
      const answers = appServerCalls("answer").map((call) => call.params);
      assert.deepEqual(answers.map((answer) => answer.id), ["approval-1", "approval-2"]);
      assert.ok(answers.every((answer) => answer.error && !answer.result), "nobody is there to approve anything");

      const nothing = await codex.wakeThread({ threadId: "closed", marker: "fire_q2", sandbox: "workspace-write", timeoutMs: 10_000, startTimeoutMs: 300 });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error ?? "", /waiting for the queued message to start/);
    });

    it("moves a thread of the trigger's own to its folder when waking it", async () => {
      threads({ own: { turns: [], queued: ["[self-starter] CI failed (ci · fire #3 · fire_q3)"] } });
      const result = await codex.wakeThread({ threadId: "own", marker: "fire_q3", sandbox: "read-only", cwd: "/work/app", timeoutMs: 10_000 });
      assert.equal(result.ok, true);
      assert.deepEqual(appServerCalls("thread/resume").at(-1)!.params, { threadId: "own", sandbox: "read-only", excludeTurns: true, cwd: "/work/app" });
    });

    it("stops a woken turn that runs too long", async () => {
      threads({ stuck: { turns: [], queued: ["[self-starter] HANG (build · fire #1 · fire_h1)"] } });
      const result = await codex.wakeThread({ threadId: "stuck", marker: "fire_h1", sandbox: "workspace-write", timeoutMs: 300 });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /waiting for the turn to finish/);
      const turnId = JSON.parse(readFileSync(process.env.FAKE_THREADS!, "utf8")).stuck.turns[0].id;
      assert.deepEqual(appServerCalls("turn/interrupt").at(-1)!.params, { threadId: "stuck", turnId }, "recorded as over, so it does not look busy later");
    });
  });
});
