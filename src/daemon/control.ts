// The control API: newline-delimited JSON requests on a Unix socket that only
// the current user can open. Used by the MCP server and by ctrig.
//
//   request:  {"id": 1, "method": "trigger.list", "params": {...}, "caller": {...}}
//   response: {"id": 1, "result": ...}  or  {"id": 1, "error": {"code": "...", "message": "..."}}

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { Caller } from "../engine/service.js";
import { ServiceError } from "../engine/service.js";

const MAX_LINE_BYTES = 1024 * 1024;

export type Handler = (params: Record<string, unknown>, caller: Caller) => unknown;

export interface ControlServer {
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCaller(raw: unknown): Caller {
  const value = isRecord(raw) ? raw : {};
  const caller: Caller = { via: value.via === "mcp" ? "mcp" : "cli" };
  if (typeof value.threadId === "string" && value.threadId) caller.threadId = value.threadId;
  if (typeof value.turnId === "string" && value.turnId) caller.turnId = value.turnId;
  if (typeof value.turnTrigger === "string" && value.turnTrigger) caller.turnTrigger = value.turnTrigger;
  return caller;
}

async function handleLine(line: string, handlers: Record<string, Handler>, log: (line: string) => void): Promise<string> {
  let request: { id?: unknown; method?: unknown; params?: unknown; caller?: unknown };
  try {
    request = JSON.parse(line) as typeof request;
  } catch {
    return JSON.stringify({ id: null, error: { code: "invalid", message: "the request is not JSON" } });
  }
  const id = request.id ?? null;
  const handler = typeof request.method === "string" ? handlers[request.method] : undefined;
  if (!handler) return JSON.stringify({ id, error: { code: "not_found", message: `unknown method: ${String(request.method)}` } });
  try {
    const result = await handler(isRecord(request.params) ? request.params : {}, parseCaller(request.caller));
    return JSON.stringify({ id, result: result ?? null });
  } catch (error) {
    if (error instanceof ServiceError) return JSON.stringify({ id, error: { code: error.code, message: error.message } });
    log(`${String(request.method)} failed: ${(error as Error).stack ?? error}`);
    return JSON.stringify({ id, error: { code: "internal", message: (error as Error).message } });
  }
}

function serve(socket: Socket, handlers: Record<string, Handler>, log: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        void handleLine(line, handlers, log).then((response) => {
          if (!socket.destroyed) socket.write(`${response}\n`);
        });
      }
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => socket.destroy());
}

/** Listens on `socketPath`. The caller must make sure no other daemon is using it. */
export async function startControlServer(
  socketPath: string,
  handlers: Record<string, Handler>,
  log: (line: string) => void,
): Promise<ControlServer> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, handlers, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          try {
            unlinkSync(socketPath);
          } catch {
            // already gone
          }
          resolve();
        });
      }),
  };
}
