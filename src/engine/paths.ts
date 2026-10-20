import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Where everything lives. SELF_STARTER_HOME overrides the default ~/.self-starter. */
export interface Paths {
  home: string;
  triggers: string;
  drafts: string;
  fires: string;
  runs: string;
  config: string;
  secrets: string;
  /** SMTP password for the email channel; never given to probes. */
  channelSecrets: string;
  socket: string;
  lock: string;
  logs: string;
  denoDir: string;
  /** The local plugin marketplace that `self-starter install` registers with Codex. */
  marketplace: string;
  /** Claude Code session state and ZCode CLI session locks. */
  sessions: string;
  /** One file per running Claude Code process: the session it shows and its inbox socket. */
  inboxes: string;
}

/** Unix socket paths are limited to about 100 bytes; long ones are replaced by a socket in the temp folder. */
const SOCKET_PATH_MAX = 100;

/** `path`, or when it is too long for a Unix socket, a short one in the temp folder that is the same for the same `seed`. */
export function socketPath(path: string, seed: string): string {
  if (Buffer.byteLength(path) <= SOCKET_PATH_MAX) return path;
  return join(tmpdir(), `self-starter-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}.sock`);
}

export function resolvePaths(given = process.env.SELF_STARTER_HOME || join(homedir(), ".self-starter")): Paths {
  // Absolute and normalized: the CLI, the service and the MCP servers Codex starts
  // in other folders must all find the same files and the same socket.
  const home = resolve(given);
  const socket = socketPath(join(home, "daemon.sock"), home);
  return {
    home,
    triggers: join(home, "triggers"),
    drafts: join(home, "drafts"),
    fires: join(home, "fires.jsonl"),
    runs: join(home, "runs.jsonl"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.json"),
    channelSecrets: join(home, "channel-secrets.json"),
    socket,
    lock: join(home, "daemon.pid"),
    logs: join(home, "logs"),
    denoDir: join(home, "deno-cache"),
    marketplace: join(home, "marketplace"),
    sessions: join(home, "sessions"),
    inboxes: join(home, "inboxes"),
  };
}
