import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";
import { startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import { FireLog } from "../../src/engine/fires.js";
import { startUiServer, type RunningUiServer } from "../../src/ui/server.js";
import { RecordingNotifier, tempHome } from "../engine/fixtures.js";

describe("self-starter ui server", () => {
  let home: ReturnType<typeof tempHome>;
  let daemon: Daemon;
  let ui: RunningUiServer;
  let mockPort = 0;
  const webhookBodies: string[] = [];

  const mockWebhook = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      webhookBodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
    });
  });

  before(async () => {
    await new Promise<void>((resolve) => mockWebhook.listen(0, "127.0.0.1", resolve));
    mockPort = (mockWebhook.address() as AddressInfo).port;
    home = tempHome();
    daemon = await startDaemon({
      paths: home.paths,
      notifier: undefined,
    });
    ui = await startUiServer({
      paths: home.paths,
      port: 0,
      desktopNotifier: new RecordingNotifier(),
    });
  });

  after(async () => {
    await ui?.close();
    await daemon?.stop();
    await new Promise<void>((resolve) => mockWebhook.close(() => resolve()));
    home?.cleanup();
  });

  it("enforces Host validation, session token bootstrap, CSP and CSRF protection", async () => {
    const base = `http://127.0.0.1:${ui.port}`;
    const rawRequest = (headers: Record<string, string>, method = "GET", path = "/api/snapshot", body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: ui.port, method, path, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });

    // 1. DNS rebinding check: forged Host header -> 403 (using http.request since WhatWG fetch strips forbidden Host header)
    const badHostStatus = await rawRequest({ Host: "attacker.example.com", Authorization: `Bearer ${ui.token}` });
    assert.equal(badHostStatus, 403);

    // 2. Unauthenticated -> 401
    const unauth = await fetch(`${base}/api/snapshot`);
    assert.equal(unauth.status, 401);

    // 3. Invalid token -> 401
    const wrongTok = await fetch(`${base}/?token=wrong`, { redirect: "manual" });
    assert.equal(wrongTok.status, 401);

    // 4. Valid bootstrap ?token=... -> 302 + HttpOnly SameSite=Strict cookie
    const bootstrap = await fetch(ui.url, { redirect: "manual" });
    assert.equal(bootstrap.status, 302);
    assert.equal(bootstrap.headers.get("location"), "/");
    const setCookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookiePair = setCookie.split(";")[0]!;

    // 5. Authenticated page serves strict CSP with zero inline scripts
    const htmlRes = await fetch(`${base}/`, { headers: { Cookie: cookiePair } });
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const html = await htmlRes.text();
    assert.match(html, /Self-Starter Console/);

    // Verify served client script is syntactically valid JS
    const jsRes = await fetch(`${base}/app.js`, { headers: { Cookie: cookiePair } });
    assert.equal(jsRes.status, 200);
    const jsSource = await jsRes.text();
    assert.doesNotThrow(() => new vm.Script(jsSource, { filename: "app.js" }));

    // 6. CSRF check: POST without X-Self-Starter-UI header -> 403
    const noCsrf = await fetch(`${base}/api/fires/ack`, {
      method: "POST",
      headers: { Cookie: cookiePair, "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(noCsrf.status, 403);

    // 7. Cross-Origin POST -> 403
    const crossOriginStatus = await rawRequest(
      {
        Host: `127.0.0.1:${ui.port}`,
        Cookie: cookiePair,
        "X-Self-Starter-UI": "1",
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      "POST",
      "/api/fires/ack",
      JSON.stringify({ all: true }),
    );
    assert.equal(crossOriginStatus, 403);
  });

  it("manages channels, secrets, drafts, per-watch routing, quiet-hours flushing and Inbox read state without leaking secrets", async () => {
    const base = `http://127.0.0.1:${ui.port}`;
    const headers = {
      Authorization: `Bearer ${ui.token}`,
      "X-Self-Starter-UI": "1",
      "Content-Type": "application/json",
    };

    // 1. Add Feishu webhook channel & probe secret through UI API
    const secretHookUrl = `http://127.0.0.1:${mockPort}/open-apis/bot/v2/hook/privateHookCapability8877`;
    const addCh = await fetch(`${base}/api/channels/webhook`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "feishu",
        provider: "feishu",
        url: secretHookUrl,
        label: "Ops Room",
        makeDefault: true,
        test: true,
      }),
    });
    assert.equal(addCh.status, 200, await addCh.text());
    assert.equal(webhookBodies.length, 1, "test push delivered to mock Feishu server");

    const addSec = await fetch(`${base}/api/secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "TEST_API_SECRET",
        value: "never-return-this-probe-secret-value",
        hosts: "api.example.com",
      }),
    });
    assert.equal(addSec.status, 200);

    // 2. Verify snapshot never exposes secret values
    const snap1Res = await fetch(`${base}/api/snapshot`, { headers });
    assert.equal(snap1Res.status, 200);
    const snap1Text = await snap1Res.text();
    assert.doesNotMatch(snap1Text, /privateHookCapability8877/);
    assert.doesNotMatch(snap1Text, /never-return-this-probe-secret-value/);
    const snap1 = JSON.parse(snap1Text);
    assert.equal(snap1.channels.webhooks.feishu.hint, `127.0.0.1:${mockPort} (…8877)`);
    assert.deepEqual(snap1.secrets, [{ name: "TEST_API_SECRET", hosts: ["api.example.com"] }]);
    assert.deepEqual(
      snap1.agents.map((a: { id: string }) => a.id),
      ["codex", "claude-code", "antigravity", "zcode", "opencode"],
    );

    const cfgRes = await fetch(`${base}/api/agents/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agyBin: process.execPath, budget: { maxAgentRunsPerDay: 120, maxConcurrentAgentRuns: 3 } }),
    });
    assert.equal(cfgRes.status, 200);
    const snapAfterCfg = await (await fetch(`${base}/api/snapshot`, { headers })).json();
    assert.equal(snapAfterCfg.agents.find((a: { id: string }) => a.id === "antigravity")?.configuredBin, process.execPath);

    // 3. Create a draft via service, inspect & activate it via UI API
    const draft = await daemon.service.createDraft(
      {
        definition: {
          id: "nvda-watch",
          name: "NVDA price watch",
          intent: "Alert when NVDA breaks out",
          probe: {},
          mode: "state",
          action: { type: "notify" },
          notify: { when: "always", channels: ["feishu"] },
        },
        code: 'console.log(JSON.stringify({ fire: true, summary: "NVDA crossed 150" }));',
      },
      { via: "cli" },
    );

    const inspectDraft = await fetch(`${base}/api/inspect?kind=draft&id=${encodeURIComponent(draft.draftId)}`, { headers });
    assert.equal(inspectDraft.status, 200);
    const inspected = await inspectDraft.json();
    assert.match(inspected.probeCode, /NVDA crossed 150/);

    const actRes = await fetch(`${base}/api/drafts/${encodeURIComponent(draft.draftId)}/activate`, {
      method: "POST",
      headers,
    });
    assert.equal(actRes.status, 200);

    // Wait briefly for the first scheduled probe run + notify fire
    for (let i = 0; i < 40; i++) {
      if (webhookBodies.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(webhookBodies.length >= 2, "activated watch routed fire notification to Feishu");

    // 4. Verify Attention Inbox shows the fire as unread, then mark it read
    const snap2 = await (await fetch(`${base}/api/snapshot`, { headers })).json();
    assert.ok(snap2.status.checks.total >= 1, "tracks 0-token probe checks");
    assert.equal(snap2.triggers[0].interval, "5m");
    assert.equal(snap2.triggers[0].host, "codex");
    const unread = snap2.fires.filter((f: { needsAttention: boolean }) => f.needsAttention);
    assert.equal(unread.length, 1);

    const ackRes = await fetch(`${base}/api/fires/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fireIds: [unread[0].fireId] }),
    });
    assert.equal(ackRes.status, 200);

    const reloadedFires = new FireLog(home.paths.fires);
    assert.ok(reloadedFires.get(unread[0].fireId)?.acknowledgedAt, "acknowledged state persists in fires.jsonl");

    // 5. Hot-update watch with all-day quiet_hours, submit another fire, and flush deferred from UI
    const updRes = await fetch(`${base}/api/triggers/nvda-watch/update`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        changes: {
          policy: { quiet_hours: { from: "00:00", to: "23:59", tz: "UTC" } },
        },
      }),
    });
    assert.equal(updRes.status, 200);

    const defLoaded = daemon.store.loadTrigger("nvda-watch").definition;
    const beforeCount = webhookBodies.length;
    daemon.executor.submit(defLoaded, { reason: "state_met", summary: "Held during quiet hours" }, 99);
    for (let i = 0; i < 20; i++) {
      if (daemon.executor.deferredItems().length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(daemon.executor.deferredItems().length, 1);
    assert.equal(webhookBodies.length, beforeCount, "held during quiet hours");

    const flushRes = await fetch(`${base}/api/deferred/flush`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(flushRes.status, 200);
    assert.equal(webhookBodies.length, beforeCount + 1, "flushed held notification immediately to Feishu");
  });
});
