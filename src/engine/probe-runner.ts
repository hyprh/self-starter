// Runs a probe in Deno with only the permissions its definition declares:
// network access to the listed hosts, the listed environment variables, and
// nothing else (no files, no subprocesses, no remote or npm imports).

import { spawn } from "node:child_process";
import { join } from "node:path";
import { probeTimings, type TriggerDefinition } from "../core/definition.js";
import { parseProbeOutput } from "../core/probe-output.js";
import type { RunResult } from "../core/state-machine.js";

const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 16 * 1024;

/**
 * Variables Deno itself reads to reach the network through a proxy or to trust
 * extra certificates. Probes cannot read them (no --allow-env for them).
 */
const PASS_THROUGH_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "DENO_CERT", "DENO_TLS_CA_STORE"];

function passThroughEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH_ENV) {
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
  /** Directory holding the probe file; also the working directory. */
  dir: string;
  definition: TriggerDefinition;
  input: ProbeInput;
  /** Values for the definition's permissions.env, already filtered. */
  env: Record<string, string>;
  timeoutMs?: number;
}

export type ProbeRunResult = RunResult & { stderr: string };

export function denoArgs(definition: TriggerDefinition, entryPath: string): string[] {
  const args = ["run", "--quiet", "--no-prompt", "--no-config", "--no-lock", "--no-remote", "--no-npm"];
  const { net, env } = definition.probe.permissions;
  if (net.length > 0) args.push(`--allow-net=${net.join(",")}`);
  if (env.length > 0) args.push(`--allow-env=${env.join(",")}`);
  args.push("--v8-flags=--max-old-space-size=128", entryPath);
  return args;
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
    const child = spawn(options.denoBin, denoArgs(definition, entryPath), {
      cwd: options.dir,
      env: {
        ...passThroughEnv(),
        ...options.env,
        DENO_DIR: options.denoDir,
        DENO_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
        ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
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
      child.kill("SIGKILL");
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
