#!/usr/bin/env node
// Self-test for the trigger-spike MCP server, without Codex.
// Spawns the server, plays the client side of the protocol, and auto-accepts
// the elicitation request. Usage: node spike/scripts/mcp-selftest.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "marketplace", "plugins", "trigger-spike", "mcp", "server.mjs");
const spikeDir = mkdtempSync(join(tmpdir(), "trigger-spike-selftest-"));

const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, CODEX_TRIGGERS_SPIKE_DIR: spikeDir, CODEX_THREAD_ID: "selftest-thread" },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const waiting = new Map();

function send(message) {
  server.stdin.write(JSON.stringify(message) + "\n");
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "elicitation/create") {
    // Play the user: accept the confirmation dialog.
    send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { approve: true } } });
    return;
  }
  const resolve = waiting.get(message.id);
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});

function check(condition, label) {
  if (!condition) {
    console.error(`FAIL ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}

function toolText(message) {
  return message.result?.content?.[0]?.text ?? "";
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "selftest", version: "0" },
    capabilities: { elicitation: {} },
  });
  check(init.result?.serverInfo?.name === "trigger-spike-absolute-node", "initialize");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request("tools/list", {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  check(names.join(",") === "spike_confirm,spike_record_thread,spike_whoami", "tools/list");

  const whoami = await request("tools/call", {
    name: "spike_whoami",
    arguments: {},
    _meta: { "selftest/thread": "t-1" },
  });
  const report = JSON.parse(toolText(whoami));
  check(report.codexEnv.CODEX_THREAD_ID === "selftest-thread", "whoami reports CODEX_THREAD_ID");
  check(report.callMeta?.["selftest/thread"] === "t-1", "whoami echoes _meta");

  const recorded = await request("tools/call", {
    name: "spike_record_thread",
    arguments: { thread_id: "019a-test" },
  });
  check(!recorded.result?.isError, "record_thread");
  check(readFileSync(join(spikeDir, "last_thread_id"), "utf8").trim() === "019a-test", "last_thread_id file");

  const confirm = await request("tools/call", { name: "spike_confirm", arguments: {} });
  const confirmed = JSON.parse(toolText(confirm));
  check(confirmed.elicitationResponse?.result?.action === "accept", "elicitation round trip");

  const log = readFileSync(join(spikeDir, "mcp.log.jsonl"), "utf8").trim().split("\n");
  check(log.some((line) => JSON.parse(line).kind === "elicitation_result"), "log written");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  server.stdin.end();
}
