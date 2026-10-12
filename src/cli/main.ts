#!/usr/bin/env node
// self-starter: the Self-Starter command line. It also runs the daemon (`self-starter daemon`)
// and the plugin's MCP server (`self-starter mcp`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callDaemon, isDaemonRunning, waitForDaemon } from "../client/client.js";
import { AlreadyRunning, startDaemon, type Daemon } from "../daemon/daemon.js";
import {
  ChannelNotifier,
  channelSettings,
  composeEmail,
  removeEmailChannel,
  saveEmailChannel,
  sendEmail,
  setDefaultChannels,
  type EmailSettings,
} from "../engine/channels.js";
import { loadConfig } from "../engine/config.js";
import { mailProviderFor, unsupportedSender } from "../engine/mail-providers.js";
import { SystemNotifier } from "../engine/notify.js";
import { resolvePaths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import type { DraftView, TriggerSummary } from "../engine/service.js";
import { Store } from "../engine/store.js";
import { runMcpServer } from "../mcp/server.js";
import { VERSION } from "../runtime.js";
import { ensureDaemon, serviceManager, serviceSpec } from "../service/manager.js";
import { doctor, install, uninstall } from "./install.js";

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
      const takesValue = ["codex", "hosts", "to", "host", "port", "user", "from"].includes(name);
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
  if (!value) throw new UsageError(`missing ${what}; see self-starter help`);
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

async function activate(draftId: string): Promise<void> {
  const view = await daemonCall<DraftView>("draft.get", { draftId });
  out(view.description);
  if (view.warnings.length > 0) out(`\nWarnings:\n${view.warnings.map((w) => `- ${w}`).join("\n")}`);
  out();
  printCode(view.codePath);
  const result = await daemonCall<TriggerSummary>("draft.activate", { draftId });
  out(`Activated ${result.id}: ${result.state}`);
}

async function secretCommand(args: Args): Promise<void> {
  const secrets = new Secrets(paths);
  const [, action, name] = args.positional;
  switch (action) {
    case "set": {
      const secretName = need(name, "secret name");
      const hostsFlag = args.flags.get("hosts");
      const hosts = typeof hostsFlag === "string" ? hostsFlag.split(",").map((h) => h.trim()).filter(Boolean) : "*";
      if (hosts !== "*" && hosts.length === 0) throw new UsageError("--hosts needs at least one host, such as --hosts api.example.com");
      const value = process.stdin.isTTY ? await readHidden(`Value for ${secretName}: `) : await readStdin();
      new Store(paths).ensureLayout();
      secrets.set(secretName, value, hosts);
      out(`Saved ${secretName}${hosts === "*" ? "" : ` (a sandboxed probe may only send it to ${hosts.join(", ")})`}.`);
      return;
    }
    case "list": {
      const list = secrets.list();
      if (list.length === 0) return out("No secrets.");
      for (const s of list) out(s.hosts === "*" ? s.name : `${s.name}  (sandboxed probes: only ${s.hosts.join(", ")})`);
      return;
    }
    case "rm":
    case "remove":
      out(secrets.remove(need(name, "secret name")) ? `Removed ${name}.` : `No secret named ${name}.`);
      return;
    default:
      throw new UsageError("usage: self-starter secret set|list|rm");
  }
}

/**
 * `self-starter channel email you@gmail.com`: the mailbox sends notifications to
 * itself (or to --to) through its provider's server, with an app password. Any
 * other server works with --host, --port and --starttls.
 */
async function setUpEmail(address: string | undefined, args: Args): Promise<void> {
  const flag = (name: string) => {
    const value = args.flags.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const sender = address ?? flag("user");
  const host = flag("host");
  const provider = sender && !host ? mailProviderFor(sender) : undefined;
  if (!host && !provider) {
    if (!sender) throw new UsageError("usage: self-starter channel email <your address> [--to <address>]");
    throw new UsageError(unsupportedSender(sender) ?? `there is no preset for ${sender}; give its SMTP server with --host (and --port, --starttls)`);
  }
  const secure = provider ? provider.secure : !args.flags.has("starttls");
  const settings: EmailSettings = {
    to: need(flag("to") ?? sender, "--to <address>"),
    host: provider?.host ?? host!,
    port: flag("port") ? Number(flag("port")) : (provider?.port ?? (secure ? 465 : 587)),
    secure,
    ...(sender ? { user: sender } : {}),
    ...((flag("from") ?? sender) ? { from: flag("from") ?? sender } : {}),
  };

  let password: string | undefined;
  if (settings.user) {
    if (provider) out(`${provider.name}: ${provider.howToGetPassword}.`);
    password = process.stdin.isTTY ? await readHidden(`App password for ${settings.user}: `) : await readStdin();
  }
  new Store(paths).ensureLayout();
  saveEmailChannel(paths, settings, password);
  if (args.flags.has("default")) setDefaultChannels(paths, [...new Set([...channelSettings(loadConfig(paths)).default, "email"])]);

  if (args.flags.has("no-test")) return out(`Saved. Notifications can go to ${settings.to}; try it with: self-starter channel test email`);
  out(`Saved. Sending a test email to ${settings.to}...`);
  try {
    await sendEmail(settings, password, composeEmail({ title: "Test email", body: "Email works: triggers that use the email channel will send their results here." }));
  } catch (error) {
    const message = (error as Error).message;
    const hint = /\b535\b|auth|credential|password|login/i.test(message) ? " Check the app password and run this command again." : "";
    throw new Error(`the test email failed: ${message}.${hint}`);
  }
  out(`Sent. Ask Codex to email you about a trigger, or make email a default: self-starter channel default desktop,email`);
}

async function channelCommand(args: Args): Promise<void> {
  const [, action, name] = args.positional;
  switch (action) {
    case "list":
    case undefined: {
      const settings = channelSettings(loadConfig(paths));
      out(`desktop  ${process.platform === "darwin" ? "macOS notifications" : "notify-send"}`);
      out(settings.email ? `email    to ${settings.email.to} via ${settings.email.host}:${settings.email.port}` : "email    not set up (self-starter channel email you@example.com)");
      out(`default  ${settings.default.join(", ")}`);
      return;
    }
    case "email":
      await setUpEmail(name, args);
      return;
    case "default": {
      const names = need(name, "channel names, such as desktop,email").split(",").map((n) => n.trim()).filter(Boolean);
      out(`Default channels: ${setDefaultChannels(paths, names).join(", ")}`);
      return;
    }
    case "test": {
      const channel = (name ?? "email") as "desktop" | "email";
      const errors: string[] = [];
      const notifier = new ChannelNotifier(paths, new SystemNotifier(), (line) => {
        if (/failed|not set up|no email channel/.test(line)) errors.push(line);
      });
      await notifier.notify({ title: "Self-Starter test", body: "If you can read this, notifications work.", channels: [channel] });
      if (errors.length > 0) throw new Error(errors.join("; "));
      out(`Sent a test notification to ${channel}.`);
      return;
    }
    case "rm":
    case "remove":
      if (name !== "email") throw new UsageError("only the email channel can be removed");
      out(removeEmailChannel(paths) ? "Removed the email channel." : "No email channel was set up.");
      return;
    default:
      throw new UsageError("usage: self-starter channel list|email|default|test|rm");
  }
}

async function serviceCommand(action: string | undefined): Promise<void> {
  const manager = serviceManager();
  switch (action) {
    case "install": {
      if (manager.kind === "none") throw new Error("no launchd or systemd user session here; run `self-starter daemon` some other way");
      if (await isDaemonRunning(paths.socket)) {
        await callDaemon(paths.socket, "daemon.stop", {}, { via: "cli" }, 5000).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1000));
      }
      manager.install(serviceSpec(paths, loadConfig(paths).codexBin));
      out((await waitForDaemon(paths.socket, 10_000)) ? `Installed and started (${manager.file}).` : `Installed (${manager.file}), but the daemon did not answer yet; see self-starter logs.`);
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
    case "recipes": {
      const recipes = await daemonCall<Array<{ id: string; version: number; title: string; summary: string; secrets: Array<{ name: string }> }>>("recipe.list");
      if (recipes.length === 0) return out("No recipes.");
      for (const r of recipes) {
        out(`${r.id}  ${r.title}`);
        out(`  ${r.summary}`);
        if (r.secrets.length > 0) out(`  needs: ${r.secrets.map((x) => x.name).join(", ")} (self-starter secret set ...)`);
      }
      out("\nAsk Codex to set one up, for example: \"watch my IBKR account for unusual activity\".");
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
      await secretCommand(args);
      return;
    case "service":
      await serviceCommand(id);
      return;
    case "channel":
    case "channels":
      await channelCommand(args);
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
