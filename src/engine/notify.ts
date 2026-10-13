// System notifications: terminal-notifier or osascript on macOS, notify-send on Linux.

import { spawn } from "node:child_process";
import { which } from "./config.js";

export interface Notification {
  title: string;
  body: string;
  /** Thread to open when the notification is clicked (where supported). */
  threadId?: string;
  /** Where to send it; the configured default when left out. */
  channels?: Array<"desktop" | "email">;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

function runQuietly(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Quotes a string for AppleScript. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class SystemNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async notify({ title, body, threadId }: Notification): Promise<void> {
    const hint = threadId ? `\nOpen with: codex resume ${threadId}` : "";
    let delivered = false;

    if (process.platform === "darwin") {
      const terminalNotifier = which("terminal-notifier");
      if (terminalNotifier) {
        const args = ["-title", title, "-message", body, "-group", "self-starter"];
        if (threadId) args.push("-open", `codex://threads/${threadId}`);
        delivered = await runQuietly(terminalNotifier, args);
      }
      if (!delivered) {
        const script = `display notification ${appleScriptString(body + hint)} with title ${appleScriptString(title)}`;
        delivered = await runQuietly("osascript", ["-e", script]);
      }
    } else {
      const notifySend = which("notify-send");
      if (notifySend) delivered = await runQuietly(notifySend, ["--app-name=Self-Starter", title, body + hint]);
    }

    if (!delivered) throw new Error(`no notifier available for "${title}" (${process.platform === "darwin" ? "install terminal-notifier" : "install notify-send, from libnotify"})`);
    this.log(`notification: ${title}: ${body}`);
  }
}
