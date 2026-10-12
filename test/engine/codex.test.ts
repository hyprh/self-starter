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

  it("reads failures from the JSON event stream", () => {
    const failed = parseExecJsonl(
      [JSON.stringify({ type: "thread.started", thread_id: "t" }), JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })].join("\n"),
    );
    assert.deepEqual(failed, { ok: false, threadId: "t", error: "usage limit reached" });
    assert.equal(parseExecJsonl("garbage\n").error, "the turn did not complete");
  });
});
