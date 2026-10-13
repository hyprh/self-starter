// Where notifications go: the desktop (system notifications) and, once set up, email.
//
// Email settings live in config.json; the SMTP password lives in its own file,
// channel-secrets.json (0600), which is never given to probes: probe secrets are a
// different store, released only to probes that declare them.

import { hostname } from "node:os";
import nodemailer from "nodemailer";
import { CHANNELS, type Channel } from "../core/definition.js";
import { loadConfig, saveConfig, type Config, type EmailSettings } from "./config.js";
import { readJson, writeJsonAtomic } from "./fs-util.js";
import type { Notification, Notifier } from "./notify.js";
import type { Paths } from "./paths.js";

export interface ChannelSettings {
  /** Channels for triggers that do not choose their own. */
  default: Channel[];
  email?: EmailSettings;
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;

export function channelSettings(config: Config): ChannelSettings {
  return { default: config.channels?.default ?? ["desktop"], ...(config.channels?.email ? { email: config.channels.email } : {}) };
}

function readPassword(paths: Paths): string | undefined {
  return readJson<{ email?: { password?: string } }>(paths.channelSecrets)?.email?.password;
}

export function saveEmailChannel(paths: Paths, settings: EmailSettings, password: string | undefined): void {
  if (!EMAIL_PATTERN.test(settings.to)) throw new Error(`not an email address: ${settings.to}`);
  if (!settings.host) throw new Error("the SMTP host is required");
  if (!Number.isInteger(settings.port) || settings.port <= 0 || settings.port > 65535) throw new Error(`invalid SMTP port: ${settings.port}`);
  const config = loadConfig(paths);
  config.channels = { ...channelSettings(config), email: settings };
  saveConfig(paths, config);
  writeJsonAtomic(paths.channelSecrets, password ? { email: { password } } : {});
}

export function removeEmailChannel(paths: Paths): boolean {
  const config = loadConfig(paths);
  if (!config.channels?.email) return false;
  const settings = channelSettings(config);
  delete settings.email;
  settings.default = settings.default.filter((name) => name !== "email");
  if (settings.default.length === 0) settings.default = ["desktop"];
  config.channels = settings;
  saveConfig(paths, config);
  writeJsonAtomic(paths.channelSecrets, {});
  return true;
}

export function setDefaultChannels(paths: Paths, names: string[]): Channel[] {
  const unknown = names.filter((name) => !CHANNELS.includes(name as Channel));
  if (unknown.length > 0 || names.length === 0) throw new Error(`channels must be some of: ${CHANNELS.join(", ")}`);
  const config = loadConfig(paths);
  const settings = channelSettings(config);
  if (names.includes("email") && !settings.email) throw new Error("set up email first: self-starter channel email you@example.com");
  settings.default = [...new Set(names)] as Channel[];
  config.channels = settings;
  saveConfig(paths, config);
  return settings.default;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** The email for a notification: a subject people can scan (and filter on), and how to get to the thread. */
export function composeEmail(notification: Notification): { subject: string; text: string } {
  const firstLine = notification.body.split("\n")[0] ?? "";
  const subject = `[Self-Starter] ${notification.title}: ${firstLine}`.slice(0, 160);
  const lines = [notification.body, ""];
  if (notification.threadId) {
    lines.push(`Open the thread in Codex: codex://threads/${notification.threadId}`, `Or in a terminal: codex resume ${notification.threadId}`, "");
  }
  lines.push(`Sent by Self-Starter on ${hostname()}.`);
  return { subject, text: lines.join("\n") };
}

export async function sendEmail(settings: EmailSettings, password: string | undefined, message: { subject: string; text: string }): Promise<void> {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure && Boolean(settings.user) && !isLocalHost(settings.host),
    ...(settings.user ? { auth: { user: settings.user, pass: password ?? "" } } : {}),
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: settings.from || settings.user || settings.to, to: settings.to, subject: message.subject, text: message.text });
  } finally {
    transport.close();
  }
}

/**
 * Sends each notification to its channels: the ones the trigger chose, or the
 * default. Settings are read for every notification, so `self-starter channel` changes
 * apply without restarting the daemon. Failures are logged, never thrown.
 */
export class ChannelNotifier implements Notifier {
  constructor(
    private readonly paths: Paths,
    private readonly desktop: Notifier,
    private readonly log: (line: string) => void = () => {},
    private readonly send: typeof sendEmail = sendEmail,
  ) {}

  async notify(notification: Notification): Promise<void> {
    const settings = channelSettings(loadConfig(this.paths));
    const channels = notification.channels ?? settings.default;
    for (const channel of new Set(channels)) {
      try {
        if (channel === "desktop") {
          await this.desktop.notify(notification);
        } else if (channel === "email") {
          if (!settings.email) {
            this.log(`email requested for "${notification.title}" but no email channel is set up (self-starter channel email)`);
            continue;
          }
          await this.send(settings.email, readPassword(this.paths), composeEmail(notification));
          this.log(`email sent to ${settings.email.to}: ${notification.title}`);
        }
      } catch (error) {
        this.log(`${channel} notification failed: ${(error as Error).message}`);
      }
    }
  }
}
