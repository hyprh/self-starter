// Antigravity PreToolUse policy guard for Self-Starter.
//
// 1. In interactive sessions (SELF_STARTER_TRIGGER_TURN !== "1"):
//    - Auto-approves Self-Starter's safe reporting and read-only MCP tools.
//    - Defers all other matched tools ("decision": "ask") to Antigravity's own
//      permission prompt and user "Always Allow" cache.
// 2. In background trigger turns (SELF_STARTER_TRIGGER_TURN === "1"):
//    - Blocks mutating Self-Starter MCP tools (draft/activate/update/pause/resume/delete).
//    - Enforces SELF_STARTER_SANDBOX ("read-only", "workspace-write", "danger-full-access")
//      even when headless `agy --print` runs with `--dangerously-skip-permissions`.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const SAFE_SELF_STARTER_TOOLS = new Set([
  "trigger_recipes",
  "trigger_tune",
  "trigger_list",
  "trigger_get",
  "trigger_test",
  "trigger_history",
  "trigger_report",
  "service_status",
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "delete_file",
]);

const PROTECTED_DIRS = new Set([".git", ".agents", ".agent", "_agents", "_agent", ".gemini"]);

function reply(decision, reason) {
  process.stdout.write(`${JSON.stringify(reason ? { decision, reason } : { decision })}\n`);
}

function isSelfStarterServer(name) {
  return typeof name === "string" && /(?:^|_)self_starter$/.test(name);
}

/** Resolves symlinks on the deepest existing ancestor so symlinks inside the workspace cannot escape it. */
function canonicalPath(candidate) {
  const missing = [];
  let cursor = resolve(candidate);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return missing.length > 0 ? join(base, ...missing) : base;
}

function isAllowedWorkspacePath(workspace, target) {
  if (typeof workspace !== "string" || !workspace.trim() || typeof target !== "string" || !target.trim()) return false;
  const root = canonicalPath(workspace);
  const resolved = canonicalPath(resolve(workspace, target));
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 && !segments.some((segment) => PROTECTED_DIRS.has(segment));
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8")) ?? {};
} catch {
  // Invalid hook input fails closed in background trigger turns and asks interactively.
}

const toolCall = payload && typeof payload === "object" && payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : {};
const toolName = typeof toolCall.name === "string" ? toolCall.name : "";
const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};

const isMcp = toolName === "call_mcp_tool";
const isOurServer = isMcp && isSelfStarterServer(args.ServerName);
const isSafeSelfStarterTool = isOurServer && typeof args.ToolName === "string" && SAFE_SELF_STARTER_TOOLS.has(args.ToolName);

if (process.env.SELF_STARTER_TRIGGER_TURN !== "1") {
  if (isSafeSelfStarterTool) reply("allow", "Self-Starter's reporting and read-only tools");
  else reply("ask");
  process.exit(0);
}

if (isOurServer) {
  if (isSafeSelfStarterTool) reply("allow", "Self-Starter's reporting and read-only tools");
  else reply("deny", "Triggers cannot be created, changed, paused or deleted while handling a trigger fire.");
  process.exit(0);
}

const sandbox = process.env.SELF_STARTER_SANDBOX || "workspace-write";
if (sandbox === "danger-full-access") {
  reply("allow", "Authorized by trigger sandbox: danger-full-access");
} else if (sandbox === "read-only") {
  reply("deny", "Blocked by Self-Starter read-only trigger policy.");
} else if (sandbox === "workspace-write") {
  const fileTarget = args.Path ?? args.TargetFile ?? args.path ?? args.target_file;
  if (WRITE_TOOLS.has(toolName) && isAllowedWorkspacePath(process.env.SELF_STARTER_WORKSPACE, fileTarget)) {
    reply("allow", "Workspace file edit permitted by workspace-write trigger policy.");
  } else if (WRITE_TOOLS.has(toolName)) {
    reply("deny", "Writes outside the trigger workspace or to protected VCS/agent directories are blocked in workspace-write mode.");
  } else {
    reply("deny", "Shell commands and external MCP tools are not approved automatically in workspace-write background turns.");
  }
} else {
  reply("deny", `Unknown Self-Starter sandbox policy: ${sandbox}`);
}
