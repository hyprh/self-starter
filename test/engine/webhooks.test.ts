import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  ChannelNotifier,
  configuredChannels,
  removeChannel,
  saveEmailChannel,
  saveWebhookChannel,
  setDefaultChannels,
} from "../../src/engine/channels.js";
import { loadConfig } from "../../src/engine/config.js";
import {
  detectWebhookProvider,
  discoverTelegramChats,
  maskWebhookHint,
  sendWebhook,
  signDingTalk,
  signFeishu,
  suggestChannelName,
} from "../../src/engine/webhooks.js";
import { readFileSync, statSync } from "node:fs";
import { RecordingNotifier, tempHome } from "./fixtures.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("webhook and push channels", () => {
  const requests: CapturedRequest[] = [];
  let nextStatus = 200;
  let nextBody = JSON.stringify({ code: 0, errcode: 0, ok: true });
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "/";
      requests.push({
        method: req.method ?? "GET",
        url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (url.includes("/getUpdates")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { chat: { id: 10001, first_name: "Ada", type: "private" } } },
              { update_id: 2, message: { chat: { id: -20002, title: "Trading Desk", type: "group" } } },
            ],
          }),
        );
        return;
      }
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(nextBody);
    });
  });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("auto-detects providers from pasted URLs and masks capability tokens", () => {
    assert.equal(detectWebhookProvider("https://open.feishu.cn/open-apis/bot/v2/hook/demo-token-1234"), "feishu");
    assert.equal(detectWebhookProvider("https://open.larksuite.com/open-apis/bot/v2/hook/demo-token-5678"), "feishu");
    assert.equal(detectWebhookProvider("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-wecom-9988"), "wecom");
    assert.equal(detectWebhookProvider("https://oapi.dingtalk.com/robot/send?access_token=demo-ding-7766"), "dingtalk");
    assert.equal(detectWebhookProvider("https://hooks.slack.com/services/T00/B00/demoSlack4321"), "slack");
    assert.equal(detectWebhookProvider("https://discord.com/api/webhooks/123/demoDiscord8765"), "discord");
    assert.equal(detectWebhookProvider("https://api.day.app/demoBarkDevice1122/"), "bark");
    assert.equal(detectWebhookProvider("https://ntfy.sh/my-private-topic-3344"), "ntfy");
    assert.equal(detectWebhookProvider("https://automations.example.com/hooks/alert"), "webhook");

    const feishuHint = maskWebhookHint("https://open.feishu.cn/open-apis/bot/v2/hook/secretPathToken9a2f");
    assert.equal(feishuHint, "open.feishu.cn (…9a2f)");
    assert.doesNotMatch(feishuHint, /secretPathToken/);

    const wecomHint = maskWebhookHint("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secretQueryKey77bc");
    assert.equal(wecomHint, "qyapi.weixin.qq.com (…77bc)");
    assert.doesNotMatch(wecomHint, /secretQueryKey/);

    assert.equal(suggestChannelName("feishu", []), "feishu");
    assert.equal(suggestChannelName("feishu", ["feishu"]), "feishu-2");
  });

  it("formats and signs Feishu, DingTalk, WeCom, Slack, Discord, Bark, ntfy, Telegram and generic webhooks", async () => {
    const fixedNow = () => new Date("2026-11-03T05:00:00.000Z");
    const baseUrl = `http://127.0.0.1:${port}`;
    requests.length = 0;

    // 1. Feishu with HMAC signature
    await sendWebhook(
      { provider: "feishu", hint: "feishu", hasSigningSecret: true },
      { url: `${baseUrl}/feishu-hook`, signingSecret: "feishu-sign-key" },
      { title: "NVDA breakout", body: "Crossed 145 on high volume", threadId: "cc:sess-1" },
      { now: fixedNow },
    );
    const feishuReq = JSON.parse(requests.at(-1)!.body);
    const expectedTsSec = String(Math.floor(fixedNow().getTime() / 1000));
    assert.equal(feishuReq.timestamp, expectedTsSec);
    assert.equal(feishuReq.sign, signFeishu(expectedTsSec, "feishu-sign-key"));
    assert.equal(feishuReq.msg_type, "post");
    assert.match(JSON.stringify(feishuReq.content), /claude --resume sess-1/);

    // 2. DingTalk with URL query HMAC signature
    await sendWebhook(
      { provider: "dingtalk", hint: "dingtalk", hasSigningSecret: true },
      { url: `${baseUrl}/robot/send?access_token=ding-token-abc123`, signingSecret: "ding-sign-key" },
      { title: "CI failed", body: "main build #42 failed" },
      { now: fixedNow },
    );
    const dingReq = requests.at(-1)!;
    const expectedTsMs = String(fixedNow().getTime());
    const dingUrl = new URL(dingReq.url, baseUrl);
    assert.equal(dingUrl.searchParams.get("timestamp"), expectedTsMs);
    assert.equal(dingUrl.searchParams.get("sign"), signDingTalk(expectedTsMs, "ding-sign-key"));

    // 3. ntfy with non-ASCII UTF-8 title (RFC 2047 encoded header, no Undici crash)
    await sendWebhook(
      { provider: "ntfy", hint: "ntfy" },
      { url: `${baseUrl}/topic-ops` },
      { title: "腾讯研报异动", body: "大摩上调目标价" },
      { now: fixedNow },
    );
    const ntfyReq = requests.at(-1)!;
    assert.match(String(ntfyReq.headers.title), /^=\?UTF-8\?B\?/);
    assert.equal(ntfyReq.body, "大摩上调目标价");

    // 4. Telegram chat discovery + sendMessage
    const chats = await discoverTelegramChats("tg-test-bot-token", { apiBaseUrl: baseUrl });
    assert.equal(chats.length, 2);
    assert.equal(chats[0]!.chatId, "-20002");
    assert.equal(chats[0]!.title, "Trading Desk");

    await sendWebhook(
      { provider: "telegram", hint: "Telegram chat -20002", chatId: "-20002" },
      { url: baseUrl, botToken: "tg-test-bot-token" },
      { title: "Training complete", body: "Loss converged at 0.041" },
      { now: fixedNow },
    );
    const tgReq = requests.at(-1)!;
    assert.equal(tgReq.url, "/bottg-test-bot-token/sendMessage");
    assert.equal(JSON.parse(tgReq.body).chat_id, "-20002");

    // 5. Generic JSON webhook with triggerId, fireId and custom header
    await sendWebhook(
      { provider: "webhook", hint: "webhook", headerNames: ["X-Custom-Auth"] },
      { url: `${baseUrl}/custom-hook`, headers: { "X-Custom-Auth": "custom-secret-header" } },
      { title: "Disk alert", body: "92% full", triggerId: "disk-watch", fireId: "fire_42" },
      { now: fixedNow },
    );
    const hookReq = requests.at(-1)!;
    assert.equal(hookReq.headers["x-custom-auth"], "custom-secret-header");
    const hookJson = JSON.parse(hookReq.body);
    assert.equal(hookJson.source, "self-starter");
    assert.equal(hookJson.triggerId, "disk-watch");
    assert.equal(hookJson.fireId, "fire_42");
  });

  it("redacts secret tokens from error messages and preserves email + webhook secrets side by side", async () => {
    const home = tempHome();
    try {
      const secretUrl = `http://127.0.0.1:${port}/hook/verySecretCapabilityToken9911`;
      saveEmailChannel(home.paths, { to: "me@example.com", host: "127.0.0.1", port: 2525, secure: false, user: "me@example.com" }, "my-email-pass");
      saveWebhookChannel(home.paths, { id: "feishu", provider: "feishu", url: secretUrl, label: "Team Ops" });

      assert.equal(statSync(home.paths.channelSecrets).mode & 0o777, 0o600);
      const rawConfig = readFileSync(home.paths.config, "utf8");
      assert.doesNotMatch(rawConfig, /verySecretCapabilityToken9911/, "webhook token never enters config.json");
      assert.doesNotMatch(rawConfig, /my-email-pass/, "email password never enters config.json");
      const rawSecrets = JSON.parse(readFileSync(home.paths.channelSecrets, "utf8"));
      assert.equal(rawSecrets.email.password, "my-email-pass", "saving a webhook preserves email password");
      assert.equal(rawSecrets.webhooks.feishu.url, secretUrl);

      assert.deepEqual(configuredChannels(loadConfig(home.paths)), ["desktop", "email", "feishu"]);
      setDefaultChannels(home.paths, ["desktop", "feishu"]);

      // Simulate Feishu business-level error (HTTP 200 with code != 0) containing the token
      nextStatus = 200;
      nextBody = JSON.stringify({ code: 19021, msg: `bad sign for ${secretUrl}` });
      const logs: string[] = [];
      const desktop = new RecordingNotifier();
      const notifier = new ChannelNotifier(home.paths, desktop, (l) => logs.push(l));
      await notifier.notify({ title: "Alert", body: "Check logs" });

      assert.equal(desktop.sent.length, 1);
      assert.match(logs.join("\n"), /feishu notification failed: Feishu error 19021/);
      assert.doesNotMatch(logs.join("\n"), /verySecretCapabilityToken9911/, "logs redact capability URLs");

      nextStatus = 200;
      nextBody = JSON.stringify({ code: 0, errcode: 0, ok: true });

      assert.equal(removeChannel(home.paths, "feishu"), true);
      assert.deepEqual(loadConfig(home.paths).channels?.default, ["desktop"]);
      const afterRemoveSecrets = JSON.parse(readFileSync(home.paths.channelSecrets, "utf8"));
      assert.equal(afterRemoveSecrets.email.password, "my-email-pass", "removing webhook keeps email password intact");
    } finally {
      home.cleanup();
    }
  });
});
