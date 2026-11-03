// `self-starter secret ...` and `self-starter channel ...`: what the user sets up
// once, in a terminal or via `self-starter ui`, so keys, passwords and webhook URLs
// never pass through the chat.

import { BUILTIN_CHANNELS } from "../core/definition.js";
import {
  ChannelNotifier,
  channelSettings,
  composeEmail,
  readWebhookSecret,
  removeChannel,
  saveEmailChannel,
  saveWebhookChannel,
  sendEmail,
  setDefaultChannels,
} from "../engine/channels.js";
import { loadConfig, type EmailSettings, type WebhookProvider } from "../engine/config.js";
import { mailProviderFor, unsupportedSender } from "../engine/mail-providers.js";
import { SystemNotifier } from "../engine/notify.js";
import type { Paths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import { Store } from "../engine/store.js";
import {
  detectWebhookProvider,
  discoverTelegramChats,
  isWebhookProvider,
  PROVIDER_LABELS,
  sendWebhook,
  suggestChannelName,
} from "../engine/webhooks.js";
import { flag, need, out, readSecret, UsageError, type Args } from "./io.js";

export async function secretCommand(paths: Paths, args: Args): Promise<void> {
  const secrets = new Secrets(paths);
  const [, action, name] = args.positional;
  switch (action) {
    case "set": {
      const secretName = need(name, "secret name");
      const hostsFlag = args.flags.get("hosts");
      const hosts = typeof hostsFlag === "string" ? hostsFlag.split(",").map((h) => h.trim()).filter(Boolean) : "*";
      if (hosts !== "*" && hosts.length === 0) throw new UsageError("--hosts needs at least one host, such as --hosts api.example.com");
      const value = await readSecret(`Value for ${secretName}: `);
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

export async function channelCommand(paths: Paths, args: Args): Promise<void> {
  const [, action, name, rest] = args.positional;
  switch (action) {
    case "list":
    case undefined: {
      const settings = channelSettings(loadConfig(paths));
      out(`desktop   ${process.platform === "darwin" ? "macOS notifications" : "notify-send"}`);
      for (const [id, meta] of Object.entries(settings.webhooks ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const label = meta.label ? ` (${meta.label})` : "";
        out(`${id.padEnd(9)} ${PROVIDER_LABELS[meta.provider]}${label} → ${meta.hint}`);
      }
      out(settings.email ? `email     to ${settings.email.to} via ${settings.email.host}:${settings.email.port}` : "email     not set up (optional: self-starter channel email you@example.com)");
      out(`default   ${settings.default.join(", ")}`);
      return;
    }
    case "add":
    case "webhook":
      await setUpWebhook(paths, name, rest, args);
      return;
    case "telegram":
      await setUpTelegram(paths, name, args);
      return;
    case "email":
      await setUpEmail(paths, name, args);
      return;
    case "default": {
      const names = need(name, "channel names, such as desktop,feishu").split(",").map((n) => n.trim()).filter(Boolean);
      out(`Default channels: ${setDefaultChannels(paths, names).join(", ")}`);
      return;
    }
    case "test": {
      const settings = channelSettings(loadConfig(paths));
      const webhookNames = Object.keys(settings.webhooks ?? {}).sort();
      const valid = [...BUILTIN_CHANNELS, ...webhookNames];
      const channel = name ?? (webhookNames[0] ?? "email");
      if (!valid.includes(channel)) {
        throw new UsageError(`usage: self-starter channel test [${valid.join("|")}]`);
      }
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
    case "remove": {
      const target = need(name, "channel name");
      if (target === "desktop") throw new UsageError("the desktop channel is built in; change default channels instead");
      out(removeChannel(paths, target) ? `Removed channel ${target}.` : `No channel named ${target}.`);
      return;
    }
    default:
      throw new UsageError("usage: self-starter channel list|add|telegram|email|default|test|rm");
  }
}

async function setUpWebhook(paths: Paths, first: string | undefined, second: string | undefined, args: Args): Promise<void> {
  const isUrl = (v: string | undefined) => Boolean(v && /^https?:\/\//i.test(v.trim()));
  let id: string | undefined;
  let url: string | undefined;
  if (second) {
    id = first;
    url = second;
  } else if (isUrl(first)) {
    url = first;
  } else if (first) {
    id = first;
    url = await readSecret(`Webhook URL for ${first}: `);
  } else {
    throw new UsageError("usage: self-starter channel add [<name>] <webhook-url> [--provider feishu|wecom|dingtalk|slack|discord|bark|ntfy|webhook] [--secret] [--default]");
  }
  if (!url) throw new UsageError("missing webhook URL");

  const providerArg = flag(args, "provider");
  let provider: WebhookProvider;
  if (providerArg) {
    if (!isWebhookProvider(providerArg) || providerArg === "telegram") {
      throw new UsageError(`--provider must be feishu, wecom, dingtalk, slack, discord, bark, ntfy or webhook (for Telegram, use: self-starter channel telegram)`);
    }
    provider = providerArg;
  } else {
    provider = detectWebhookProvider(url);
  }

  const existing = Object.keys(channelSettings(loadConfig(paths)).webhooks ?? {});
  const channelId = id ?? suggestChannelName(provider, existing);
  const signingSecret = args.flags.has("secret") ? await readSecret(`Signing secret for ${channelId}: `) : undefined;

  new Store(paths).ensureLayout();
  const meta = saveWebhookChannel(paths, {
    id: channelId,
    provider,
    url,
    ...(flag(args, "label") ? { label: flag(args, "label")! } : {}),
    ...(signingSecret ? { signingSecret } : {}),
  });
  if (args.flags.has("default")) {
    setDefaultChannels(paths, [...new Set([...channelSettings(loadConfig(paths)).default, channelId])]);
  }
  if (args.flags.has("no-test")) {
    return out(`Saved channel "${channelId}" (${PROVIDER_LABELS[meta.provider]} → ${meta.hint}). Test it with: self-starter channel test ${channelId}`);
  }
  out(`Saved "${channelId}" (${PROVIDER_LABELS[meta.provider]} → ${meta.hint}). Sending a test notification...`);
  await sendWebhook(meta, readWebhookSecret(paths, channelId), {
    title: "Test notification",
    body: `Channel "${channelId}" works: triggers routed to ${channelId} will deliver here.`,
  });
  out(`Sent. Make it a default with: self-starter channel default desktop,${channelId}`);
}

async function setUpTelegram(paths: Paths, givenName: string | undefined, args: Args): Promise<void> {
  const existing = Object.keys(channelSettings(loadConfig(paths)).webhooks ?? {});
  const channelId = givenName ?? suggestChannelName("telegram", existing);
  const apiBaseUrl = flag(args, "api");
  const botToken = await readSecret("Telegram bot token (from @BotFather): ");
  if (!botToken.trim()) throw new UsageError("Telegram bot token is required");

  let chatId = flag(args, "chat");
  if (!chatId) {
    out("Checking recent messages to your bot to find your chat id...");
    const chats = await discoverTelegramChats(botToken, apiBaseUrl ? { apiBaseUrl } : {});
    if (chats.length === 0) {
      throw new Error("no recent chats found for this bot; send /start to your bot in Telegram first, or pass --chat <chat-id>");
    }
    chatId = chats[0]!.chatId;
    out(`Found ${chats[0]!.title} (chat ${chatId}).`);
  }

  new Store(paths).ensureLayout();
  const meta = saveWebhookChannel(paths, {
    id: channelId,
    provider: "telegram",
    botToken,
    chatId,
    ...(apiBaseUrl ? { url: apiBaseUrl } : {}),
    ...(flag(args, "label") ? { label: flag(args, "label")! } : {}),
  });
  if (args.flags.has("default")) {
    setDefaultChannels(paths, [...new Set([...channelSettings(loadConfig(paths)).default, channelId])]);
  }
  if (args.flags.has("no-test")) {
    return out(`Saved channel "${channelId}" (${meta.hint}).`);
  }
  out(`Saved "${channelId}" (${meta.hint}). Sending a test message...`);
  await sendWebhook(meta, readWebhookSecret(paths, channelId), {
    title: "Test notification",
    body: `Channel "${channelId}" works: triggers routed to ${channelId} will deliver here.`,
  });
  out(`Sent. Make it a default with: self-starter channel default desktop,${channelId}`);
}

/**
 * `self-starter channel email you@gmail.com`: the mailbox sends notifications to
 * itself (or to --to) through its provider's server, with an app password. Any
 * other server works with --host, --port and --starttls.
 */
async function setUpEmail(paths: Paths, address: string | undefined, args: Args): Promise<void> {
  const sender = address ?? flag(args, "user");
  const host = flag(args, "host");
  const provider = sender && !host ? mailProviderFor(sender) : undefined;
  if (!host && !provider) {
    if (!sender) throw new UsageError("usage: self-starter channel email <your address> [--to <address>]");
    throw new UsageError(unsupportedSender(sender) ?? `there is no preset for ${sender}; give its SMTP server with --host (and --port, --starttls)`);
  }
  const secure = provider ? provider.secure : !args.flags.has("starttls");
  const port = flag(args, "port");
  const from = flag(args, "from") ?? sender;
  const settings: EmailSettings = {
    to: need(flag(args, "to") ?? sender, "--to <address>"),
    host: provider?.host ?? host!,
    port: port ? Number(port) : (provider?.port ?? (secure ? 465 : 587)),
    secure,
    ...(sender ? { user: sender } : {}),
    ...(from ? { from } : {}),
  };

  let password: string | undefined;
  if (settings.user) {
    if (provider) out(`${provider.name}: ${provider.howToGetPassword}.`);
    password = await readSecret(`App password for ${settings.user}: `);
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
  out("Sent. Ask your agent to email you about a trigger, or make email a default: self-starter channel default desktop,email");
}
