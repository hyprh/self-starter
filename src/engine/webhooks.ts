// Outbound webhook and push adapters (Feishu/Lark, WeCom, DingTalk, Slack, Discord,
// Telegram, Bark, ntfy, and generic JSON webhooks). Zero external dependencies:
// uses Node's built-in fetch and crypto, and keeps capability URLs and tokens out
// of config.json and error logs.

import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import { reopen } from "../core/conversations.js";
import { isRecord } from "../core/patch.js";
import type { WebhookChannelMeta, WebhookProvider } from "./config.js";
import type { Notification } from "./notify.js";

export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = [
  "feishu",
  "wecom",
  "dingtalk",
  "slack",
  "discord",
  "telegram",
  "bark",
  "ntfy",
  "webhook",
] as const;

export const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  feishu: "Feishu / Lark",
  wecom: "WeCom (企业微信)",
  dingtalk: "DingTalk (钉钉)",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram Bot",
  bark: "Bark (iOS)",
  ntfy: "ntfy",
  webhook: "Webhook",
};

export interface WebhookSecret {
  /** Destination webhook or push URL (or custom API base URL for Telegram). */
  url?: string;
  /** Telegram Bot token from @BotFather. */
  botToken?: string;
  /** Optional HMAC-SHA256 signing secret (Feishu / DingTalk). */
  signingSecret?: string;
  /** Optional custom HTTP headers for generic webhooks (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface TelegramChatCandidate {
  chatId: string;
  title: string;
  type: string;
  username?: string;
}

export interface SendWebhookOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === "string" && (WEBHOOK_PROVIDERS as readonly string[]).includes(value);
}

/** Validates an http(s) URL without embedded credentials. */
export function parseWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("not a valid URL (expected https://...)");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported URL protocol ${parsed.protocol} (expected https:// or http://)`);
  }
  if (!parsed.hostname) throw new Error("the URL has no host");
  if (parsed.username || parsed.password) {
    throw new Error("do not embed username or password in the URL; use custom headers instead");
  }
  return parsed;
}

/** Infers the push provider from a pasted webhook URL. */
export function detectWebhookProvider(rawUrl: string): WebhookProvider {
  const parsed = parseWebhookUrl(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (host === "open.feishu.cn" || host === "open.larksuite.com" || ((host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com")) && path.includes("/bot/v2/hook/"))) {
    return "feishu";
  }
  if (host === "qyapi.weixin.qq.com") return "wecom";
  if (host === "oapi.dingtalk.com" || host === "api.dingtalk.com") return "dingtalk";
  if (host === "hooks.slack.com") return "slack";
  if ((host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) && path.includes("/api/webhooks/")) {
    return "discord";
  }
  if (host === "api.day.app") return "bark";
  if (host === "ntfy.sh") return "ntfy";
  if (host === "api.telegram.org") return "telegram";
  return "webhook";
}

/** Suggests a clean channel slug (such as "feishu" or "feishu-2") not yet in `existing`. */
export function suggestChannelName(provider: WebhookProvider, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = provider;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Non-secret destination summary safe for config.json, CLI output and the web UI. */
export function maskWebhookHint(rawUrl: string): string {
  const parsed = parseWebhookUrl(rawUrl);
  const tokenParam = parsed.searchParams.get("key") ?? parsed.searchParams.get("access_token") ?? parsed.searchParams.get("token");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const tailSource = tokenParam ?? segments.at(-1) ?? "";
  const alnum = tailSource.replace(/[^A-Za-z0-9]/g, "");
  return alnum.length >= 6 ? `${parsed.host} (…${alnum.slice(-4)})` : parsed.host;
}

function formatBodyWithReopen(notification: Notification): { text: string; lines: string[]; link?: { command: string; url?: string } } {
  const link = notification.threadId ? reopen(notification.threadId) : undefined;
  const lines = [notification.body];
  if (link) {
    lines.push("");
    if (link.url) lines.push(`Open thread: ${link.url}`);
    lines.push(`Resume in terminal: ${link.command}`);
  }
  return { text: lines.join("\n"), lines, ...(link ? { link } : {}) };
}

/** Encodes an HTTP header value using RFC 2047 when it contains non-ASCII characters (for ntfy titles). */
function encodeHeaderTitle(title: string): string {
  const singleLine = title.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(singleLine)) return singleLine;
  return `=?UTF-8?B?${Buffer.from(singleLine, "utf8").toString("base64")}?=`;
}

export function signFeishu(timestampSec: string, secret: string): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

export function signDingTalk(timestampMs: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}\n${secret}`).digest("base64");
}

function redactSecrets(text: string, secret: WebhookSecret): string {
  let out = text;
  const sensitive = [
    secret.url,
    secret.botToken,
    secret.signingSecret,
    ...Object.values(secret.headers ?? {}),
  ].filter((v): v is string => typeof v === "string" && v.length >= 4);
  for (const item of sensitive) {
    out = out.split(item).join("[redacted]");
  }
  if (secret.url) {
    try {
      const parsed = new URL(secret.url);
      for (const [, val] of parsed.searchParams) {
        if (val.length >= 6) out = out.split(val).join("[redacted]");
      }
      const lastSeg = parsed.pathname.split("/").filter(Boolean).at(-1);
      if (lastSeg && lastSeg.length >= 12) out = out.split(lastSeg).join("[redacted]");
    } catch {
      // ignore invalid URL
    }
  }
  return out;
}

function trimSnippet(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

function checkProviderJson(provider: WebhookProvider, bodyText: string): void {
  if (!bodyText.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (provider === "feishu" && typeof parsed.code === "number" && parsed.code !== 0) {
    throw new Error(`Feishu error ${parsed.code}: ${String(parsed.msg ?? "rejected")}`);
  }
  if ((provider === "wecom" || provider === "dingtalk") && typeof parsed.errcode === "number" && parsed.errcode !== 0) {
    throw new Error(`${PROVIDER_LABELS[provider]} error ${parsed.errcode}: ${String(parsed.errmsg ?? "rejected")}`);
  }
  if (provider === "telegram" && parsed.ok === false) {
    throw new Error(`Telegram error: ${String(parsed.description ?? "rejected")}`);
  }
  if (provider === "bark" && typeof parsed.code === "number" && parsed.code !== 200) {
    throw new Error(`Bark error ${parsed.code}: ${String(parsed.message ?? "rejected")}`);
  }
}

/** Sends one notification through a configured webhook/push channel. */
export async function sendWebhook(
  meta: WebhookChannelMeta,
  secret: WebhookSecret | undefined,
  notification: Notification,
  options: SendWebhookOptions = {},
): Promise<void> {
  if (!secret) throw new Error(`missing credentials for ${meta.provider} channel`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now?.() ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { text, lines, link } = formatBodyWithReopen(notification);
  const fullTitle = `[Self-Starter] ${notification.title}`;

  let targetUrl: string;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  let body: string;

  switch (meta.provider) {
    case "telegram": {
      if (!secret.botToken) throw new Error("missing Telegram bot token");
      if (!meta.chatId) throw new Error("missing Telegram chat id");
      const base = (secret.url ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
      targetUrl = `${base}/bot${secret.botToken}/sendMessage`;
      body = JSON.stringify({
        chat_id: meta.chatId,
        text: `${fullTitle}\n\n${text}`,
        disable_web_page_preview: true,
      });
      break;
    }
    case "feishu": {
      if (!secret.url) throw new Error("missing Feishu webhook URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      const payload: Record<string, unknown> = {
        msg_type: "post",
        content: {
          post: {
            zh_cn: {
              title: fullTitle,
              content: lines.map((line) => [{ tag: "text", text: line || " " }]),
            },
          },
        },
      };
      if (secret.signingSecret) {
        const timestamp = String(Math.floor(now.getTime() / 1000));
        payload.timestamp = timestamp;
        payload.sign = signFeishu(timestamp, secret.signingSecret);
      }
      body = JSON.stringify(payload);
      break;
    }
    case "wecom": {
      if (!secret.url) throw new Error("missing WeCom webhook URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      body = JSON.stringify({
        msgtype: "markdown",
        markdown: { content: `**${fullTitle}**\n${text}` },
      });
      break;
    }
    case "dingtalk": {
      if (!secret.url) throw new Error("missing DingTalk webhook URL");
      const parsed = parseWebhookUrl(secret.url);
      if (secret.signingSecret) {
        const timestamp = String(now.getTime());
        parsed.searchParams.set("timestamp", timestamp);
        parsed.searchParams.set("sign", signDingTalk(timestamp, secret.signingSecret));
      }
      targetUrl = parsed.toString();
      body = JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: fullTitle,
          text: `### ${fullTitle}\n\n${lines.join("\n\n")}`,
        },
      });
      break;
    }
    case "slack": {
      if (!secret.url) throw new Error("missing Slack webhook URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      body = JSON.stringify({ text: `*${fullTitle}*\n${text}` });
      break;
    }
    case "discord": {
      if (!secret.url) throw new Error("missing Discord webhook URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      body = JSON.stringify({
        embeds: [
          {
            title: fullTitle.slice(0, 256),
            description: text.slice(0, 4000),
            footer: { text: `Self-Starter on ${hostname()}` },
          },
        ],
      });
      break;
    }
    case "bark": {
      if (!secret.url) throw new Error("missing Bark URL");
      const parsed = parseWebhookUrl(secret.url);
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      targetUrl = parsed.toString();
      body = JSON.stringify({
        title: fullTitle,
        body: text,
        group: "Self-Starter",
        ...(link?.url ? { url: link.url } : {}),
      });
      break;
    }
    case "ntfy": {
      if (!secret.url) throw new Error("missing ntfy topic URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      headers["Content-Type"] = "text/plain; charset=utf-8";
      headers.Title = encodeHeaderTitle(fullTitle);
      if (link?.url && /^https?:\/\//i.test(link.url)) headers.Click = link.url;
      for (const [k, v] of Object.entries(secret.headers ?? {})) headers[k] = v;
      body = text;
      break;
    }
    case "webhook": {
      if (!secret.url) throw new Error("missing webhook URL");
      targetUrl = parseWebhookUrl(secret.url).toString();
      for (const [k, v] of Object.entries(secret.headers ?? {})) headers[k] = v;
      body = JSON.stringify({
        source: "self-starter",
        version: 1,
        sentAt: now.toISOString(),
        hostname: hostname(),
        title: notification.title,
        body: notification.body,
        ...(notification.triggerId ? { triggerId: notification.triggerId } : {}),
        ...(notification.fireId ? { fireId: notification.fireId } : {}),
        ...(notification.threadId ? { threadId: notification.threadId } : {}),
        ...(link ? { reopen: link } : {}),
      });
      break;
    }
  }

  try {
    const response = await fetchImpl(targetUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const detail = trimSnippet(responseText);
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    checkProviderJson(meta.provider, responseText);
  } catch (error) {
    throw new Error(redactSecrets((error as Error).message, secret));
  }
}

/** Queries Telegram getUpdates so the user can pick their chat id without looking it up by hand. */
export async function discoverTelegramChats(
  botToken: string,
  options: { apiBaseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TelegramChatCandidate[]> {
  const token = botToken.trim();
  if (!token) throw new Error("Telegram bot token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.apiBaseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
  const url = `${base}/bot${token}/getUpdates?limit=25`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${response.status}: invalid JSON from Telegram`);
    }
    if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.result)) {
      const desc = isRecord(parsed) && typeof parsed.description === "string" ? parsed.description : `HTTP ${response.status}`;
      throw new Error(`Telegram getUpdates failed: ${desc}`);
    }
    const seen = new Map<string, TelegramChatCandidate>();
    for (let i = parsed.result.length - 1; i >= 0; i--) {
      const update = parsed.result[i];
      if (!isRecord(update)) continue;
      for (const field of ["message", "edited_message", "channel_post", "my_chat_member"] as const) {
        const container = update[field];
        const chat = isRecord(container) && isRecord(container.chat) ? container.chat : undefined;
        if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) continue;
        const chatId = String(chat.id);
        if (seen.has(chatId)) continue;
        const nameParts = [chat.title, chat.first_name, chat.last_name].filter((x): x is string => typeof x === "string" && x.trim() !== "");
        const username = typeof chat.username === "string" && chat.username ? chat.username : undefined;
        const title = nameParts.join(" ") || (username ? `@${username}` : `Chat ${chatId}`);
        seen.set(chatId, {
          chatId,
          title,
          type: typeof chat.type === "string" ? chat.type : "private",
          ...(username ? { username } : {}),
        });
      }
    }
    return [...seen.values()];
  } catch (error) {
    throw new Error(redactSecrets((error as Error).message, { botToken: token, ...(options.apiBaseUrl ? { url: options.apiBaseUrl } : {}) }));
  }
}
