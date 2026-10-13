#!/usr/bin/env node
// self-starter: the Self-Starter command line. It also runs the daemon (`self-starter daemon`)
// and the plugin's MCP server (`self-starter mcp`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { hostOf } from "../core/conversations.js";
import { AlreadyRunning, startDaemon, type Daemon } from "../daemon/daemon.js";
import { loadConfig, saveConfig } from "../engine/config.js";
import { resolvePaths } from "../engine/paths.js";
import type { DraftView, FireView, TriggerSummary } from "../engine/service.js";
import { runMcpServer } from "../mcp/server.js";
import { VERSION } from "../runtime.js";
import { ensureDaemon, installService, serviceManager, stopRunningDaemon } from "../service/manager.js";
import { doctor, install, uninstall } from "./install.js";
import { flag, need, out, parseArgs, UsageError, when } from "./io.js";
import { channelCommand, secretCommand } from "./settings.js";

const HELP = `self-starter ${VERSION}: let Codex act when something happens

Setup
  self-starter install [--codex <path>] [--no-service]  install the Codex plugin and the background service
  self-starter uninstall [--purge]                       remove them (--purge also deletes triggers and history)
  self-starter doctor                                    check the installation

Triggers
  self-starter list                                      all triggers and their state
  self-starter show <id>                                 definition, state, recent checks and fires
  self-starter test <id>                                 run the probe once, without firing
  self-starter pause <id> | resume <id> | delete <id>
  self-starter history [<id>] [-n <count>]               recent fires and what came of them
  self-starter drafts                                    drafts Codex tried but did not turn on
  self-starter activate <draft-id>                       turn a draft on
  self-starter recipes                                   ready-made recipes Codex can set up for you

Secrets (API keys for probes)
  self-starter secret set <NAME> [--hosts <host,...>]    store a secret; --hosts limits which hosts a sandboxed probe may send it to
  self-starter secret list | self-starter secret rm <NAME>

Notifications
  self-starter channel list                              where notifications go
  self-starter channel email <your address> [--to <addr>] [--default] [--no-test]
                                                        email from Gmail, iCloud, Yahoo, Fastmail, QQ, 163/126 or Aliyun
                                                        with an app password; other servers: --host <smtp-host> [--port] [--starttls]
  self-starter channel default desktop[,email]           channels for triggers that do not choose their own
  self-starter channel test [desktop|email]              send a test notification
  self-starter channel rm email

Background service
  self-starter service install|uninstall|start|stop|restart|status
  self-starter logs [-n <lines>]
  self-starter daemon                                    run the daemon in the foreground
  self-starter mcp                                       run the MCP server on stdio (Codex starts it)
`;

const paths = resolvePaths();

async function daemonCall<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  await ensureDaemon(paths);
  return callDaemon<T>(paths.socket, method, params, { via: "cli" }, timeoutMs);
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
  const target = t.action === "notify" ? "notify only" : `agent → ${t.target} ${t.host === "codex" ? "thread" : "session"}${t.threadId ? ` ${t.threadId}` : ""}`;
  out(`${t.id}  ${t.name}`);
  out(`  ${t.state} · ${last}`);
  out(`  next check ${when(t.nextCheck)} · ${t.fires} fire(s) · ${target}`);
}

function conversationNoun(ref: string | null | undefined): string {
  return hostOf(ref) === "codex" ? "thread" : "session";
}

/**
 * Where a fire was answered: in a Codex app that had the thread open, or in the thread opened in the background;
 * in a Claude Code session that was open, or in the session resumed in the background.
 */
function answeredWhere(fire: FireView): string {
  const source = fire.receipt?.source;
  const ref = fire.target?.threadId;
  if (!ref || (source !== "tool" && source !== "final-answer")) return "";
  const where = `${fire.target?.kind === "dedicated" ? "its own" : "your"} ${conversationNoun(ref)}`;
  const codex = hostOf(ref) === "codex";
  const how = fire.wokenAt ? (codex ? "opened in the background" : "resumed in the background") : codex ? "open in Codex" : "open in Claude Code";
  return `  (${where}, ${how})`;
}

async function activate(draftId: string): Promise<void> {
  const view = await daemonCall<DraftView>("draft.get", { draftId });
  out(view.description);
  if (view.warnings.length > 0) out(`\nWarnings:\n${view.warnings.map((w) => `- ${w}`).join("\n")}`);
  out();
  printCode(view.codePath);
  const result = await daemonCall<TriggerSummary>("draft.activate", { draftId });
  out(`Activated ${result.id}: ${result.state}`);
}

async function serviceCommand(action: string | undefined): Promise<void> {
  const manager = serviceManager();
  switch (action) {
    case "install": {
      if (manager.kind === "none") throw new Error("no launchd or systemd user session here; run `self-starter daemon` some other way");
      await installService(paths, manager);
      out((await waitForDaemon(paths.socket, 10_000)) ? `Installed and started (${manager.file}).` : `Installed (${manager.file}), but the daemon did not answer yet; see self-starter logs.`);
      return;
    }
    case "uninstall":
      manager.uninstall();
      saveConfig(paths, { ...loadConfig(paths), service: false });
      out("Removed the background service. Codex starts the daemon when it needs it; `self-starter service install` brings the service back.");
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
      if (manager.installed()) manager.restart();
      else await stopRunningDaemon(paths);
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
      throw new UsageError("usage: self-starter service install|uninstall|start|stop|restart|status");
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
      out(args.flags.has("version") ? VERSION : HELP);
      return;
    case "help":
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
      await install(paths, { codex: flag(args, "codex"), service: !args.flags.has("no-service"), log: (l) => out(`✓ ${l}`) });
      out("\nDone. Restart the Codex app (or start a new `codex` session) so it loads the plugin, then ask Codex, for example:");
      out('  "Watch https://example.com/status and tell me when it stops returning 200."');
      out("Codex uses the skill $self-starter:triggers to set it up.");
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
      const kept = result.dedicatedThreadId ? ` Its ${conversationNoun(result.dedicatedThreadId)} ${result.dedicatedThreadId} was kept.` : "";
      out(`Deleted ${result.deleted}.${kept}`);
      return;
    }
    case "history": {
      const params: Record<string, unknown> = { limit: Number(args.flags.get("n") ?? 10) };
      if (id) params.triggerId = id;
      const fires = await daemonCall<FireView[]>("fire.history", params);
      if (fires.length === 0) return out("No fires yet.");
      for (const f of fires) {
        out(`${when(f.firedAt)}  ${f.triggerId} #${f.fireNumber}  ${f.status}  ${f.summary}`);
        if (f.receipt) out(`    → ${f.receipt.summary}${answeredWhere(f)}`);
        else if (f.error) out(`    ! ${f.error}`);
        else if (f.skippedBecause) out(`    skipped: ${f.skippedBecause}`);
      }
      return;
    }
    case "recipes": {
      const recipes = await daemonCall<Array<{ id: string; version: number; title: string; summary: string; secrets: Array<{ name: string }> }>>("recipe.list");
      if (recipes.length === 0) return out("No recipes.");
      for (const r of recipes) {
        out(`${r.id}  ${r.title}`);
        out(`  ${r.summary}`);
        if (r.secrets.length > 0) out(`  needs: ${r.secrets.map((x) => x.name).join(", ")} (self-starter secret set ...)`);
      }
      out("\nAsk Codex to set one up, for example: \"watch my IBKR account for unusual activity\" or \"tell me when analysts change their view on Tencent\".");
      return;
    }
    case "drafts": {
      const drafts = await daemonCall<Array<{ draftId: string; createdAt: string; trialOk: boolean | null; replaces: string | null }>>("draft.list");
      if (drafts.length === 0) return out("No drafts.");
      for (const d of drafts) out(`${d.draftId}  ${when(d.createdAt)}  trial ${d.trialOk === null ? "not run" : d.trialOk ? "ok" : "failed"}${d.replaces ? `  (replaces ${d.replaces})` : ""}`);
      out("\nTurn one on with: self-starter activate <draft-id>");
      return;
    }
    case "activate":
      await activate(need(id, "draft id"));
      return;
    case "secret":
      await secretCommand(paths, args);
      return;
    case "service":
      await serviceCommand(id);
      return;
    case "channel":
    case "channels":
      await channelCommand(paths, args);
      return;
    case "logs": {
      const file = join(paths.logs, "daemon.log");
      if (!existsSync(file)) return out("No log yet.");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      for (const line of lines.slice(-Number(args.flags.get("n") ?? 50))) out(line);
      return;
    }
    default:
      throw new UsageError(`unknown command: ${command}; see self-starter help`);
  }
}

// Output piped into `head` and the like: stop quietly when the reader goes away.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).catch((error: Error) => {
  process.stderr.write(`self-starter: ${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
