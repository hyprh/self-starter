// Dedicated resumed-turn wrapper. Its PID, rather than the daemon's PID, owns
// the session until the CLI and its output streams close.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/patch.js";
import { ensurePrivateDir } from "./fs-util.js";

const [sessionsDir, sessionId, timeoutMs, command, ...args] = process.argv.slice(2);
if (!sessionsDir || !sessionId || !command || !process.send) throw new Error("ZCode wrapper requires a session and IPC parent");
const lock = join(sessionsDir, `${sessionId}.zcode.lock`);
const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
let owned = false;
let started = false;
let cliPid: number | undefined;

function release(): void {
  if (!owned) return;
  try {
    if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`Could not release ZCode lease ${lock}: ${String(error)}\n`);
  }
  owned = false;
}

function acquire(): boolean {
  ensurePrivateDir(sessionsDir!);
  const temp = join(sessionsDir!, `.zcode-${process.pid}-${randomUUID()}.tmp`);
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
        throw new Error(`Invalid ZCode lease ${lock}; inspect and remove it manually before retrying`);
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
function stop(): void {
  if (!cliPid) process.exit(1);
  try { process.kill(-cliPid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
  if (!owned || started || !isRecord(message) || message.type !== "go") return;
  started = true;
  const child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  cliPid = child.pid;
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    input.pipe(output, { end: false });
    output.once("error", () => { input.unpipe(output); input.resume(); });
  }
  child.on("error", (error) => process.stderr.write(`could not start ZCode: ${error.message}\n`));
  child.on("close", (code) => {
    clearTimeout(timer);
    release();
    process.exitCode = code ?? 1;
    if (process.connected) process.disconnect();
  });
});

try {
  if (!acquire()) process.send!({ type: "busy" }, () => process.exit(0));
  else process.send!({ type: "ready" }, (error) => { if (error) process.exit(1); });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
