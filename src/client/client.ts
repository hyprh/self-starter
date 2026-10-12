// Client side of the control API, used by the MCP server and by self-starter.

import { connect } from "node:net";
import type { Caller } from "../engine/service.js";

/** No daemon is listening on the socket. */
export class DaemonUnavailable extends Error {}

/** The daemon answered with an error. */
export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let nextId = 1;

/** Sends one request on a fresh connection and waits for its response. */
export function callDaemon<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  caller: Caller = { via: "cli" },
  timeoutMs = 120_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`the self-starter daemon did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params, caller })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let message: { result?: T; error?: { code: string; message: string } };
      try {
        message = JSON.parse(buffer.slice(0, newline)) as typeof message;
      } catch {
        settle(() => reject(new Error("the daemon sent a response that is not JSON")));
        return;
      }
      settle(() => (message.error ? reject(new RemoteError(message.error.code, message.error.message)) : resolve(message.result as T)));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? new DaemonUnavailable("the self-starter daemon is not running")
            : error,
        ),
      );
    });
    socket.on("close", () => settle(() => reject(new Error("the daemon closed the connection without answering"))));
  });
}

export async function isDaemonRunning(socketPath: string): Promise<boolean> {
  try {
    await callDaemon(socketPath, "ping", {}, { via: "cli" }, 3000);
    return true;
  } catch {
    return false;
  }
}

export async function waitForDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
