// Local loopback HTTP + SSE server for `self-starter ui`.
//
// Security model:
// 1. Binds strictly to 127.0.0.1 (never 0.0.0.0; remote boxes use `ssh -L`).
// 2. Validates the Host header against 127.0.0.1:<port> / localhost:<port> (blocks DNS rebinding).
// 3. Exchanges a 256-bit one-time URL bootstrap token (?token=...) for an HttpOnly SameSite=Strict cookie.
// 4. Requires X-Self-Starter-UI: 1 and same-origin Origin on every mutating request (blocks CSRF).
// 5. Never returns secret values from secrets.json or channel-secrets.json.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { callDaemon } from "../client/client.js";
import { doctor } from "../cli/install.js";
import { reopen } from "../core/conversations.js";
import { isRecord } from "../core/patch.js";
import {
  ChannelNotifier,
  channelSettings,
  composeEmail,
  configuredChannels,
  readWebhookSecret,
  removeChannel,
  saveEmailChannel,
  saveWebhookChannel,
  sendEmail,
  setDefaultChannels,
} from "../engine/channels.js";
import { isExecutable, loadConfig, saveConfig, type EmailSettings, type WebhookProvider } from "../engine/config.js";
import { mailProviderFor, unsupportedSender } from "../engine/mail-providers.js";
import { SystemNotifier, type Notifier } from "../engine/notify.js";
import type { Paths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import { Store } from "../engine/store.js";
import { discoverTelegramChats, isWebhookProvider, sendWebhook } from "../engine/webhooks.js";
import { UI_CLIENT_JS } from "./client.js";
import { UI_FAVICON_SVG, UI_HTML } from "./page.js";
import { UI_STYLES } from "./styles.js";

const COOKIE_NAME = "ss_ui";
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_PORT = 4319;
const SSE_POLL_MS = 2000;
const SSE_KEEPALIVE_MS = 15_000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface UiServerOptions {
  paths: Paths;
  port?: number;
  strictPort?: boolean;
  token?: string;
  desktopNotifier?: Notifier;
  fetchImpl?: typeof fetch;
  sendEmailImpl?: typeof sendEmail;
}

export interface RunningUiServer {
  port: number;
  token: string;
  /** Authenticated bootstrap URL to open in the user's browser. */
  url: string;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  setSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  setSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) throw new Error("expected a JSON object");
  return parsed;
}

export async function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const { paths } = options;
  const token = options.token ?? randomBytes(32).toString("hex");
  const desktop = options.desktopNotifier ?? new SystemNotifier();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sendEmailImpl = options.sendEmailImpl ?? sendEmail;

  let actualPort = options.port ?? DEFAULT_PORT;
  const sseClients = new Set<ServerResponse>();
  let lastSnapshotJson = "";
  let pollTimer: NodeJS.Timeout | undefined;
  let keepAliveTimer: NodeJS.Timeout | undefined;

  const daemon = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    callDaemon<T>(paths.socket, method, params, { via: "cli" }, timeoutMs);

  async function buildSnapshot() {
    const raw = await daemon<{
      status: Record<string, unknown>;
      triggers: Array<Record<string, unknown>>;
      drafts: Array<Record<string, unknown>>;
      fires: Array<Record<string, unknown> & { target?: { threadId?: string } | null }>;
      deferred: Array<Record<string, unknown>>;
    }>("ui.snapshot");

    const cfg = loadConfig(paths);
    const settings = channelSettings(cfg);
    const secrets = new Secrets(paths).list();

    const fires = raw.fires.map((f) => {
      const threadId = f.target && typeof f.target.threadId === "string" ? f.target.threadId : undefined;
      return {
        ...f,
        reopen: threadId ? reopen(threadId) : null,
      };
    });

    const hostSpecs = [
      {
        id: "codex",
        name: "Codex",
        vendor: "OpenAI Codex App & CLI",
        configKey: "codexBin" as const,
        statusKey: "codex",
        capabilities: ["Origin thread queue", "Dedicated thread", "Background app-server wake"],
        installCmd: "codex plugin marketplace add hyprh/self-starter && codex plugin add self-starter@self-starter",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic Claude Code >= 2.1.224",
        configKey: "claudeBin" as const,
        statusKey: "claude",
        capabilities: ["Live session inbox", "Dedicated session", "Background claude -p --resume"],
        installCmd: "claude plugin marketplace add hyprh/self-starter && claude plugin install self-starter@self-starter",
      },
      {
        id: "zcode",
        name: "ZCode",
        vendor: "ZCode CLI Integration",
        configKey: "zcodeBin" as const,
        statusKey: "zcode",
        capabilities: ["Dedicated CLI result session", "Session resume via zcode --resume"],
        installCmd: "self-starter install --zcode /path/to/zcode",
      },
      {
        id: "opencode",
        name: "OpenCode",
        vendor: "OpenCode 1.19.3–1.x Native Loader",
        configKey: "opencodeBin" as const,
        statusKey: "opencode",
        capabilities: ["Native JS plugin loader", "Dedicated session via opencode run --session"],
        installCmd: "self-starter install --opencode /path/to/opencode",
      },
    ];

    const agents = hostSpecs.map((spec) => {
      const detectedBin = typeof raw.status[spec.statusKey] === "string" ? (raw.status[spec.statusKey] as string) : null;
      const configuredBin = cfg[spec.configKey] ?? null;
      const hostTriggers = raw.triggers.filter((t) => (t.host ?? "codex") === spec.id);
      const hostFires = fires.filter((f) => ((f as Record<string, unknown>).host ?? "codex") === spec.id);
      return {
        id: spec.id,
        name: spec.name,
        vendor: spec.vendor,
        configKey: spec.configKey,
        configuredBin,
        detectedBin: detectedBin ?? configuredBin,
        watchCount: hostTriggers.length,
        activeWatchCount: hostTriggers.filter((t) => t.lifecycle === "active").length,
        attentionCount: hostFires.filter((f) => Boolean((f as Record<string, unknown>).needsAttention)).length,
        fireCount: hostFires.length,
        capabilities: spec.capabilities,
        installCmd: spec.installCmd,
      };
    });

    return {
      status: raw.status,
      triggers: raw.triggers,
      drafts: raw.drafts,
      fires,
      deferred: raw.deferred,
      agents,
      channels: {
        default: settings.default,
        available: configuredChannels(cfg),
        webhooks: settings.webhooks ?? {},
        email: settings.email ?? null,
      },
      secrets,
    };
  }

  async function broadcastSnapshot(force = false): Promise<void> {
    if (sseClients.size === 0) return;
    try {
      const json = JSON.stringify(await buildSnapshot());
      if (!force && json === lastSnapshotJson) return;
      lastSnapshotJson = json;
      const frame = `event: snapshot\ndata: ${json}\n\n`;
      for (const client of sseClients) {
        if (!client.writableEnded) client.write(frame);
      }
    } catch {
      // daemon may be restarting; clients will reconnect or see next tick
    }
  }

  function updateSseTimers(): void {
    if (sseClients.size > 0 && !pollTimer) {
      pollTimer = setInterval(() => void broadcastSnapshot(false), SSE_POLL_MS);
      keepAliveTimer = setInterval(() => {
        for (const client of sseClients) {
          if (!client.writableEnded) client.write(": keepalive\n\n");
        }
      }, SSE_KEEPALIVE_MS);
    } else if (sseClients.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      clearInterval(keepAliveTimer);
      pollTimer = undefined;
      keepAliveTimer = undefined;
    }
  }

  function validHost(hostHeader: string | undefined): boolean {
    return hostHeader === `127.0.0.1:${actualPort}` || hostHeader === `localhost:${actualPort}`;
  }

  function validOrigin(originHeader: string | undefined): boolean {
    if (!originHeader) return true;
    return originHeader === `http://127.0.0.1:${actualPort}` || originHeader === `http://localhost:${actualPort}`;
  }

  function isAuthenticated(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return safeEqual(auth.slice(7).trim(), token);
    }
    const cookies = parseCookies(req.headers.cookie);
    return typeof cookies[COOKIE_NAME] === "string" && safeEqual(cookies[COOKIE_NAME]!, token);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const isMutation = method !== "GET" && method !== "HEAD";
    if (isMutation) {
      if (req.headers["x-self-starter-ui"] !== "1" || !validOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: "forbidden: missing CSRF header or invalid origin" });
        return;
      }
    }

    if (method === "GET" && pathname === "/api/snapshot") {
      sendJson(res, 200, await buildSnapshot());
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      setSecurityHeaders(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      updateSseTimers();
      req.on("close", () => {
        sseClients.delete(res);
        updateSseTimers();
      });
      return;
    }

    if (method === "GET" && pathname === "/api/inspect") {
      const kind = url.searchParams.get("kind") ?? "trigger";
      const id = url.searchParams.get("id") ?? "";
      sendJson(res, 200, await daemon("ui.inspect", { kind, id }));
      return;
    }

    if (method === "POST" && pathname === "/api/fires/ack") {
      const body = await readJsonBody(req);
      const result = await daemon("fire.acknowledge", body);
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/deferred/flush") {
      const body = await readJsonBody(req);
      const result = await daemon("deferred.flush", body);
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/deferred/drop") {
      const body = await readJsonBody(req);
      const result = await daemon("deferred.drop", body);
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    const triggerAction = pathname.match(/^\/api\/triggers\/([^/]+)\/(update|tune|pause|resume|test)$/);
    if (method === "POST" && triggerAction) {
      const triggerId = decodeURIComponent(triggerAction[1]!);
      const act = triggerAction[2]!;
      const body = act === "update" || act === "tune" ? await readJsonBody(req) : {};
      const timeout = act === "test" ? 6 * 60_000 : undefined;
      const result = await daemon(`trigger.${act}`, { ...body, triggerId }, timeout);
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    const triggerDelete = pathname.match(/^\/api\/triggers\/([^/]+)$/);
    if (method === "DELETE" && triggerDelete) {
      const triggerId = decodeURIComponent(triggerDelete[1]!);
      const result = await daemon("trigger.delete", { triggerId });
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    const draftActivate = pathname.match(/^\/api\/drafts\/([^/]+)\/activate$/);
    if (method === "POST" && draftActivate) {
      const draftId = decodeURIComponent(draftActivate[1]!);
      const result = await daemon("draft.activate", { draftId });
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    const draftDelete = pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (method === "DELETE" && draftDelete) {
      const draftId = decodeURIComponent(draftDelete[1]!);
      const result = await daemon("draft.discard", { draftId });
      void broadcastSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/channels/telegram/chats") {
      const body = await readJsonBody(req);
      const botToken = typeof body.botToken === "string" ? body.botToken : "";
      const apiBaseUrl = typeof body.apiBaseUrl === "string" && body.apiBaseUrl ? body.apiBaseUrl : undefined;
      const chats = await discoverTelegramChats(botToken, { fetchImpl, ...(apiBaseUrl ? { apiBaseUrl } : {}) });
      sendJson(res, 200, { chats });
      return;
    }

    if (method === "POST" && pathname === "/api/channels/webhook") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const provider = isWebhookProvider(body.provider) ? (body.provider as WebhookProvider) : undefined;
      const headersRaw = isRecord(body.headers) ? body.headers : undefined;
      const headers: Record<string, string> | undefined = headersRaw
        ? Object.fromEntries(Object.entries(headersRaw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;

      new Store(paths).ensureLayout();
      const meta = saveWebhookChannel(paths, {
        id,
        ...(provider ? { provider } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.botToken === "string" ? { botToken: body.botToken } : {}),
        ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
        ...(typeof body.signingSecret === "string" ? { signingSecret: body.signingSecret } : {}),
        ...(headers ? { headers } : {}),
      });
      if (body.makeDefault === true) {
        const cur = channelSettings(loadConfig(paths)).default;
        setDefaultChannels(paths, [...new Set([...cur, id])]);
      }
      if (body.test === true) {
        await sendWebhook(
          meta,
          readWebhookSecret(paths, id),
          { title: "Test notification", body: `Channel "${id}" is connected to Self-Starter.` },
          { fetchImpl },
        );
      }
      void broadcastSnapshot(true);
      sendJson(res, 200, { id, meta });
      return;
    }

    if (method === "POST" && pathname === "/api/channels/email") {
      const body = await readJsonBody(req);
      const address = typeof body.address === "string" ? body.address.trim() : "";
      const customHost = typeof body.host === "string" && body.host.trim() ? body.host.trim() : undefined;
      const provider = address && !customHost ? mailProviderFor(address) : undefined;
      if (!customHost && !provider) {
        if (!address) throw new Error("email address is required");
        throw new Error(unsupportedSender(address) ?? `no SMTP preset for ${address}; specify an SMTP host`);
      }
      const secure = provider ? provider.secure : body.starttls !== true;
      const port = typeof body.port === "number" && Number.isInteger(body.port) ? body.port : (provider?.port ?? (secure ? 465 : 587));
      const settings: EmailSettings = {
        to: typeof body.to === "string" && body.to.trim() ? body.to.trim() : address,
        host: provider?.host ?? customHost!,
        port,
        secure,
        ...(address ? { user: address, from: address } : {}),
      };
      const password = typeof body.password === "string" && body.password ? body.password : undefined;
      new Store(paths).ensureLayout();
      saveEmailChannel(paths, settings, password);
      if (body.test === true) {
        await sendEmailImpl(settings, password, composeEmail({ title: "Test email", body: "Email works: Self-Starter can send notifications here." }));
      }
      void broadcastSnapshot(true);
      sendJson(res, 200, { email: settings });
      return;
    }

    if (method === "POST" && pathname === "/api/channels/default") {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.channels) || !body.channels.every((c): c is string => typeof c === "string")) {
        throw new Error("channels must be a list of channel names");
      }
      const updated = setDefaultChannels(paths, body.channels);
      void broadcastSnapshot(true);
      sendJson(res, 200, { default: updated });
      return;
    }

    const channelTest = pathname.match(/^\/api\/channels\/([^/]+)\/test$/);
    if (method === "POST" && channelTest) {
      const id = decodeURIComponent(channelTest[1]!);
      const errors: string[] = [];
      const notifier = new ChannelNotifier(
        paths,
        desktop,
        (line) => {
          if (/failed|not set up|no email channel/.test(line)) errors.push(line);
        },
        sendEmailImpl,
        (meta, sec, notif) => sendWebhook(meta, sec, notif, { fetchImpl }),
      );
      await notifier.notify({
        title: "Self-Starter test",
        body: `Test notification sent to "${id}" from Self-Starter Console.`,
        channels: [id],
      });
      if (errors.length > 0) throw new Error(errors.join("; "));
      sendJson(res, 200, { sent: id });
      return;
    }

    const channelDelete = pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (method === "DELETE" && channelDelete) {
      const id = decodeURIComponent(channelDelete[1]!);
      const removed = removeChannel(paths, id);
      void broadcastSnapshot(true);
      sendJson(res, 200, { removed });
      return;
    }

    if (method === "POST" && pathname === "/api/secrets") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const value = typeof body.value === "string" ? body.value : "";
      const rawHosts = typeof body.hosts === "string" ? body.hosts.trim() : "";
      const hosts = rawHosts === "" || rawHosts === "*"
        ? "*"
        : rawHosts.split(",").map((h) => h.trim()).filter(Boolean);
      new Store(paths).ensureLayout();
      new Secrets(paths).set(name, value, hosts);
      void broadcastSnapshot(true);
      sendJson(res, 200, { saved: name });
      return;
    }

    const secretDelete = pathname.match(/^\/api\/secrets\/([^/]+)$/);
    if (method === "DELETE" && secretDelete) {
      const name = decodeURIComponent(secretDelete[1]!);
      const removed = new Secrets(paths).remove(name);
      void broadcastSnapshot(true);
      sendJson(res, 200, { removed });
      return;
    }

    if (method === "GET" && pathname === "/api/agents/doctor") {
      const checks = await doctor(paths);
      sendJson(res, 200, { checks, checkedAt: new Date().toISOString() });
      return;
    }

    if (method === "POST" && pathname === "/api/agents/config") {
      const body = await readJsonBody(req);
      const cfg = loadConfig(paths);
      const binKeys = ["codexBin", "claudeBin", "zcodeBin", "opencodeBin"] as const;
      for (const key of binKeys) {
        if (key in body) {
          const val = typeof body[key] === "string" ? body[key].trim() : "";
          if (val === "") {
            delete cfg[key];
          } else {
            if (!isAbsolute(val) || !isExecutable(val)) {
              throw new Error(`${val} must be an absolute path to an executable file`);
            }
            cfg[key] = val;
          }
        }
      }
      if (isRecord(body.budget)) {
        const cur = cfg.budget ?? {};
        const maxDay = Number(body.budget.maxAgentRunsPerDay);
        const maxConc = Number(body.budget.maxConcurrentAgentRuns);
        if (Number.isFinite(maxDay) && maxDay >= 1) cur.maxAgentRunsPerDay = Math.floor(maxDay);
        if (Number.isFinite(maxConc) && maxConc >= 1) cur.maxConcurrentAgentRuns = Math.floor(maxConc);
        cfg.budget = cur;
      }
      new Store(paths).ensureLayout();
      saveConfig(paths, cfg);
      void broadcastSnapshot(true);
      sendJson(res, 200, { saved: true });
      return;
    }

    sendJson(res, 404, { error: `unknown endpoint: ${method} ${pathname}` });
  }

  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!validHost(req.headers.host)) {
      sendText(res, 403, "text/plain; charset=utf-8", "Forbidden: invalid Host header.");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
    const pathname = url.pathname;

    // One-time token bootstrap: exchange ?token=<secret> for an HttpOnly SameSite=Strict cookie.
    const queryToken = url.searchParams.get("token");
    if (req.method === "GET" && pathname === "/" && queryToken !== null) {
      if (!safeEqual(queryToken, token)) {
        sendText(res, 401, "text/plain; charset=utf-8", "Invalid session token. Run `self-starter ui` to open an authenticated link.");
        return;
      }
      setSecurityHeaders(res);
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      });
      res.end();
      return;
    }

    if (!isAuthenticated(req)) {
      if (pathname.startsWith("/api/")) {
        sendJson(res, 401, { error: "unauthorized: open the URL printed by `self-starter ui`" });
      } else {
        sendText(
          res,
          401,
          "text/plain; charset=utf-8",
          "Unauthorized: open the authenticated URL printed in your terminal by `self-starter ui`.",
        );
      }
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      sendText(res, 200, "text/html; charset=utf-8", UI_HTML);
      return;
    }
    if (req.method === "GET" && pathname === "/styles.css") {
      sendText(res, 200, "text/css; charset=utf-8", UI_STYLES);
      return;
    }
    if (req.method === "GET" && pathname === "/app.js") {
      sendText(res, 200, "application/javascript; charset=utf-8", UI_CLIENT_JS);
      return;
    }
    if (req.method === "GET" && pathname === "/icon.svg") {
      sendText(res, 200, "image/svg+xml; charset=utf-8", UI_FAVICON_SVG);
      return;
    }

    if (pathname.startsWith("/api/")) {
      void handleApi(req, res, pathname, url).catch((error: Error) => {
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    sendText(res, 404, "text/plain; charset=utf-8", "Not found");
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const listen = (portToTry: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(portToTry, "127.0.0.1");
    });

  try {
    await listen(actualPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && !options.strictPort && actualPort !== 0) {
      await listen(0);
    } else {
      throw error;
    }
  }

  actualPort = (server.address() as AddressInfo).port;
  const authUrl = `http://127.0.0.1:${actualPort}/?token=${token}`;

  return {
    port: actualPort,
    token,
    url: authUrl,
    close: () =>
      new Promise<void>((resolve) => {
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        sseClients.clear();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
