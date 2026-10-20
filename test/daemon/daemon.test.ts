import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { callDaemon, RemoteError } from "../../src/client/client.js";
import { AlreadyRunning, startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import { bundledDeno } from "../../src/engine/config.js";
import { callerFrom, runMcpServer, TOOLS } from "../../src/mcp/server.js";
import { eventually, FakeCodex, FakeZCode, RecordingNotifier, STATE_PROBE, startServer, tempHome, type TestServer } from "../engine/fixtures.js";

const deno = bundledDeno();

type Json = Record<string, any>;

/** Talks to runMcpServer over in-memory streams, the way Codex does over stdio. */
class McpClient {
  private readonly toServer = new PassThrough();
  private readonly fromServer = new PassThrough();
  private readonly waiting = new Map<number, (message: Json) => void>();
  private nextId = 1;
  /** Requests the server sent to the client (such as dialogs); it should send none. */
  readonly serverRequests: Json[] = [];
  readonly done: Promise<void>;

  constructor(options: Parameters<typeof runMcpServer>[0]) {
    // As Codex starts it, whatever session the tests themselves run in.
    this.done = runMcpServer({ session: undefined, ...options, input: this.toServer, output: this.fromServer });
    createInterface({ input: this.fromServer }).on("line", (line) => {
      const message = JSON.parse(line) as Json;
      if (message.method) {
        this.serverRequests.push(message);
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not handled" } });
        return;
      }
      this.waiting.get(message.id)?.(message);
    });
  }

  private send(message: Json): void {
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async tool(name: string, args: Json, meta: Json): Promise<{ text: string; isError: boolean }> {
    const response = await this.request("tools/call", { name, arguments: args, _meta: meta });
    return { text: response.result.content[0].text as string, isError: response.result.isError === true };
  }

  close(): Promise<void> {
    this.toServer.end();
    return this.done;
  }
}

describe("daemon, control socket and MCP server", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let home: ReturnType<typeof tempHome>;
  let daemon: Daemon;
  const codex = new FakeCodex();
  const zcode = new FakeZCode();
  const notifier = new RecordingNotifier();

  const definition = (id: string) => ({
    id,
    name: `Price watch ${id}`,
    intent: "Tell me when the price goes above 150",
    probe: { params: { url: server.origin, threshold: 150 }, permissions: { net: [server.host] } },
    action: { type: "agent", prompt: "Find out why." },
    policy: { max_fires: 1 },
  });
  // Codex turn ids are unique; prefixing them with the thread keeps them unique here too.
  const meta = (threadId: string, turnId: string, trigger = "user") => ({
    threadId,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: `${threadId}/${turnId}`, turn_trigger: trigger }),
  });

  before(async () => {
    server = await startServer();
    home = tempHome();
    daemon = await startDaemon({ paths: home.paths, codex: () => codex, claude: () => undefined, zcode: () => zcode, notifier });
  });
  after(async () => {
    await daemon.stop();
    home.cleanup();
    await server.close();
  });

  it("answers on the socket and refuses to start twice", async () => {
    const status = await callDaemon<Json>(home.paths.socket, "status");
    assert.equal(status.pid, process.pid);
    assert.equal(status.deno, deno);
    await assert.rejects(startDaemon({ paths: home.paths, codex: () => codex, claude: () => undefined, notifier }), AlreadyRunning);
    await assert.rejects(callDaemon(home.paths.socket, "trigger.get", { triggerId: "nope" }), (error: RemoteError) => error.code === "not_found");
    await assert.rejects(callDaemon(home.paths.socket, "no.such.method"), /unknown method/);
  });

  it("reads the caller from _meta, including turn metadata sent as text", () => {
    assert.deepEqual(callerFrom(meta("t1", "turn-1", "queue")), { via: "mcp", threadId: "t1", turnId: "t1/turn-1", turnTrigger: "queue" });
    assert.deepEqual(callerFrom({ "x-codex-turn-metadata": { thread_id: "t2", turn_id: "x" } }), { via: "mcp", threadId: "t2", turnId: "x" });
    assert.deepEqual(callerFrom(undefined), { via: "mcp" });
  });

  it("creates and activates a trigger through MCP, then delivers its fire", async () => {
    const mcp = new McpClient({ paths: home.paths, ensureDaemon: async () => undefined });
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
    assert.equal(init.result.serverInfo.name, "self-starter");
    assert.match(init.result.instructions, /\[self-starter\]/);
    const tools = await mcp.request("tools/list");
    assert.deepEqual(tools.result.tools.map((tool: Json) => tool.name), TOOLS.map((tool) => tool.name));

    const draft = await mcp.tool("trigger_draft", { definition: definition("watch-a"), code: STATE_PROBE }, meta("thread-a", "turn-1"));
    assert.equal(draft.isError, false, draft.text);
    const draftId = /Draft (draft-watch-a-[0-9a-f]+) saved/.exec(draft.text)?.[1];
    assert.ok(draftId, draft.text);
    assert.match(draft.text, /What it will do:\n-----\nThe trigger "Price watch watch-a" \(watch-a\)/);
    assert.match(draft.text, new RegExp(`Next: call trigger_activate with draft_id "${draftId}"`));

    const activated = await mcp.tool("trigger_activate", { draft_id: draftId }, meta("thread-a", "turn-1"));
    assert.match(activated.text, /^The trigger "watch-a" is active: watching\./);
    assert.equal(mcp.serverRequests.length, 0, "no dialog: Codex decides whether to ask in the chat");

    server.price = 160;
    const fired = await daemon.engine.runNow("watch-a");
    assert.ok(fired?.fireId);
    const queued = await eventually(() => codex.queued.find((q) => q.threadId === "thread-a"));
    assert.match(queued.message, /trigger_report/);

    const report = await mcp.tool("trigger_report", { fire_id: fired.fireId, summary: "It moved on earnings", notify: true }, meta("thread-a", "turn-2", "queue"));
    assert.equal(report.text, "Receipt recorded. The user will get a notification.");
    assert.equal((await eventually(() => notifier.sent.find((n) => n.body === "It moved on earnings")))?.threadId, "thread-a");

    const refused = await mcp.tool("trigger_draft", { definition: definition("watch-x"), code: STATE_PROBE }, meta("thread-a", "turn-2", "queue"));
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Cannot create a trigger now/);

    const list = JSON.parse((await mcp.tool("trigger_list", {}, meta("thread-a", "turn-3"))).text) as Json[];
    assert.equal(list.find((t) => t.id === "watch-a")?.lifecycle, "exhausted");
    await mcp.close();
  });

  it("applies trigger_update right away", async () => {
    const mcp = new McpClient({ paths: home.paths, ensureDaemon: async () => undefined });
    await mcp.request("initialize", { capabilities: {} });
    const draft = await mcp.tool("trigger_draft", { definition: definition("watch-c"), code: STATE_PROBE }, meta("thread-c", "turn-1"));
    const draftId = /Draft (\S+) saved/.exec(draft.text)![1]!;
    await mcp.tool("trigger_activate", { draft_id: draftId }, meta("thread-c", "turn-1"));
    assert.equal(daemon.store.hasTrigger("watch-c"), true);

    const changed = await mcp.tool("trigger_update", { trigger_id: "watch-c", changes: { probe: { params: { threshold: 300 } } } }, meta("thread-c", "turn-2"));
    assert.equal(changed.isError, false, changed.text);
    assert.match(changed.text, /^Changed "watch-c": probe\.params\.threshold: 150 → 300\. It took effect at once/);
    assert.equal(daemon.store.loadTrigger("watch-c").definition.probe.params.threshold, 300);
    await mcp.close();
  });

  it("requires ZCode's own session metadata instead of accepting another host's thread id", async () => {
    assert.deepEqual(callerFrom({ session_id: "sess_origin", turn_id: "turn-1", workspace_path: home.paths.home }, "zcode"), {
      via: "mcp", threadId: "zc:sess_origin", turnId: "turn-1", cwd: home.paths.home,
    });
    const mcp = new McpClient({ paths: home.paths, host: "zcode", ensureDaemon: async () => undefined });
    try {
      const init = await mcp.request("initialize", { capabilities: {} });
      assert.match(init.result.instructions, /what ZCode should do/);
      const result = await mcp.tool("trigger_draft", { definition: definition("missing-session"), code: STATE_PROBE }, meta("codex-thread", "turn-1"));
      assert.equal(result.isError, true);
      assert.match(result.text, /ZCode did not supply session_id/);
      assert.equal(daemon.store.hasTrigger("missing-session"), false);
    } finally {
      await mcp.close();
    }
  });

  it("passes ZCode context through the socket and keeps a background turn locked after its receipt", async () => {
    server.price = 100;
    const metadata = { session_id: "sess_origin", turn_id: "user-turn", workspace_path: home.paths.home };
    const user = new McpClient({ paths: home.paths, host: "zcode", ensureDaemon: async () => undefined });
    const background = new McpClient({ paths: home.paths, host: "zcode", triggerTurn: true, ensureDaemon: async () => undefined });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    zcode.during = async (options) => { if (options.sessionId) await gate; };
    try {
      const draft = await user.tool("trigger_draft", { definition: definition("zcode-watch"), code: STATE_PROBE }, metadata);
      assert.equal(draft.isError, false, draft.text);
      const draftId = /Draft (\S+) saved/.exec(draft.text)![1]!;
      const activated = await user.tool("trigger_activate", { draft_id: draftId }, metadata);
      assert.equal(activated.isError, false, activated.text);
      const target = await eventually(() => daemon.store.loadTrigger("zcode-watch").definition.target.thread_id);
      assert.ok(target);
      assert.match(target, /^zc:sess_/);
      assert.equal(daemon.store.loadTrigger("zcode-watch").definition.target.cwd, home.paths.home);
      server.price = 200;
      const fire = await daemon.engine.runNow("zcode-watch");
      assert.ok(fire?.fireId);
      await eventually(() => zcode.runs.find((run) => run.sessionId === target.slice(3)));
      const firing = { session_id: target.slice(3), turn_id: "event-turn", workspace_path: home.paths.home };
      const report = await background.tool("trigger_report", { fire_id: fire.fireId, summary: "ZCode investigated the event", notify: true }, firing);
      assert.equal(report.isError, false, report.text);
      assert.equal(daemon.fires.get(fire.fireId)?.receipt?.source, "tool");
      const mutation = await background.tool("trigger_pause", { trigger_id: "zcode-watch" }, { ...firing, turn_id: "after-compaction" });
      assert.equal(mutation.isError, true);
      assert.match(mutation.text, /this turn was started by Self-Starter/);
      finish();
      await eventually(() => daemon.executor.status().activeAgentRuns === 0);
      const paused = await user.tool("trigger_pause", { trigger_id: "zcode-watch" }, { ...metadata, turn_id: "next-user-turn" });
      assert.equal(paused.isError, false, paused.text);
    } finally {
      finish();
      zcode.during = undefined;
      await Promise.all([user.close(), background.close()]);
    }
  });
});
