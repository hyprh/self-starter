import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  ChannelNotifier,
  composeEmail,
  removeEmailChannel,
  saveEmailChannel,
  setDefaultChannels,
} from "../../src/engine/channels.js";
import { loadConfig } from "../../src/engine/config.js";
import { RecordingNotifier, tempHome } from "./fixtures.js";

const CLI = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

/** Just enough SMTP to accept a message: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
class FakeSmtp {
  messages: Array<{ auth?: string; from?: string; to: string[]; data: string }> = [];
  port = 0;
  private server: Server = createServer((socket) => this.session(socket));

  private session(socket: Socket): void {
    let buffer = "";
    let inData = false;
    let current: { auth?: string; from?: string; to: string[]; data: string } = { to: [], data: "" };
    socket.write("220 fake ESMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        if (inData) {
          if (line === ".") {
            inData = false;
            this.messages.push(current);
            current = { to: [], data: "" };
            socket.write("250 2.0.0 queued\r\n");
          } else {
            current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-fake\r\n250-AUTH PLAIN\r\n250 OK\r\n");
        else if (verb === "AUTH") {
          current.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          socket.write("235 2.7.0 accepted\r\n");
        } else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          current.to.push(line);
          socket.write("250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => socket.destroy());
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe("notification channels", () => {
  const smtp = new FakeSmtp();
  let home: ReturnType<typeof tempHome>;
  before(async () => {
    await smtp.start();
    home = tempHome();
  });
  after(async () => {
    await smtp.close();
    home.cleanup();
  });

  it("writes emails people can scan, with the way back to the thread", () => {
    const email = composeEmail({ title: "IBKR account watch", body: "Withdrawal of 5,000 USD (U1234567)\nmore", threadId: "thread-9" });
    assert.equal(email.subject, "[Self-Starter] IBKR account watch: Withdrawal of 5,000 USD (U1234567)");
    assert.match(email.text, /codex:\/\/threads\/thread-9/);
    assert.match(email.text, /codex resume thread-9/);
  });

  it("sends to the channels a notification asks for, and to the default otherwise", async () => {
    const desktop = new RecordingNotifier();
    const logs: string[] = [];
    const notifier = new ChannelNotifier(home.paths, desktop, (line) => logs.push(line));

    await notifier.notify({ title: "T", body: "no email yet", channels: ["email"] });
    assert.match(logs.join("\n"), /no email channel is set up/);
    assert.throws(() => setDefaultChannels(home.paths, ["email"]), /set up email first/);

    saveEmailChannel(home.paths, { to: "me@example.com", host: "127.0.0.1", port: smtp.port, secure: false, user: "me@example.com" }, "app-password");
    assert.equal(statSync(home.paths.channelSecrets).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(home.paths.config, "utf8"), /app-password/, "the password stays out of config.json");

    await notifier.notify({ title: "IBKR account watch", body: "Withdrawal of 5,000 USD", threadId: "thread-1", channels: ["email"] });
    assert.equal(smtp.messages.length, 1);
    const message = smtp.messages[0]!;
    assert.equal(message.auth, "\u0000me@example.com\u0000app-password");
    assert.match(message.to[0]!, /me@example\.com/);
    assert.match(message.data, /Subject: \[Self-Starter\] IBKR account watch: Withdrawal of 5,000 USD/);
    assert.match(message.data, /codex resume thread-1/);
    assert.equal(desktop.sent.length, 0, "email only");

    await notifier.notify({ title: "Default", body: "goes to the desktop" });
    assert.equal(desktop.sent.length, 1);
    assert.equal(smtp.messages.length, 1);

    assert.deepEqual(setDefaultChannels(home.paths, ["desktop", "email"]), ["desktop", "email"]);
    await notifier.notify({ title: "Both", body: "everywhere" });
    assert.equal(desktop.sent.length, 2);
    assert.equal(smtp.messages.length, 2);

    assert.equal(removeEmailChannel(home.paths), true);
    assert.deepEqual(loadConfig(home.paths).channels?.default, ["desktop"]);
  });

  it("sets up email from an address and an app password, and sends a test email", async () => {
    // Asynchronous, so that the fake SMTP server in this process can answer the CLI.
    const setUp = (...args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, "channel", "email", ...args], {
          env: { ...process.env, SELF_STARTER_HOME: home.paths.home },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end("app-password\n");
      });
    const before = smtp.messages.length;
    const done = await setUp("me@example.org", "--host", "127.0.0.1", "--port", String(smtp.port), "--starttls");
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /Sent\./);
    const message = smtp.messages[before]!;
    assert.equal(message.auth, "\u0000me@example.org\u0000app-password");
    assert.match(message.to[0]!, /me@example\.org/, "it sends to the same mailbox unless --to says otherwise");
    assert.match(message.data, /Subject: \[Self-Starter\] Test email: Email works/);

    const outlook = await setUp("me@outlook.com");
    assert.notEqual(outlook.status, 0);
    assert.match(outlook.stderr, /requires OAuth/);
    const unknown = await setUp("me@example.org");
    assert.match(unknown.stderr, /no preset for me@example\.org; give its SMTP server with --host/);
  });

  it("logs a failed delivery instead of throwing", async () => {
    const logs: string[] = [];
    saveEmailChannel(home.paths, { to: "me@example.com", host: "127.0.0.1", port: 1, secure: false }, undefined);
    const notifier = new ChannelNotifier(home.paths, new RecordingNotifier(), (line) => logs.push(line));
    await notifier.notify({ title: "T", body: "b", channels: ["email"] });
    assert.match(logs.join("\n"), /email notification failed/);
  });
});
