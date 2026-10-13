// `self-starter secret ...` and `self-starter channel ...`: what the user sets up
// once, in a terminal, so that keys and passwords never pass through the chat.

import { CHANNELS, type Channel } from "../core/definition.js";
import {
  ChannelNotifier,
  channelSettings,
  composeEmail,
  removeEmailChannel,
  saveEmailChannel,
  sendEmail,
  setDefaultChannels,
} from "../engine/channels.js";
import { loadConfig, type EmailSettings } from "../engine/config.js";
import { mailProviderFor, unsupportedSender } from "../engine/mail-providers.js";
import { SystemNotifier } from "../engine/notify.js";
import type { Paths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import { Store } from "../engine/store.js";
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
      await setUpEmail(paths, name, args);
      return;
    case "default": {
      const names = need(name, "channel names, such as desktop,email").split(",").map((n) => n.trim()).filter(Boolean);
      out(`Default channels: ${setDefaultChannels(paths, names).join(", ")}`);
      return;
    }
    case "test": {
      const channel = (name ?? "email") as Channel;
      if (!CHANNELS.includes(channel)) throw new UsageError(`usage: self-starter channel test [${CHANNELS.join("|")}]`);
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
