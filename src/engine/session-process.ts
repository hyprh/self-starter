// The CLI owner keeps its deadline after a daemon crash. Resumed turns also
// hold a session lease until the CLI and its output streams close.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/patch.js";
import { ensurePrivateDir } from "./fs-util.js";
import { markedSessionProcesses, sessionProcesses, SHARED_DAEMON_SCOPE } from "./session-processes.js";

const [sessionsDir, sessionId, timeoutMs, command, ...args] = process.argv.slice(2);
const host = process.env.SELF_STARTER_HOST === "opencode" ? "opencode" : "zcode";
const name = host === "opencode" ? "OpenCode" : "ZCode";
if (!sessionsDir || sessionId === undefined || !command || !process.send) throw new Error(`${name} wrapper requires a session argument and IPC parent`);
const lock = join(sessionsDir, `${sessionId}.${host}.lock`);
const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
const runToken = randomUUID();
const runMarker = `SELF_STARTER_RUN_TOKEN=${runToken}`;
let owned = false;
let started = false;
let cliPid: number | undefined;
let stopping = false;
let cleaned = false;
let closed = false;
let exitCode = 1;

function release(): void {
  if (!owned) return;
  try {
    if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`Could not release ${name} lease ${lock}: ${String(error)}\n`);
  }
  owned = false;
}

function acquire(): boolean {
  ensurePrivateDir(sessionsDir!);
  const temp = join(sessionsDir!, `.${host}-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(temp, owner, { flag: "wx", mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(temp, lock);
        owned = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let text: string;
      try { text = readFileSync(lock, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let previous: unknown;
      try { previous = JSON.parse(text); } catch { /* Invalid records require manual recovery. */ }
      if (!isRecord(previous) || !Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0 || typeof previous.token !== "string" || !previous.token) {
        throw new Error(`Invalid ${name} lease ${lock}; inspect and remove it manually before retrying`);
      }
      try {
        process.kill(Number(previous.pid), 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") return false;
        if (code !== "ESRCH") throw error;
      }
      // The daemon serializes work per session. Re-read before reclaiming a
      // dead owner, so a lease already replaced by another run is left alone.
      try { if (readFileSync(lock, "utf8") === text) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally {
    unlinkSync(temp);
  }
}

process.on("exit", release);

/**
 * Freeze this run before killing it, including reparented detached tools.
 * A shared daemon explicitly starts a separate lifetime; ordinary descendants
 * remain owned even when a child command constructs a clean environment.
 */
function killRun(): void {
  const signal = (pid: number, value: NodeJS.Signals) => {
    try { process.kill(pid, value); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  const frozen = new Set<number>();
  for (;;) {
    const table = sessionProcesses();
    const marked = markedSessionProcesses(table, runMarker);
    const shared = markedSessionProcesses(table, `SELF_STARTER_RUN_TOKEN=${SHARED_DAEMON_SCOPE}`);
    let added = false;
    for (const { pid, parent } of table) {
      if (shared.has(pid) || frozen.has(pid) || !marked.has(pid) && !frozen.has(parent)) continue;
      if (!signal(pid, "SIGSTOP")) continue;
      frozen.add(pid);
      added = true;
    }
    if (!added) break;
  }
  for (const pid of [...frozen].reverse()) signal(pid, "SIGKILL");
}

function finish(): void {
  if (!closed || stopping && !cleaned) return;
  clearTimeout(timer);
  release();
  process.exitCode = exitCode;
  if (process.connected) process.disconnect?.();
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  if (!cliPid) process.exit(1);
  const cleanup = () => {
    try { killRun(); }
    catch (error) {
      process.stderr.write(`Could not stop ${name}'s tools; keeping its lease: ${String(error)}\n`);
      setTimeout(cleanup, 100);
      return;
    }
    cleaned = true;
    finish();
  };
  cleanup();
}
// The owner outlives a crashed daemon, so it also owns the execution deadline.
const timer = setTimeout(stop, Number(timeoutMs));
process.on("SIGTERM", stop);
process.on("disconnect", () => {
  if (!started) process.exit(0);
});

// A daemon crash closes its pipes. Drain the CLI's output after EPIPE instead
// of letting a broken diagnostic stream terminate the lease owner early.
for (const output of [process.stdout, process.stderr]) output.on("error", () => {});

process.on("message", (message: unknown) => {
  if (started || !isRecord(message) || message.type !== "go") return;
  started = true;
  const stdin = typeof message.stdin === "string" ? message.stdin : undefined;
  const child = spawn(command!, args, {
    env: { ...process.env, SELF_STARTER_RUN_TOKEN: runToken },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true,
  });
  cliPid = child.pid;
  if (stdin !== undefined) {
    child.stdin!.on("error", () => {}); // A failed CLI may close stdin before reading it.
    child.stdin!.end(stdin);
  }
  for (const [input, output] of [[child.stdout!, process.stdout], [child.stderr!, process.stderr]] as const) {
    input.pipe(output, { end: false });
    output.once("error", () => { input.unpipe(output); input.resume(); });
  }
  child.on("error", (error) => process.stderr.write(`could not start ${name}: ${error.message}\n`));
  child.on("close", (code) => {
    closed = true;
    exitCode = code ?? 1;
    finish();
  });
});

try {
  if (sessionId && !acquire()) process.send!({ type: "busy" }, () => process.exit(0));
  else process.send!({ type: "ready" }, (error) => { if (error) process.exit(1); });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
