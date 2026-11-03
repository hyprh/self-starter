// Where notifications go: the desktop (system notifications), webhook/push channels
// (Feishu/Lark, WeCom, DingTalk, Slack, Discord, Telegram, Bark, ntfy, custom HTTP),
// and, once set up, email.
//
// Display metadata lives in config.json; SMTP passwords, webhook capability URLs and
// bot tokens live in their own file, channel-secrets.json (0600), which is never given
// to probes: probe secrets are a different store, released only to probes that declare them.

import { hostname } from "node:os";
import nodemailer from "nodemailer";
import { reopen } from "../core/conversations.js";
import { BUILTIN_CHANNELS, isChannelName, type Channel } from "../core/definition.js";
import { loadConfig, saveConfig, type Config, type EmailSettings, type WebhookChannelMeta, type WebhookProvider } from "./config.js";
import { readJson, writeJsonAtomic } from "./fs-util.js";
import type { Notification, Notifier } from "./notify.js";
import type { Paths } from "./paths.js";
import {
  detectWebhookProvider,
  isWebhookProvider,
  maskWebhookHint,
  parseWebhookUrl,
  sendWebhook,
  type WebhookSecret,
} from "./webhooks.js";

export interface ChannelSettings {
  /** Channels for triggers that do not choose their own. */
  default: Channel[];
  email?: EmailSettings;
  webhooks?: Record<string, WebhookChannelMeta>;
}

interface ChannelSecretsFile {
  email?: { password?: string };
  webhooks?: Record<string, WebhookSecret>;
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;

export function channelSettings(config: Config): ChannelSettings {
  const webhooks = config.channels?.webhooks && Object.keys(config.channels.webhooks).length > 0 ? { ...config.channels.webhooks } : undefined;
  return {
    default: config.channels?.default ?? ["desktop"],
    ...(config.channels?.email ? { email: config.channels.email } : {}),
    ...(webhooks ? { webhooks } : {}),
  };
}

/** Names of all channels currently ready to receive notifications. */
export function configuredChannels(config: Config): Channel[] {
  const settings = channelSettings(config);
  const out: Channel[] = ["desktop"];
  if (settings.email) out.push("email");
  for (const name of Object.keys(settings.webhooks ?? {}).sort()) out.push(name);
  return out;
}

function readChannelSecrets(paths: Paths): ChannelSecretsFile {
  return readJson<ChannelSecretsFile>(paths.channelSecrets) ?? {};
}

function writeChannelSecrets(paths: Paths, secrets: ChannelSecretsFile): void {
  const next: ChannelSecretsFile = {};
  if (secrets.email?.password) next.email = { password: secrets.email.password };
  if (secrets.webhooks && Object.keys(secrets.webhooks).length > 0) next.webhooks = secrets.webhooks;
  writeJsonAtomic(paths.channelSecrets, next);
}

function readPassword(paths: Paths): string | undefined {
  return readChannelSecrets(paths).email?.password;
}

export function readWebhookSecret(paths: Paths, id: string): WebhookSecret | undefined {
  return readChannelSecrets(paths).webhooks?.[id];
}

export function saveEmailChannel(paths: Paths, settings: EmailSettings, password: string | undefined): void {
  if (!EMAIL_PATTERN.test(settings.to)) throw new Error(`not an email address: ${settings.to}`);
  if (!settings.host) throw new Error("the SMTP host is required");
  if (!Number.isInteger(settings.port) || settings.port <= 0 || settings.port > 65535) throw new Error(`invalid SMTP port: ${settings.port}`);
  const config = loadConfig(paths);
  config.channels = { ...channelSettings(config), email: settings };
  saveConfig(paths, config);
  const secrets = readChannelSecrets(paths);
  if (password) secrets.email = { password };
  else delete secrets.email;
  writeChannelSecrets(paths, secrets);
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
  const secrets = readChannelSecrets(paths);
  delete secrets.email;
  writeChannelSecrets(paths, secrets);
  return true;
}

export interface SaveWebhookInput {
  id: string;
  provider?: WebhookProvider;
  label?: string;
  url?: string;
  botToken?: string;
  chatId?: string;
  signingSecret?: string;
  headers?: Record<string, string>;
}

/** Validates and stores a named webhook/push channel, splitting metadata (config.json) from secrets (channel-secrets.json). */
export function saveWebhookChannel(paths: Paths, input: SaveWebhookInput): WebhookChannelMeta {
  const id = input.id.trim();
  if (!isChannelName(id)) {
    throw new Error(`invalid channel name "${id}" (use lower-case letters, digits, - or _, 2-32 chars)`);
  }
  if ((BUILTIN_CHANNELS as readonly string[]).includes(id)) {
    throw new Error(`"${id}" is a built-in channel name; pick another name such as "feishu" or "webhook"`);
  }

  const existingSecrets = readWebhookSecret(paths, id);
  const url = input.url?.trim() || existingSecrets?.url;
  const provider: WebhookProvider = input.provider ?? (input.botToken ? "telegram" : url ? detectWebhookProvider(url) : "webhook");
  if (!isWebhookProvider(provider)) throw new Error(`unknown webhook provider: ${String(provider)}`);

  let hint: string;
  const secret: WebhookSecret = {};
  const meta: WebhookChannelMeta = { provider, hint: "" };
  if (input.label?.trim()) meta.label = input.label.trim().slice(0, 80);

  if (provider === "telegram") {
    const botToken = input.botToken?.trim() || existingSecrets?.botToken;
    const chatId = input.chatId?.trim();
    if (!botToken) throw new Error("Telegram bot token is required");
    if (!chatId) throw new Error("Telegram chat id is required");
    secret.botToken = botToken;
    if (url) {
      parseWebhookUrl(url);
      secret.url = url;
    }
    meta.chatId = chatId;
    hint = `Telegram chat ${chatId}`;
  } else {
    if (!url) throw new Error(`URL is required for ${provider} channel`);
    parseWebhookUrl(url);
    secret.url = url;
    hint = maskWebhookHint(url);
    const signingSecret = input.signingSecret !== undefined ? input.signingSecret.trim() : existingSecrets?.signingSecret;
    if (signingSecret) {
      secret.signingSecret = signingSecret;
      meta.hasSigningSecret = true;
    }
    const headers = input.headers ?? existingSecrets?.headers;
    if (headers && Object.keys(headers).length > 0) {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        const key = k.trim();
        if (!key || /[\r\n:]/.test(key)) throw new Error(`invalid header name: ${k}`);
        if (/[\r\n]/.test(v)) throw new Error(`invalid value for header ${key}`);
        cleaned[key] = v;
      }
      secret.headers = cleaned;
      meta.headerNames = Object.keys(cleaned);
    }
  }
  meta.hint = hint;

  const config = loadConfig(paths);
  const settings = channelSettings(config);
  settings.webhooks = { ...(settings.webhooks ?? {}), [id]: meta };
  config.channels = settings;
  saveConfig(paths, config);

  const secrets = readChannelSecrets(paths);
  secrets.webhooks = { ...(secrets.webhooks ?? {}), [id]: secret };
  writeChannelSecrets(paths, secrets);
  return meta;
}

export function removeWebhookChannel(paths: Paths, id: string): boolean {
  const config = loadConfig(paths);
  if (!config.channels?.webhooks?.[id]) return false;
  const settings = channelSettings(config);
  if (settings.webhooks) {
    delete settings.webhooks[id];
    if (Object.keys(settings.webhooks).length === 0) delete settings.webhooks;
  }
  settings.default = settings.default.filter((name) => name !== id);
  if (settings.default.length === 0) settings.default = ["desktop"];
  config.channels = settings;
  saveConfig(paths, config);

  const secrets = readChannelSecrets(paths);
  if (secrets.webhooks) {
    delete secrets.webhooks[id];
    if (Object.keys(secrets.webhooks).length === 0) delete secrets.webhooks;
  }
  writeChannelSecrets(paths, secrets);
  return true;
}

export function removeChannel(paths: Paths, id: string): boolean {
  if (id === "email") return removeEmailChannel(paths);
  if (id === "desktop") throw new Error("the desktop channel is built in; change default channels instead");
  return removeWebhookChannel(paths, id);
}

export function setDefaultChannels(paths: Paths, names: string[]): Channel[] {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (cleaned.length === 0 || !cleaned.every(isChannelName)) {
    throw new Error("channels must be non-empty channel names such as desktop, email or feishu");
  }
  const config = loadConfig(paths);
  const settings = channelSettings(config);
  for (const name of cleaned) {
    if (name === "desktop") continue;
    if (name === "email") {
      if (!settings.email) throw new Error("set up email first: self-starter channel email you@example.com");
      continue;
    }
    if (!settings.webhooks?.[name]) {
      throw new Error(`no channel named "${name}"; add it first with self-starter channel add ${name} <url> (or self-starter ui)`);
    }
  }
  settings.default = cleaned;
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
    const link = reopen(notification.threadId);
    if (link.url) lines.push(`Open the thread in Codex: ${link.url}`, `Or in a terminal: ${link.command}`, "");
    else lines.push(`Open the session in a terminal: ${link.command}`, "");
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
 * default. Settings are read for every notification, so `self-starter channel` and UI
 * changes apply without restarting the daemon. Failures are logged, never thrown.
 */
export class ChannelNotifier implements Notifier {
  constructor(
    private readonly paths: Paths,
    private readonly desktop: Notifier,
    private readonly log: (line: string) => void = () => {},
    private readonly send: typeof sendEmail = sendEmail,
    private readonly sendHook: typeof sendWebhook = sendWebhook,
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
        } else {
          const meta = settings.webhooks?.[channel];
          if (!meta) {
            this.log(`channel "${channel}" requested for "${notification.title}" but is not set up (self-starter channel add ${channel} <url>)`);
            continue;
          }
          await this.sendHook(meta, readWebhookSecret(this.paths, channel), notification);
          this.log(`${channel} (${meta.provider}) notification sent: ${notification.title}`);
        }
      } catch (error) {
        this.log(`${channel} notification failed: ${(error as Error).message}`);
      }
    }
  }
}
