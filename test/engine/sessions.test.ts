import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolvePaths, type Paths } from "../../src/engine/paths.js";
import {
  ClaudeCli,
  currentSession,
  deliverToOpenSession,
  findClaude,
  inboxKey,
  lastWritten,
  processesShowing,
  readSession,
  relaySocket,
  startRelay,
  triggerTurn,
} from "../../src/engine/sessions.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";

const HOOK = join(PACKAGE_ROOT, "cc-plugin", "bin", "session-hook.mjs");
const APPROVE = join(PACKAGE_ROOT, "cc-plugin", "bin", "approve.mjs");

let scratch: string;
let paths: Paths;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ss-sessions-"));
  paths = resolvePaths(join(scratch, "home"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs one of the plugin's hooks as Claude Code does: the event on stdin, the session's variables in the environment. */
function hook(input: Record<string, unknown>, env: Record<string, string> = {}, script = HOOK): string {
  const out = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: scratch, SELF_STARTER_HOME: paths.home, ...env },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

const inbox = "/tmp/cc-socks/4242.sock";
const processEnv = { CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: "token-1", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "4242" };
const start = (sessionId: string, extra: Record<string, unknown> = {}, env: Record<string, string> = processEnv) =>
  hook({ session_id: sessionId, hook_event_name: "SessionStart", source: "startup", cwd: "/work", transcript_path: `/t/${sessionId}.jsonl`, ...extra }, env);
const prompt = (sessionId: string, text: string) => hook({ session_id: sessionId, hook_event_name: "UserPromptSubmit", cwd: "/work", prompt: text }, processEnv);
const end = (sessionId: string, reason: string, env: Record<string, string> = processEnv) => hook({ session_id: sessionId, hook_event_name: "SessionEnd", cwd: "/work", reason }, env);
const event = (sessionId: string, name: string, extra: Record<string, unknown> = {}) => hook({ session_id: sessionId, hook_event_name: name, cwd: "/work", ...extra }, processEnv);
const running = (sessionId: string) => readSession(paths, sessionId)?.turn?.running;

describe("the plugin's session hook", () => {
  it("records each session and the session each process shows, the way the engine reads them, and prints nothing", () => {
    assert.equal(start("s1", {}, { ...processEnv, CLAUDE_CONFIG_DIR: "/cfg" }), "");
    assert.deepEqual(
      { ...readSession(paths, "s1"), startedAt: "" },
      { sessionId: "s1", cwd: "/work", transcript: "/t/s1.jsonl", configDir: "/cfg", startedAt: "" },
    );
    assert.equal(currentSession(paths, inbox), "s1");
    assert.deepEqual(
      processesShowing(paths, "s1").map(({ key, inbox: path, token, attended }) => ({ key, path, token, attended })),
      [{ key: inboxKey(inbox), path: inbox, token: "token-1", attended: true }],
    );
    // The engine and the hook name a process's files the same way.
    assert.deepEqual(readdirSync(paths.inboxes), [`${inboxKey(inbox)}.json`]);
  });

  it("follows /clear: the old session ends, the process shows the new one", () => {
    start("s1");
    end("s1", "clear");
    assert.ok(readSession(paths, "s1")?.endedAt);
    assert.equal(currentSession(paths, inbox), undefined);
    start("s2", { source: "clear" });
    assert.equal(currentSession(paths, inbox), "s2");
    assert.deepEqual(processesShowing(paths, "s1"), []);
    // A late SessionEnd of the old session does not remove the process's new session.
    end("s1", "other");
    assert.equal(currentSession(paths, inbox), "s2");
  });

  it("forgets a process when it exits, though its inbox is closed by then", () => {
    start("s1");
    start("s9", {}, { ...processEnv, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/77.sock", CLAUDE_PID: "77" });
    // At exit, Claude Code has closed the inbox and no longer passes it on.
    end("s1", "prompt_input_exit", { CLAUDE_PID: "4242" });
    assert.equal(currentSession(paths, inbox), undefined);
    assert.equal(currentSession(paths, "/tmp/cc-socks/77.sock"), "s9", "other processes stay");
    assert.ok(readSession(paths, "s1")?.endedAt);
  });

  it("records whether a turn is running, whichever way it ends", () => {
    start("s1");
    assert.equal(running("s1"), undefined);
    for (const ending of ["Stop", "StopFailure"]) {
      prompt("s1", "do something");
      assert.equal(running("s1"), true, ending);
      event("s1", ending);
      assert.equal(running("s1"), false, ending);
    }
    prompt("s1", "one more");
    end("s1", "prompt_input_exit", { CLAUDE_PID: "4242" });
    assert.equal(running("s1"), false, "a session that ended runs no turn");
  });

  it("tells when Claude Code last wrote to the session: its transcript, or a subagent's beside it", () => {
    const transcript = join(scratch, "projects", "s1.jsonl");
    const subagent = join(scratch, "projects", "s1", "subagents", "workflows", "w1", "agent-b2.jsonl");
    mkdirSync(dirname(subagent), { recursive: true });
    writeFileSync(transcript, "{}\n");
    writeFileSync(subagent, "{}\n");
    utimesSync(transcript, 1000, 1000);
    utimesSync(subagent, 5000, 5000);
    const session = { sessionId: "s1", cwd: scratch, startedAt: "", transcript };
    assert.equal(lastWritten(session), 5_000_000);
    rmSync(join(scratch, "projects", "s1"), { recursive: true });
    assert.equal(lastWritten(session), 1_000_000);
    assert.equal(lastWritten({ ...session, transcript: join(scratch, "cleaned-up.jsonl") }), 0);
    assert.equal(lastWritten({ sessionId: "s1", cwd: scratch, startedAt: "" }), 0);
  });

  it("records whether a Self-Starter message started the current turn, through compaction", () => {
    start("s1");
    prompt("s1", "[self-starter] Flag (flag-a · fire #2 · fire_k3x9a1b2c3d4)\n\nTask: ...");
    assert.deepEqual(triggerTurn(paths, "s1"), { fireId: "fire_k3x9a1b2c3d4" });
    start("s1", { source: "compact" });
    assert.deepEqual(triggerTurn(paths, "s1"), { fireId: "fire_k3x9a1b2c3d4" }, "compaction keeps the turn");
    prompt("s1", "thanks, now watch the deploy too");
    assert.equal(triggerTurn(paths, "s1"), undefined);
    prompt("s1", '[self-starter] This session belongs to the trigger "Flag" (flag-a).');
    assert.deepEqual(triggerTurn(paths, "s1"), {}, "a trigger's first message carries no fire");
    // Only the first line of a fire is kept, never what the user types.
    prompt("s1", "my password is hunter2");
    assert.doesNotMatch(readFileSync(join(paths.sessions, "s1.json"), "utf8"), /hunter2|Task:/);
  });

  it("lets the plugin's reporting and read-only tools run without asking", () => {
    const decision = JSON.parse(hook({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "mcp__plugin_self-starter_self_starter__trigger_report" }, {}, APPROVE));
    assert.deepEqual(decision.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  });

  it("leaves headless runs out unless asked, and ignores what it cannot use", () => {
    start("s1", {}, { ...processEnv, CLAUDE_CODE_SESSION_ATTENDED: "0" });
    assert.deepEqual(processesShowing(paths, "s1"), []);
    assert.equal(processesShowing(paths, "s1", { headless: true }).length, 1);
    for (const input of ["not json", JSON.stringify({ session_id: "../escape", hook_event_name: "SessionStart" })]) {
      const out = spawnSync(process.execPath, [HOOK], { input, env: { PATH: process.env.PATH, SELF_STARTER_HOME: paths.home }, encoding: "utf8" });
      assert.equal(out.status, 0);
      assert.equal(out.stdout, "");
    }
    assert.equal(existsSync(join(paths.home, "escape.json")), false);
  });
});

/** A stand-in for a Claude Code process's inbox socket: keeps the lines of each connection. */
async function fakeInbox(path: string): Promise<{ messages: string[][]; server: Server }> {
  const messages: string[][] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => {
      messages.push(text.trim().split("\n"));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { messages, server };
}

describe("delivery into an open session", () => {
  it("goes through the plugin's relay, else straight into the inbox, and forgets processes that are gone", async () => {
    const path = join(scratch, "inbox.sock");
    const { messages, server } = await fakeInbox(path);
    start("s1", {}, { ...processEnv, CLAUDE_CODE_MESSAGING_SOCKET: path });
    const relay = await startRelay(paths, path, "token-1");
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });

    assert.equal(await deliverToOpenSession(paths, "s1", "first fire", log), "relayed");
    assert.deepEqual(messages[0], [JSON.stringify({ type: "auth", token: "token-1" }), userLine("first fire")]);
    assert.equal(await deliverToOpenSession(paths, "s2", "elsewhere", log), undefined, "no process shows s2");

    relay.close();
    assert.equal(existsSync(relaySocket(paths, inboxKey(path))), false);
    assert.equal(await deliverToOpenSession(paths, "s1", "second fire", log), "posted");
    assert.deepEqual(messages[1], [JSON.stringify({ type: "auth", token: "token-1" }), userLine("second fire")]);
    assert.match(logs.join("\n"), /could not relay into session s1/);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await deliverToOpenSession(paths, "s1", "third fire", log), undefined);
    assert.deepEqual(readdirSync(paths.inboxes), [], "the record of the gone process was removed");
  });
});

describe("headless turns", () => {
  /** A claude that records how it was run and answers like `claude -p --output-format json`. */
  function fakeClaude(script: string): string {
    const bin = join(scratch, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_SESSION_ID:-none} \${CLAUDE_CODE_USE_BEDROCK:-none}" "$@" > "${scratch}/args"\ncat > "${scratch}/stdin"\n${script}\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }
  const recorded = () => readFileSync(join(scratch, "args"), "utf8").trim().split("\n");

  it("resumes a session in its folder with the trigger's permission mode, and starts new ones", async () => {
    const claude = new ClaudeCli(fakeClaude(`echo '{"type":"result","is_error":false,"result":"Checked: all good","session_id":"s1"}'`));
    const saved = { session: process.env.CLAUDE_CODE_SESSION_ID, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK };
    process.env.CLAUDE_CODE_SESSION_ID = "the-session-that-started-the-daemon";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      const resumed = await claude.run({ sessionId: "s1", cwd: scratch, message: "[self-starter] fire", sandbox: "read-only", configDir: "/cfg", timeoutMs: 10_000 });
      assert.deepEqual(resumed, { ok: true, lastMessage: "Checked: all good" });
    } finally {
      for (const [name, value] of [["CLAUDE_CODE_SESSION_ID", saved.session], ["CLAUDE_CODE_USE_BEDROCK", saved.bedrock]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.deepEqual(recorded(), [
      realpathSync(scratch), // as the shell sees it (the temporary folder of macOS is behind a symlink)
      "/cfg",
      "none 1", // nothing of the session the daemon may have been started from, but the user's settings
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "mcp__plugin_self-starter_self_starter",
      "--resume",
      "s1",
    ]);
    assert.equal(readFileSync(join(scratch, "stdin"), "utf8"), "[self-starter] fire");

    await claude.run({ sessionId: "new-id", start: { name: "Trigger: Flag" }, cwd: scratch, message: "seed", sandbox: "workspace-write", timeoutMs: 10_000 });
    assert.deepEqual(recorded().slice(7), ["acceptEdits", "--allowedTools", "mcp__plugin_self-starter_self_starter", "--session-id", "new-id", "--name", "Trigger: Flag"]);
  });

  it("reports why a run failed", async () => {
    const gone = new ClaudeCli(fakeClaude(`echo "No conversation found with session ID: s9" >&2; exit 1`));
    assert.deepEqual(await gone.run({ sessionId: "s9", cwd: scratch, message: "x", sandbox: "workspace-write", timeoutMs: 10_000 }), {
      ok: false,
      error: "claude -p: No conversation found with session ID: s9",
    });
    const slow = new ClaudeCli(fakeClaude("exec sleep 5"));
    const result = await slow.run({ sessionId: "s1", cwd: scratch, message: "x", sandbox: "workspace-write", timeoutMs: 200 });
    assert.deepEqual(result, { ok: false, error: "claude -p: timed out after 0s" });
  });

  it("runs a claude installed with npm, a node script, with this node", async () => {
    const script = join(scratch, "claude-code", "cli.js");
    mkdirSync(join(scratch, "claude-code"));
    writeFileSync(
      script,
      `#!/usr/bin/env node\nprocess.stdin.resume().on("end", () => console.log(JSON.stringify({ is_error: false, result: process.execPath })));\n`,
      { mode: 0o755 },
    );
    const bin = join(scratch, "claude");
    symlinkSync(script, bin);
    const saved = process.env.PATH;
    process.env.PATH = join(scratch, "nothing"); // a service whose PATH has no node
    try {
      const result = await new ClaudeCli(bin).run({ sessionId: "s1", cwd: scratch, message: "x", sandbox: "read-only", timeoutMs: 10_000 });
      assert.deepEqual(result, { ok: true, lastMessage: process.execPath });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("finds claude through CLAUDE_BIN first", () => {
    const bin = fakeClaude("true");
    const saved = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    try {
      assert.equal(findClaude(), bin);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = saved;
    }
  });
});
