import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { callDaemon, RemoteError } from "../../src/client/client.js";
import { AlreadyRunning, startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import { bundledDeno } from "../../src/engine/config.js";
import { callerFrom, runMcpServer, TOOLS } from "../../src/mcp/server.js";
import { eventually, FakeCodex, RecordingNotifier, STATE_PROBE, startServer, tempHome, type TestServer } from "../engine/fixtures.js";

const deno = bundledDeno();

type Json = Record<string, any>;

/** Talks to runMcpServer over in-memory streams, the way Codex does over stdio. */
class McpClient {
  private readonly toServer = new PassThrough();
  private readonly fromServer = new PassThrough();
  private readonly waiting = new Map<number, (message: Json) => void>();
  private nextId = 1;
  /** Answers server-to-client requests such as elicitation/create. */
  onRequest: (message: Json) => Promise<Json> | Json = () => ({ error: { code: -32601, message: "not handled" } });
  readonly elicitations: Json[] = [];
  readonly done: Promise<void>;

  constructor(options: Parameters<typeof runMcpServer>[0]) {
    this.done = runMcpServer({ ...options, input: this.toServer, output: this.fromServer });
    createInterface({ input: this.fromServer }).on("line", (line) => {
      const message = JSON.parse(line) as Json;
      if (message.method) {
        if (message.method === "elicitation/create") this.elicitations.push(message.params);
        void Promise.resolve(this.onRequest(message)).then((answer) => this.send({ jsonrpc: "2.0", id: message.id, ...answer }));
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
    daemon = await startDaemon({ paths: home.paths, codex: () => codex, notifier });
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
    await assert.rejects(startDaemon({ paths: home.paths, codex: () => codex, notifier }), AlreadyRunning);
    await assert.rejects(callDaemon(home.paths.socket, "trigger.get", { triggerId: "nope" }), (error: RemoteError) => error.code === "not_found");
    await assert.rejects(callDaemon(home.paths.socket, "no.such.method"), /unknown method/);
  });

  it("reads the caller from _meta, including turn metadata sent as text", () => {
    assert.deepEqual(callerFrom(meta("t1", "turn-1", "queue")), { via: "mcp", threadId: "t1", turnId: "t1/turn-1", turnTrigger: "queue" });
    assert.deepEqual(callerFrom({ "x-codex-turn-metadata": { thread_id: "t2", turn_id: "x" } }), { via: "mcp", threadId: "t2", turnId: "x" });
    assert.deepEqual(callerFrom(undefined), { via: "mcp" });
  });

  it("creates and approves a trigger through MCP elicitation, then delivers its fire", async () => {
    const mcp = new McpClient({ paths: home.paths, ensureDaemon: async () => undefined, dialog: async () => "unavailable" });
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "test" } });
    assert.equal(init.result.serverInfo.name, "codex-triggers");
    assert.match(init.result.instructions, /\[codex-triggers\]/);
    const tools = await mcp.request("tools/list");
    assert.deepEqual(tools.result.tools.map((tool: Json) => tool.name), TOOLS.map((tool) => tool.name));

    const draft = await mcp.tool("trigger_draft", { definition: definition("watch-a"), code: STATE_PROBE }, meta("thread-a", "turn-1"));
    assert.equal(draft.isError, false, draft.text);
    const draftId = /Draft (draft-watch-a-[0-9a-f]+) saved/.exec(draft.text)?.[1];
    assert.ok(draftId, draft.text);
    assert.match(draft.text, /Next: tell the user/);

    mcp.onRequest = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 1600)); // a person takes a moment
      return { result: { action: "accept", content: { approve: message.params.requestedSchema.properties.approve ? true : false } } };
    };
    const activated = await mcp.tool("trigger_activate", { draft_id: draftId }, meta("thread-a", "turn-1"));
    assert.match(activated.text, /The user approved it \(elicitation\)/);
    assert.match(mcp.elicitations[0]!.message, /^Create the trigger "Price watch watch-a" \(watch-a\)\?/);

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

  it("falls back to a native dialog when Codex declines the elicitation by itself", async () => {
    let dialogs = 0;
    const mcp = new McpClient({
      paths: home.paths,
      ensureDaemon: async () => undefined,
      dialog: async () => {
        dialogs += 1;
        return "approved";
      },
    });
    await mcp.request("initialize", { capabilities: { elicitation: {} } });
    mcp.onRequest = () => ({ result: { action: "decline" } });
    const draft = await mcp.tool("trigger_draft", { definition: definition("watch-b"), code: STATE_PROBE }, meta("thread-b", "turn-1"));
    const draftId = /Draft (\S+) saved/.exec(draft.text)![1]!;
    const activated = await mcp.tool("trigger_activate", { draft_id: draftId }, meta("thread-b", "turn-1"));
    assert.match(activated.text, /The user approved it \(dialog\)/);
    assert.equal(dialogs, 1);
    await mcp.close();
  });

  it("tells the agent to ask for terminal approval when no dialog can be shown", async () => {
    const mcp = new McpClient({ paths: home.paths, ensureDaemon: async () => undefined, dialog: async () => "unavailable" });
    await mcp.request("initialize", { capabilities: {} });
    const draft = await mcp.tool("trigger_draft", { definition: definition("watch-c"), code: STATE_PROBE }, meta("thread-c", "turn-1"));
    const draftId = /Draft (\S+) saved/.exec(draft.text)![1]!;
    const result = await mcp.tool("trigger_activate", { draft_id: draftId }, meta("thread-c", "turn-1"));
    assert.match(result.text, new RegExp(`ctrig approve ${draftId}`));
    assert.equal(daemon.store.hasTrigger("watch-c"), false);

    // What `ctrig approve` does after the user says yes in the terminal.
    await callDaemon(home.paths.socket, "draft.activate", { draftId }, { via: "cli" });
    assert.equal(daemon.store.hasTrigger("watch-c"), true);

    const declined = await mcp.tool("trigger_update", { trigger_id: "watch-c", changes: { probe: { params: { threshold: 300 } } } }, meta("thread-c", "turn-2"));
    assert.match(declined.text, /ctrig approve draft-watch-c-/);
    await mcp.close();
  });
});
