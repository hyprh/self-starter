import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "../core/patch.js";

const OUTPUT_LIMIT = 1024 * 1024;
const ERROR_LIMIT = 16 * 1024;

export interface SessionProcess {
  pid: number;
  parent: number;
  uid: number;
}

export interface SessionProcessRunOptions {
  host: "zcode" | "opencode";
  hostName: string;
  sessionsDir: string;
  sessionId?: string;
  cwd: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  onStart?: () => void;
}

export type SessionProcessOutcome =
  | { kind: "busy" }
  | { kind: "failed"; reason: string }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** An explicit lifetime boundary; a new scoped CLI always replaces this value. */
export const SHARED_DAEMON_SCOPE = "shared-daemon";

function ps(args: string[]): string {
  const result = spawnSync("/bin/ps", args, { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error("could not inspect session processes");
  return result.stdout;
}

export function sessionProcesses(): SessionProcess[] {
  return ps(["-axo", "pid=,ppid=,uid="]).trim().split("\n").flatMap((line) => {
    const [pid, parent, uid] = line.trim().split(/\s+/).map(Number);
    return pid && parent && uid !== undefined ? [{ pid, parent, uid }] : [];
  });
}

/** macOS ps appends the environment to command, with -ww disabling truncation. */
export function markedPsProcesses(output: string, marker: string): Set<number> {
  const marked = new Set<number>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields.shift());
    if (Number.isSafeInteger(pid) && pid > 0 && fields.includes(marker)) marked.add(pid);
  }
  return marked;
}

/** A fresh inherited marker survives setsid() and the death of a process's parents. */
export function markedSessionProcesses(processes: SessionProcess[], marker: string): Set<number> {
  const uid = process.getuid!();
  if (process.platform === "darwin") {
    // In macOS's UNIX2003 mode, lowercase -e selects all processes; -E
    // includes the launch environment, also for detached processes (-x).
    return markedPsProcesses(ps(["-Eww", "-U", String(uid), "-x", "-o", "pid=,command="]), marker);
  }
  if (process.platform !== "linux") throw new Error("session cleanup requires Linux or macOS");
  const marked = new Set<number>();
  for (const { pid, uid: owner } of processes) {
    if (owner !== uid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)) marked.add(pid);
    } catch (error) {
      // Processes can exit while being inspected; another same-user process
      // can also have made its environment private (for example with setuid).
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return marked;
}

/**
 * Freeze a marked CLI run before killing it, including reparented detached tools.
 * Processes owned by other UIDs or refusing signals with EPERM cannot block SIGKILL
 * delivery to the rest of the frozen tree.
 */
export function killSessionProcesses(
  runMarker: string,
  deps: {
    uid?: number;
    list?: () => SessionProcess[];
    marked?: (processes: SessionProcess[], marker: string) => Set<number>;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): void {
  const uid = deps.uid ?? process.getuid!();
  const list = deps.list ?? sessionProcesses;
  const markedOf = deps.marked ?? markedSessionProcesses;
  const send = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try { send(pid, sig); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "EPERM") return false;
      throw error;
    }
  };
  const frozen = new Set<number>();
  try {
    for (;;) {
      const table = list();
      const marked = markedOf(table, runMarker);
      const shared = markedOf(table, `SELF_STARTER_RUN_TOKEN=${SHARED_DAEMON_SCOPE}`);
      let added = false;
      for (const { pid, parent, uid: owner } of table) {
        if (owner !== uid || shared.has(pid) || frozen.has(pid) || (!marked.has(pid) && !frozen.has(parent))) continue;
        if (signal(pid, "SIGSTOP")) { frozen.add(pid); added = true; }
      }
      if (!added) break;
    }
  } finally {
    for (const pid of [...frozen].reverse()) signal(pid, "SIGKILL");
  }
}

/**
 * Runs a headless CLI turn under session-process.js so the session lease and
 * execution deadline survive a daemon crash.
 */
export function runSessionProcess(options: SessionProcessRunOptions): Promise<SessionProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./session-process.js", import.meta.url)),
      options.sessionsDir, options.sessionId ?? "", String(options.timeoutMs), options.command, ...options.args,
    ], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, SELF_STARTER_HOST: options.host, SELF_STARTER_TRIGGER_TURN: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let phase: "waiting" | "started" | "busy" = "waiting";
    let stopped: string | undefined;
    let settled = false;
    const finish = (outcome: SessionProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const stop = (reason: string) => {
      if (stopped || settled) return;
      stopped = reason;
      try { if (child.pid) process.kill(child.pid, "SIGTERM"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.ceil(options.timeoutMs / 1000)}s`), options.timeoutMs);
    child.on("message", (message: unknown) => {
      if (!isRecord(message) || phase !== "waiting" || stopped || settled) return;
      if (message.type === "busy") { phase = "busy"; return; }
      if (message.type !== "ready") return;
      phase = "started";
      try { options.onStart?.(); }
      catch (error) {
        stop(`could not record turn start: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      child.send({ type: "go", ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) }, (error) => {
        if (error) stop(`could not start owned session: ${error.message}`);
      });
    });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > OUTPUT_LIMIT) stop(`output exceeded ${OUTPUT_LIMIT} bytes`);
      else stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk.slice(0, Math.max(0, ERROR_LIMIT - stderr.length));
    });
    child.on("error", (error) => finish({ kind: "failed", reason: `could not start ${options.hostName}: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (phase === "busy") return finish({ kind: "busy" });
      if (stopped) return finish({ kind: "failed", reason: stopped });
      finish({ kind: "exited", code, signal, stdout, stderr });
    });
  });
}
