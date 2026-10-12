// Runs a probe in Deno.
//
// By default (access: full) a probe runs as the user, like a script they run
// themselves: it can read and write files, run commands, reach any host and read
// the environment. With access: sandbox it can only reach the hosts in
// permissions.net and read the secrets in permissions.env: no files, no
// subprocesses, no remote or npm imports.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { probeTimings, type TriggerDefinition } from "../core/definition.js";
import { parseProbeOutput } from "../core/probe-output.js";
import type { RunResult } from "../core/state-machine.js";

const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 16 * 1024;
const FULL_MEMORY_MB = 512;
const SANDBOX_MEMORY_MB = 128;

/**
 * Variables Deno itself reads to reach the network through a proxy or to trust
 * extra certificates. Sandboxed probes cannot read them (no --allow-env for them).
 */
const PASS_THROUGH_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "DENO_CERT", "DENO_TLS_CA_STORE", "TZ"];

function pickEnv(names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

export interface ProbeInput {
  version: 1;
  trigger_id: string;
  now: string;
  params: Record<string, unknown>;
  state: unknown;
  last: { fire?: boolean; summary?: string; ran_at?: string } | null;
}

export interface ProbeRunOptions {
  denoBin: string;
  denoDir: string;
  /** Directory holding the probe file. */
  dir: string;
  /** Working directory of a full-access probe, such as the trigger's target.cwd; defaults to `dir`. */
  cwd?: string;
  definition: TriggerDefinition;
  input: ProbeInput;
  /** Values for the definition's permissions.env, already filtered. */
  env: Record<string, string>;
  timeoutMs?: number;
}

export type ProbeRunResult = RunResult & { stderr: string };

export function denoArgs(definition: TriggerDefinition, entryPath: string): string[] {
  const args = ["run", "--quiet", "--no-prompt", "--no-config", "--no-lock"];
  if (definition.probe.access === "full") {
    args.push("--allow-all", `--v8-flags=--max-old-space-size=${FULL_MEMORY_MB}`, entryPath);
    return args;
  }
  args.push("--no-remote", "--no-npm");
  const { net, env } = definition.probe.permissions;
  if (net.length > 0) args.push(`--allow-net=${net.join(",")}`);
  if (env.length > 0) args.push(`--allow-env=${env.join(",")}`);
  args.push(`--v8-flags=--max-old-space-size=${SANDBOX_MEMORY_MB}`, entryPath);
  return args;
}

/** The environment a probe starts with: the user's own for full access, almost nothing in the sandbox. */
export function probeEnv(definition: TriggerDefinition, secrets: Record<string, string>, denoDir: string): Record<string, string> {
  const own = { DENO_DIR: denoDir, DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  if (definition.probe.access === "full") {
    return { ...pickEnv(Object.keys(process.env)), ...secrets, ...own };
  }
  return { ...pickEnv(PASS_THROUGH_ENV), ...secrets, ...own };
}

/** The error message from Deno's stderr, such as "TypeError: fetch failed", without the stack and source excerpt. */
export function errorSummary(stderr: string): string {
  const lines = stderr.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => line.startsWith("error:"));
  const text = errorLine ? errorLine.replace(/^error:\s*/, "").replace(/^Uncaught (\(in promise\) )?/, "") : (lines[0] ?? "");
  return text.slice(0, 300);
}

export function runProbe(options: ProbeRunOptions): Promise<ProbeRunResult> {
  const { definition } = options;
  const timeoutMs = options.timeoutMs ?? probeTimings(definition).timeoutMs;
  const entryPath = join(options.dir, definition.probe.entry);
  const started = Date.now();

  return new Promise((resolve) => {
    // A process group of its own, so a timeout also stops the commands the probe started.
    const child = spawn(options.denoBin, denoArgs(definition, entryPath), {
      cwd: definition.probe.access === "full" ? (options.cwd ?? options.dir) : options.dir,
      env: probeEnv(definition, options.env, options.denoDir),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stderr: stderr.slice(0, STDERR_LIMIT) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ ok: false, error: `could not start deno: ${error.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs });
      } else if (code !== 0) {
        finish({ ok: false, error: `exited with code ${code}: ${errorSummary(stderr) || "no error output"}`, durationMs });
      } else {
        const parsed = parseProbeOutput(definition.mode, stdout);
        finish(parsed.ok ? { ok: true, output: parsed.output, durationMs } : { ok: false, error: parsed.error, durationMs });
      }
    });

    child.stdin.on("error", () => {
      // The probe may exit without reading stdin; that is not an error by itself.
    });
    child.stdin.end(JSON.stringify(options.input));
  });
}
