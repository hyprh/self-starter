#!/usr/bin/env node
// Prints the parts of mcp.log.jsonl that answer H2, H3, H4 and H8.
// Usage: node summarize-log.mjs <path to mcp.log.jsonl>

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log("(no MCP log found: the plugin's MCP server never started)");
  process.exit(0);
}

const home = homedir();
const tidy = (value) => JSON.stringify(value ?? null).split(home).join("~");

// Keeps the identity fields of a tools/call _meta and lists the other keys,
// leaving out workspace details such as git remotes.
function metaSummary(meta) {
  if (!meta) return "null";
  const turn = meta["x-codex-turn-metadata"] ?? {};
  return tidy({
    threadId: meta.threadId,
    sessionId: meta.sessionId,
    plugin_id: meta.plugin_id,
    turn: {
      thread_id: turn.thread_id,
      turn_id: turn.turn_id,
      turn_trigger: turn.turn_trigger,
      thread_source: turn.thread_source,
    },
    keys: Object.keys(meta),
  });
}

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  const head = `${e.ts} [${e.variant}] ${e.kind}`;
  switch (e.kind) {
    case "start":
      console.log(`${head} cwd=${tidy(e.cwd)} node=${tidy(e.nodePath)} codexEnv=${tidy(e.codexEnv)}`);
      console.log(`    PATH=${tidy(e.pathEnv)}`);
      break;
    case "initialize":
      console.log(`${head} protocol=${e.protocolVersion} client=${tidy(e.clientInfo)}`);
      console.log(`    capabilities=${tidy(e.clientCapabilities)}`);
      break;
    case "tools_call":
      console.log(`${head} ${e.name} callMeta=${metaSummary(e.callMeta)}`);
      break;
    case "thread_recorded":
      console.log(`${head} threadId=${e.threadId}`);
      break;
    case "elicitation_result":
    case "elicitation_unsupported":
    case "error":
    case "unhandled_request":
      console.log(`${head} ${tidy(e.response ?? e.error ?? e.method ?? e.clientCapabilities)}`);
      break;
    default:
      break;
  }
}
