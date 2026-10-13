// Claude Code runs this at SessionStart, UserPromptSubmit, Stop, StopFailure,
// Notification (idle_prompt) and SessionEnd. It records which session each
// running Claude Code process shows, where each session works, and whether a
// turn is running there, so that Self-Starter can bring a fire to the session
// where the trigger was made: into it once its turn is over while a process
// shows it, headless with `claude -p --resume` once none does. It also records
// whether a fire started the current turn, which then cannot change triggers.
// It only writes small files under ~/.self-starter, prints nothing (the output
// of some hooks reaches the model) and never fails the hook.
//
//   sessions/<session id>.json  the session's folder, transcript and config dir; its turn:
//                               {at, running, trigger, line}; endedAt once it ended
//   inboxes/<key>.json          per process: the session it shows now, its inbox socket and token, its pid
//
// <key> is the first 16 hex digits of the SHA-256 of the inbox socket's path;
// src/engine/sessions.ts reads these files and must agree.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const sessionId = input.session_id;
  if (typeof sessionId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(sessionId)) {
    const home = resolve(process.env.SELF_STARTER_HOME || join(homedir(), ".self-starter"));
    const now = new Date().toISOString();
    const sessionFile = join(home, "sessions", `${sessionId}.json`);
    const inboxes = join(home, "inboxes");
    const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    const inboxFile = inbox && join(inboxes, `${createHash("sha256").update(inbox).digest("hex").slice(0, 16)}.json`);

    switch (input.hook_event_name) {
      case "SessionStart": {
        const session = { sessionId, cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), startedAt: now };
        if (typeof input.transcript_path === "string") session.transcript = input.transcript_path;
        if (process.env.CLAUDE_CONFIG_DIR) session.configDir = resolve(process.env.CLAUDE_CONFIG_DIR);
        // Compaction can happen in the middle of a turn, which goes on.
        const before = input.source === "compact" ? read(sessionFile) : undefined;
        if (before?.turn) session.turn = before.turn;
        write(sessionFile, session);
        if (inboxFile) {
          const shown = { sessionId, inbox, attended: process.env.CLAUDE_CODE_SESSION_ATTENDED !== "0", at: now };
          if (process.env.CLAUDE_CODE_MESSAGING_TOKEN) shown.token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
          if (process.env.CLAUDE_PID) shown.pid = Number(process.env.CLAUDE_PID);
          write(inboxFile, shown);
        }
        break;
      }
      case "UserPromptSubmit": {
        // A turn starts. Fires arrive as messages starting with [self-starter]; only their first line is kept.
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        const turn = { at: now, running: true, trigger: prompt.startsWith("[self-starter]") };
        if (turn.trigger) turn.line = prompt.split("\n")[0].slice(0, 300);
        const session = read(sessionFile) ?? { sessionId, cwd: input.cwd || process.cwd(), startedAt: now };
        write(sessionFile, { ...session, turn });
        break;
      }
      case "Stop":
      case "StopFailure":
      case "Notification": {
        // The turn is over. The notification is idle_prompt, which also follows a turn the user
        // interrupted, where Stop does not run.
        const session = read(sessionFile);
        if (session?.turn?.running) write(sessionFile, { ...session, turn: { ...session.turn, at: now, running: false } });
        break;
      }
      case "SessionEnd": {
        const session = read(sessionFile);
        if (session) write(sessionFile, { ...session, endedAt: now, ...(session.turn ? { turn: { ...session.turn, running: false } } : {}) });
        // After /clear or /resume, SessionStart writes the process's new session. When the process exits,
        // its inbox is closed already and not in the environment: its record is found by its pid.
        const pid = Number(process.env.CLAUDE_PID);
        for (const name of inboxFile ? [] : readdirSync(inboxes).filter((file) => file.endsWith(".json"))) {
          const shown = read(join(inboxes, name));
          if (shown?.sessionId === sessionId && shown.pid === pid) rmSync(join(inboxes, name), { force: true });
        }
        if (inboxFile && read(inboxFile)?.sessionId === sessionId) rmSync(inboxFile, { force: true });
        break;
      }
    }
  }
} catch {
  // Never get in the way of the session.
}
