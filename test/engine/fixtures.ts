// Shared pieces for engine tests: a temporary home, a local HTTP server,
// a fake codex, a notifier that records, and probe sources.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexRunner, ExecResult, ThreadView, WakeOptions } from "../../src/engine/codex.js";
import type { Notification, Notifier } from "../../src/engine/notify.js";
import { resolvePaths, type Paths } from "../../src/engine/paths.js";

export function tempHome(): { paths: Paths; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "ct-"));
  return { paths: resolvePaths(home), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export interface TestServer {
  origin: string;
  host: string;
  price: number;
  events: Array<{ id: string; title: string }>;
  hits: number;
  close(): Promise<void>;
}

/** Serves /price as {"price": n} and /events as a list, both changeable by the test. */
export async function startServer(): Promise<TestServer> {
  const state = { price: 100, events: [] as Array<{ id: string; title: string }>, hits: 0 };
  const server: Server = createServer((req, res) => {
    state.hits += 1;
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/price")) res.end(JSON.stringify({ price: state.price }));
    else if (req.url?.startsWith("/events")) res.end(JSON.stringify(state.events));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

export class FakeCodex implements CodexRunner {
  queued: Array<{ threadId: string; message: string }> = [];
  started: Array<{ cwd: string; name: string; prompt: string }> = [];
  execs: Array<{ cwd: string; prompt: string }> = [];
  appServerBroken = false;
  resumes: Array<{ threadId: string; prompt: string; sandbox: string }> = [];
  queueError: Error | undefined;
  resumeAnswer = '{"summary":"looked into it","notify":true}';
  resumeOk = true;
  /** How each thread looks from outside; by default nobody has it open and it is idle. */
  threadViews = new Map<string, ThreadView>();
  wakes: WakeOptions[] = [];
  wakeAnswer = "The price moved on earnings; details in the thread.";
  private threads = 0;

  async inspectThread(threadId: string): Promise<ThreadView> {
    return this.threadViews.get(threadId) ?? { mentions: false, busy: false };
  }

  async wakeThread(options: WakeOptions): Promise<ExecResult> {
    this.wakes.push(options);
    return { ok: true, threadId: options.threadId, lastMessage: this.wakeAnswer };
  }

  async queue(threadId: string, message: string): Promise<{ submissionId?: string }> {
    if (this.queueError) throw this.queueError;
    this.queued.push({ threadId, message });
    return { submissionId: `sub-${this.queued.length}` };
  }

  async startThread(options: { cwd: string; name: string; prompt: string }): Promise<ExecResult> {
    this.started.push({ cwd: options.cwd, name: options.name, prompt: options.prompt });
    if (this.appServerBroken) return { ok: false, error: "codex app-server: unknown method thread/start" };
    this.threads += 1;
    return { ok: true, threadId: `thread-dedicated-${this.threads}`, lastMessage: '{"summary":"ready","notify":false}' };
  }

  async exec(options: { cwd: string; prompt: string }): Promise<ExecResult> {
    this.execs.push({ cwd: options.cwd, prompt: options.prompt });
    this.threads += 1;
    return { ok: true, threadId: `thread-dedicated-${this.threads}`, lastMessage: '{"summary":"ready","notify":false}' };
  }

  async resume(options: { threadId: string; prompt: string; sandbox: string }): Promise<ExecResult> {
    this.resumes.push({ threadId: options.threadId, prompt: options.prompt, sandbox: options.sandbox });
    return this.resumeOk
      ? { ok: true, threadId: options.threadId, lastMessage: this.resumeAnswer }
      : { ok: false, threadId: options.threadId, error: "the model is unavailable" };
  }
}

export class RecordingNotifier implements Notifier {
  sent: Notification[] = [];
  async notify(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
}

export const STATE_PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const res = await fetch(input.params.url + "/price");
const { price } = await res.json();
console.log(JSON.stringify({
  fire: price > input.params.threshold,
  summary: "price " + price,
  data: { price },
  state: { runs: (input.state?.runs ?? 0) + 1 },
}));
`;

export const EVENT_PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const items = await (await fetch(input.params.url + "/events")).json();
console.log(JSON.stringify({
  events: items.map((item) => ({ key: item.id, summary: item.title })),
  summary: items.length + " items",
}));
`;

/** Waits until `check` returns a truthy value, polling every 20 ms. */
export async function eventually<T>(check: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
