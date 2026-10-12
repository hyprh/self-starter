import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where everything lives. CODEX_TRIGGERS_HOME overrides the default ~/.codex-triggers. */
export interface Paths {
  home: string;
  triggers: string;
  drafts: string;
  fires: string;
  runs: string;
  config: string;
  secrets: string;
  socket: string;
  lock: string;
  logs: string;
  denoDir: string;
  receiptSchema: string;
  /** The local plugin marketplace that `ctrig install` registers with Codex. */
  marketplace: string;
}

/** Unix socket paths are limited to about 100 bytes; long homes get a socket in the temp folder. */
const SOCKET_PATH_MAX = 100;

export function resolvePaths(home = process.env.CODEX_TRIGGERS_HOME || join(homedir(), ".codex-triggers")): Paths {
  let socket = join(home, "ctrigd.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    const digest = createHash("sha256").update(home).digest("hex").slice(0, 16);
    socket = join(tmpdir(), `ctrigd-${digest}.sock`);
  }
  return {
    home,
    triggers: join(home, "triggers"),
    drafts: join(home, "drafts"),
    fires: join(home, "fires.jsonl"),
    runs: join(home, "runs.jsonl"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.json"),
    socket,
    lock: join(home, "ctrigd.pid"),
    logs: join(home, "logs"),
    denoDir: join(home, "deno-cache"),
    receiptSchema: join(home, "receipt.schema.json"),
    marketplace: join(home, "marketplace"),
  };
}
