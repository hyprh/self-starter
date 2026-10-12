#!/usr/bin/env node
// trigger-spike MCP server: a zero-dependency stdio MCP server used only to
// verify how the Codex app hosts plugin MCP servers (see spike/README.md).
// Everything it observes is appended to ~/.codex-triggers-spike/mcp.log.jsonl.
//
// The plugin registers this file twice (see 01-install.sh):
//   variant "absolute-node": launched with an absolute path to node; exposes the spike tools.
//   variant "path-node":     launched as bare `node`, to learn whether the app's PATH finds it;
//                            exposes only spike_path_check.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SPIKE_DIR =
  process.env.CODEX_TRIGGERS_SPIKE_DIR || join(homedir(), ".codex-triggers-spike");
const LOG_FILE = join(SPIKE_DIR, "mcp.log.jsonl");
const VARIANT = process.env.TRIGGER_SPIKE_VARIANT || "absolute-node";
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

mkdirSync(SPIKE_DIR, { recursive: true });

function log(kind, data = {}) {
  const entry = { ts: new Date().toISOString(), pid: process.pid, variant: VARIANT, kind, ...data };
  appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// Only CODEX_* variables are recorded; anything that looks like a secret is masked.
function codexEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("CODEX_")) continue;
    env[key] = /TOKEN|KEY|SECRET|AUTH/.test(key) ? "<redacted>" : value;
  }
  return env;
}

const session = {
  startedAt: new Date().toISOString(),
  protocolVersion: null,
  clientInfo: null,
  clientCapabilities: null,
};

log("start", {
  startedAt: session.startedAt,
  cwd: process.cwd(),
  ppid: process.ppid,
  argv: process.argv,
  node: process.version,
  nodePath: process.execPath,
  pathEnv: process.env.PATH,
  codexEnv: codexEnv(),
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Server-to-client requests (elicitation) and their pending responses.
let nextRequestId = 1;
const pending = new Map();

function requestClient(method, params, timeoutMs) {
  const id = `trigger-spike-${nextRequestId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ timedOut: true });
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

const TOOLS = [
  {
    name: "spike_whoami",
    description:
      "Report how this MCP server was launched (cwd, CODEX_* env, client info and capabilities) " +
      "and the _meta that Codex attached to this call. Read-only.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "Optional free-form note." } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "spike_record_thread",
    description:
      "Record the current Codex thread id. Pass the value of the CODEX_THREAD_ID environment " +
      "variable exactly as printed by `echo $CODEX_THREAD_ID`.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Value of $CODEX_THREAD_ID." },
        note: { type: "string", description: "Optional free-form note." },
      },
      required: ["thread_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "spike_confirm",
    description:
      "Ask the user to confirm a fake trigger through an MCP elicitation dialog and report " +
      "what the user chose. Used to check whether Codex shows elicitation forms.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const PATH_VARIANT_TOOLS = [
  {
    name: "spike_path_check",
    description:
      "Confirms that the copy of this server launched as bare `node` (found via PATH) is running.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function callTool(name, args, meta) {
  switch (name) {
    case "spike_path_check":
      return textResult({ variant: VARIANT, node: process.execPath, pathEnv: process.env.PATH });

    case "spike_whoami":
      return textResult({
        server: { pid: process.pid, startedAt: session.startedAt, cwd: process.cwd() },
        codexEnv: codexEnv(),
        protocolVersion: session.protocolVersion,
        clientInfo: session.clientInfo,
        clientCapabilities: session.clientCapabilities,
        callMeta: meta ?? null,
        note: args.note ?? null,
      });

    case "spike_record_thread": {
      const threadId = String(args.thread_id || "").trim();
      if (!threadId) return textResult("thread_id is empty", true);
      writeFileSync(join(SPIKE_DIR, "last_thread_id"), threadId + "\n");
      log("thread_recorded", { threadId, note: args.note ?? null, callMeta: meta ?? null });
      return textResult(`Recorded thread id ${threadId}`);
    }

    case "spike_confirm": {
      if (!session.clientCapabilities?.elicitation) {
        log("elicitation_unsupported", { clientCapabilities: session.clientCapabilities });
        return textResult(
          "The client did not declare the elicitation capability during initialize.",
          true,
        );
      }
      const response = await requestClient(
        "elicitation/create",
        {
          message:
            "[codex-triggers spike] This is a test confirmation. Nothing will be created.\n" +
            "Test trigger: check example.com every 5 minutes and alert you when the status is not 200.",
          requestedSchema: {
            type: "object",
            properties: {
              approve: {
                type: "boolean",
                title: "Allow",
                description: "Whether to allow creating this test trigger",
              },
            },
            required: ["approve"],
          },
        },
        ELICITATION_TIMEOUT_MS,
      );
      log("elicitation_result", { response });
      return textResult({ elicitationResponse: response });
    }

    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      session.protocolVersion = params.protocolVersion ?? null;
      session.clientInfo = params.clientInfo ?? null;
      session.clientCapabilities = params.capabilities ?? {};
      log("initialize", {
        protocolVersion: session.protocolVersion,
        clientInfo: session.clientInfo,
        clientCapabilities: session.clientCapabilities,
      });
      reply(id, {
        protocolVersion: session.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `trigger-spike-${VARIANT}`, version: "0.1.0" },
        instructions:
          "Diagnostic server for the codex-triggers spike. Only use its tools when the " +
          "trigger-spike skill asks for them.",
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: VARIANT === "path-node" ? PATH_VARIANT_TOOLS : TOOLS });
      return;
    // Codex lists resources even when the server declares none.
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "resources/templates/list":
      reply(id, { resourceTemplates: [] });
      return;
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      const meta = params._meta ?? null;
      log("tools_call", { name, arguments: args, callMeta: meta });
      reply(id, await callTool(name, args, meta));
      return;
    }
    default:
      log("unhandled_request", { method });
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });

lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log("parse_error", { line: line.slice(0, 500) });
    return;
  }

  const isResponse = message.id !== undefined && message.method === undefined;
  if (isResponse) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
    return;
  }

  if (message.id === undefined) {
    log("notification", { method: message.method });
    return;
  }

  try {
    await handleRequest(message);
  } catch (error) {
    log("error", { method: message.method, error: String(error?.stack || error) });
    replyError(message.id, -32603, String(error?.message || error));
  }
});

lines.on("close", () => {
  log("exit", { reason: "stdin closed" });
  process.exit(0);
});
