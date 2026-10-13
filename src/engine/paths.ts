import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
}

/** Unix socket paths are limited to about 100 bytes; long homes get a socket in the temp folder. */
const SOCKET_PATH_MAX = 100;

export function resolvePaths(home = process.env.SELF_STARTER_HOME || join(homedir(), ".self-starter")): Paths {
  let socket = join(home, "daemon.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    const digest = createHash("sha256").update(home).digest("hex").slice(0, 16);
    socket = join(tmpdir(), `self-starter-${digest}.sock`);
  }
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
  };
}
