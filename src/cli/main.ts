#!/usr/bin/env node
// ctrig: the codex-triggers command line. It also runs the daemon (`ctrig daemon`)
// and the plugin's MCP server (`ctrig mcp`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { AlreadyRunning, startDaemon, type Daemon } from "../daemon/daemon.js";
import { loadConfig } from "../engine/config.js";
import { resolvePaths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import type { DraftView, TriggerSummary } from "../engine/service.js";
import { Store } from "../engine/store.js";
import { runMcpServer } from "../mcp/server.js";
import { VERSION } from "../runtime.js";
import { ensureDaemon, serviceManager, serviceSpec } from "../service/manager.js";
import { doctor, install, uninstall } from "./install.js";

const HELP = `ctrig ${VERSION}: let Codex act when something happens

Setup
  ctrig install [--codex <path>] [--no-service]  install the Codex plugin and the background service
  ctrig uninstall [--purge]                       remove them (--purge also deletes triggers and history)
  ctrig doctor                                    check the installation

Triggers
  ctrig list                                      all triggers and their state
  ctrig show <id>                                 definition, state, recent checks and fires
  ctrig test <id>                                 run the probe once, without firing
  ctrig pause <id> | resume <id> | delete <id>
  ctrig history [<id>] [-n <count>]               recent fires and what came of them
  ctrig drafts                                    drafts waiting for approval
  ctrig approve <draft-id | trigger-id>           review and approve in the terminal

Secrets (API keys for probes)
  ctrig secret set <NAME> --hosts <host,...>      store a secret that may only be sent to these hosts
  ctrig secret set <NAME> --any-host              ... or to any host the probe can reach
  ctrig secret list | ctrig secret rm <NAME>

Background service
  ctrig service install|uninstall|start|stop|restart|status
  ctrig logs [-n <lines>]
  ctrig daemon                                    run the daemon in the foreground
  ctrig mcp                                       run the MCP server on stdio (Codex starts it)
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-n") {
      flags.set("n", argv[++i] ?? "");
    } else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const takesValue = ["codex", "hosts"].includes(name);
      flags.set(name, inline ?? (takesValue ? (argv[++i] ?? "") : true));
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const paths = resolvePaths();
const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

class UsageError extends Error {}

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}; see ctrig help`);
  return value;
}

async function daemonCall<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  await ensureDaemon(paths);
  return callDaemon<T>(paths.socket, method, params, { via: "cli" }, timeoutMs);
}

function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("approval needs an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function printCode(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  out(`----- ${path} -----`);
  for (const line of lines.slice(0, 200)) out(`  ${line}`);
  if (lines.length > 200) out(`  ... ${lines.length - 200} more lines`);
  out("-----");
}

function printSummary(t: TriggerSummary): void {
  const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 97)}...` : text);
  const last = t.lastCheck
    ? `last check ${when(t.lastCheck.at)} ${t.lastCheck.ok ? `ok: ${clip(t.lastCheck.summary ?? "")}` : `failed: ${clip(t.lastCheck.error ?? "")}`}`
    : "not checked yet";
  const target = t.action === "notify" ? "notify only" : `agent → ${t.target} thread${t.threadId ? ` ${t.threadId}` : ""}`;
  out(`${t.id}  ${t.name}`);
  out(`  ${t.state} · ${last}`);
  out(`  next check ${when(t.nextCheck)} · ${t.fires} fire(s) · ${target}`);
}

async function approve(id: string): Promise<void> {
  if (id.startsWith("draft-")) {
    const view = await daemonCall<DraftView>("draft.get", { draftId: id });
    out(view.approvalText);
    if (view.warnings.length > 0) out(`\nWarnings:\n${view.warnings.map((w) => `- ${w}`).join("\n")}`);
    out();
    printCode(view.codePath);
    if (!(await confirm("Approve and activate this trigger?"))) return out("Not approved; nothing changed.");
    const result = await daemonCall<TriggerSummary>("draft.activate", { draftId: id });
    out(`Activated ${result.id}: ${result.state}`);
    return;
  }
  const view = await daemonCall<{ triggerId: string; problem: string | null; approvalText: string }>("trigger.approval", { triggerId: id });
  if (!view.problem) return out(`${id} is already approved.`);
  out(`${id} needs approval because ${view.problem}.\n`);
  out(view.approvalText);
  out();
  const shown = await daemonCall<{ probePath: string }>("trigger.get", { triggerId: id });
  printCode(shown.probePath);
  if (!(await confirm("Approve this code and these permissions, and resume the trigger?"))) return out("Not approved; the trigger stays paused.");
  const result = await daemonCall<TriggerSummary>("trigger.approve", { triggerId: id });
  out(`Approved ${result.id}: ${result.state}`);
}

async function secretCommand(args: Args): Promise<void> {
  const secrets = new Secrets(paths);
  const [, action, name] = args.positional;
  switch (action) {
    case "set": {
      const secretName = need(name, "secret name");
      const hostsFlag = args.flags.get("hosts");
      const hosts = args.flags.has("any-host") ? "*" : typeof hostsFlag === "string" ? hostsFlag.split(",").map((h) => h.trim()).filter(Boolean) : undefined;
      if (!hosts) throw new UsageError("say where the secret may be sent: --hosts api.example.com[,other.host] or --any-host");
      const value = process.stdin.isTTY ? await readHidden(`Value for ${secretName}: `) : await readStdin();
      new Store(paths).ensureLayout();
      secrets.set(secretName, value, hosts);
      out(`Saved ${secretName} (may be sent to ${hosts === "*" ? "any host" : hosts.join(", ")}).`);
      return;
    }
    case "list": {
      const list = secrets.list();
      if (list.length === 0) return out("No secrets.");
      for (const s of list) out(`${s.name}  →  ${s.hosts === "*" ? "any host" : s.hosts.join(", ")}`);
      return;
    }
    case "rm":
    case "remove":
      out(secrets.remove(need(name, "secret name")) ? `Removed ${name}.` : `No secret named ${name}.`);
      return;
    default:
      throw new UsageError("usage: ctrig secret set|list|rm");
  }
}

async function serviceCommand(action: string | undefined): Promise<void> {
  const manager = serviceManager();
  switch (action) {
    case "install": {
      if (manager.kind === "none") throw new Error("no launchd or systemd user session here; run `ctrig daemon` some other way");
      if (await isDaemonRunning(paths.socket)) {
        await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1000));
      }
      manager.install(serviceSpec(paths, loadConfig(paths).codexBin));
      out((await waitForDaemon(paths.socket, 10_000)) ? `Installed and started (${manager.file}).` : `Installed (${manager.file}), but the daemon did not answer yet; see ctrig logs.`);
      return;
    }
    case "uninstall":
      manager.uninstall();
      out("Removed the background service.");
      return;
    case "start":
      await ensureDaemon(paths);
      out("The daemon is running.");
      return;
    case "stop":
      if (!(await isDaemonRunning(paths.socket))) return out("The daemon is not running.");
      if (manager.installed() && manager.stop()) return out("Stopped.");
      await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000);
      out("Stopped.");
      return;
    case "restart":
      if (manager.installed()) {
        manager.restart();
      } else if (await isDaemonRunning(paths.socket)) {
        await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1000));
      }
      await ensureDaemon(paths);
      out("Restarted.");
      return;
    case "status":
    case undefined: {
      out(`service: ${manager.kind === "none" ? "no service manager" : manager.installed() ? `${manager.kind} (${manager.file})` : "not installed"}`);
      if (!(await isDaemonRunning(paths.socket))) return out("daemon: not running");
      out(JSON.stringify(await callDaemon(paths.socket, "status", {}), null, 2));
      return;
    }
    default:
      throw new UsageError("usage: ctrig service install|uninstall|start|stop|restart|status");
  }
}

async function runDaemonForeground(): Promise<void> {
  let daemon: Daemon | undefined;
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await daemon?.stop().catch(() => undefined);
    process.exit(code);
  };
  try {
    daemon = await startDaemon({ logToStderr: process.stderr.isTTY ?? false, onStopRequest: () => void stop(0) });
  } catch (error) {
    if (error instanceof AlreadyRunning) {
      process.stderr.write(`${error.message}\n`);
      process.exit(0);
    }
    throw error;
  }
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
  process.on("unhandledRejection", (reason) => daemon?.log(`unhandled rejection: ${String((reason as Error)?.stack ?? reason)}`));
  process.on("uncaughtException", (error) => {
    daemon?.log(`uncaught exception: ${error.stack ?? error.message}`);
    void stop(1);
  });
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [command, id] = args.positional;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      out(HELP);
      return;
    case "version":
      out(VERSION);
      return;
    case "mcp":
      await runMcpServer({ paths });
      return;
    case "daemon":
      await runDaemonForeground();
      return;
    case "install":
      await install(paths, { codex: args.flags.get("codex") as string | undefined, service: !args.flags.has("no-service"), log: (l) => out(`✓ ${l}`) });
      out("\nDone. Restart the Codex app (or start a new `codex` session) so it loads the plugin, then ask Codex, for example:");
      out('  "Watch https://example.com/status and tell me when it stops returning 200."');
      out("Codex uses the skill $codex-triggers:triggers to set it up and asks you to approve it.");
      return;
    case "uninstall":
      await uninstall(paths, { purge: args.flags.has("purge"), log: (l) => out(`✓ ${l}`) });
      return;
    case "doctor": {
      const checks = await doctor(paths);
      for (const check of checks) out(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(13)} ${check.detail}`);
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
      return;
    }
    case "list": {
      const list = await daemonCall<TriggerSummary[]>("trigger.list");
      if (list.length === 0) return out("No triggers yet. Ask Codex to watch something for you.");
      list.forEach((t, i) => {
        if (i > 0) out();
        printSummary(t);
      });
      return;
    }
    case "show": {
      const detail = await daemonCall<TriggerSummary & Record<string, unknown>>("trigger.get", { triggerId: need(id, "trigger id") });
      printSummary(detail);
      out(`  approval: ${String(detail.approval)}`);
      out(`  probe: ${String(detail.probePath)}\n`);
      out(String(detail.definitionYaml).trimEnd());
      out(`\nstate: ${JSON.stringify(detail.runtime, null, 2)}`);
      out(`\nrecent checks: ${JSON.stringify(detail.recentRuns, null, 2)}`);
      out(`\nrecent fires: ${JSON.stringify(detail.recentFires, null, 2)}`);
      return;
    }
    case "test":
      out(JSON.stringify(await daemonCall("trigger.test", { triggerId: need(id, "trigger id") }, 6 * 60_000), null, 2));
      return;
    case "pause":
    case "resume":
      printSummary(await daemonCall<TriggerSummary>(`trigger.${command}`, { triggerId: need(id, "trigger id") }));
      return;
    case "delete": {
      const result = await daemonCall<{ deleted: string; dedicatedThreadId: string | null }>("trigger.delete", { triggerId: need(id, "trigger id") });
      out(`Deleted ${result.deleted}.${result.dedicatedThreadId ? ` Its thread ${result.dedicatedThreadId} was kept in Codex.` : ""}`);
      return;
    }
    case "history": {
      const params: Record<string, unknown> = { limit: Number(args.flags.get("n") ?? 10) };
      if (id) params.triggerId = id;
      const fires = await daemonCall<Array<Record<string, unknown>>>("fire.history", params);
      if (fires.length === 0) return out("No fires yet.");
      for (const f of fires) {
        const receipt = f.receipt as { summary: string } | null;
        out(`${when(f.firedAt as string)}  ${String(f.triggerId)} #${String(f.fireNumber)}  ${String(f.status)}  ${String(f.summary)}`);
        if (receipt) out(`    → ${receipt.summary}`);
        else if (f.error) out(`    ! ${String(f.error)}`);
        else if (f.skippedBecause) out(`    skipped: ${String(f.skippedBecause)}`);
      }
      return;
    }
    case "drafts": {
      const drafts = await daemonCall<Array<{ draftId: string; createdAt: string; trialOk: boolean | null; replaces: string | null }>>("draft.list");
      if (drafts.length === 0) return out("No drafts.");
      for (const d of drafts) out(`${d.draftId}  ${when(d.createdAt)}  trial ${d.trialOk === null ? "not run" : d.trialOk ? "ok" : "failed"}${d.replaces ? `  (replaces ${d.replaces})` : ""}`);
      out("\nApprove one with: ctrig approve <draft-id>");
      return;
    }
    case "approve":
      await approve(need(id, "draft id or trigger id"));
      return;
    case "secret":
      await secretCommand(args);
      return;
    case "service":
      await serviceCommand(id);
      return;
    case "logs": {
      const file = join(paths.logs, "ctrigd.log");
      if (!existsSync(file)) return out("No log yet.");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      for (const line of lines.slice(-Number(args.flags.get("n") ?? 50))) out(line);
      return;
    }
    default:
      throw new UsageError(`unknown command: ${command}; see ctrig help`);
  }
}

// Output piped into `head` and the like: stop quietly when the reader goes away.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).catch((error: Error) => {
  process.stderr.write(`ctrig: ${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
