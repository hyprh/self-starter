// `self-starter ui`: opens the local Attention Inbox, watch console and outbound
// channel router on 127.0.0.1 without keeping an open TCP port when closed.

import { spawn } from "node:child_process";
import type { Paths } from "../engine/paths.js";
import { ensureDaemon } from "../service/manager.js";
import { startUiServer } from "../ui/server.js";
import { flag, out, UsageError, type Args } from "./io.js";

function canOpenBrowser(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // non-fatal: user can click the printed URL
  }
}

export async function uiCommand(paths: Paths, args: Args): Promise<void> {
  const portFlag = flag(args, "port");
  let port: number | undefined;
  if (portFlag !== undefined) {
    port = Number(portFlag);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`invalid --port: ${portFlag}`);
    }
  }

  await ensureDaemon(paths);
  const ui = await startUiServer({
    paths,
    ...(port !== undefined ? { port, strictPort: true } : {}),
  });

  out(`Self-Starter Console listening on 127.0.0.1:${ui.port}`);
  out(`  Open: ${ui.url}`);
  if (!canOpenBrowser()) {
    out(`  Remote / SSH tip: forward local port ${ui.port} (e.g. ssh -L ${ui.port}:127.0.0.1:${ui.port} <server>) and open the URL above.`);
  }
  out("  Press Ctrl-C to close the console (background watches keep running).");

  if (!args.flags.has("no-open") && canOpenBrowser()) {
    openBrowser(ui.url);
  }

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void ui.close().then(() => {
        out("\nClosed console (background watches keep running).");
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
