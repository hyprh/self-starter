import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface SessionProcess {
  pid: number;
  parent: number;
  uid: number;
}

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
