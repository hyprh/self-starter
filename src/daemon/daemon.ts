// self-starter daemon: the background process that runs probes (Engine), hands fires to
// Codex (Executor), and answers the control API (TriggerService).

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelNotifier } from "../engine/channels.js";
import { CodexCli, type CodexRunner } from "../engine/codex.js";
import { loadConfig, resolveCodex, resolveDeno } from "../engine/config.js";
import { Engine } from "../engine/engine.js";
import { Executor } from "../engine/executor.js";
import { FireLog } from "../engine/fires.js";
import { SystemNotifier, type Notifier } from "../engine/notify.js";
import { resolvePaths, type Paths } from "../engine/paths.js";
import { Secrets } from "../engine/secrets.js";
import { TriggerService } from "../engine/service.js";
import { Store } from "../engine/store.js";
import { PACKAGE_ROOT, VERSION } from "../runtime.js";
import { startControlServer } from "./control.js";

const LOG_MAX_BYTES = 2 * 1024 * 1024;

export class AlreadyRunning extends Error {}

export interface DaemonOptions {
  paths?: Paths;
  notifier?: Notifier;
  /** Overrides how the codex CLI is reached (tests). */
  codex?: () => CodexRunner | undefined;
  logToStderr?: boolean;
  now?: () => Date;
  /** Called when a client asks the daemon to stop. */
  onStopRequest?: () => void;
  /** Folder of ready-made recipes; defaults to recipes/ in the package. */
  recipesDir?: string;
}

export interface Daemon {
  paths: Paths;
  store: Store;
  fires: FireLog;
  engine: Engine;
  executor: Executor;
  service: TriggerService;
  log: (line: string) => void;
  stop(): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lock files held by daemons in this process. */
const heldLocks = new Set<string>();

/** A pid file that keeps a second daemon from starting. */
function acquireLock(path: string): () => void {
  if (heldLocks.has(path)) throw new AlreadyRunning(`self-starter daemon is already running (pid ${process.pid})`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      heldLocks.add(path);
      return () => {
        heldLocks.delete(path);
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      // Our own pid in the file means a previous daemon crashed and the pid was reused.
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new AlreadyRunning(`self-starter daemon is already running (pid ${pid})`);
      }
      rmSync(path, { force: true }); // left behind by a daemon that crashed
    }
  }
  throw new Error(`could not create the lock file ${path}`);
}

function createLogger(paths: Paths, toStderr: boolean): (line: string) => void {
  const file = join(paths.logs, "daemon.log");
  if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  return (line: string) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      appendFileSync(file, entry, { mode: 0o600 });
    } catch {
      // logging must never take the daemon down
    }
    if (toStderr) process.stderr.write(entry);
  };
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const paths = options.paths ?? resolvePaths();
  const store = new Store(paths);
  store.ensureLayout();
  const log = createLogger(paths, options.logToStderr ?? false);
  const releaseLock = acquireLock(paths.lock);
  try {
    const config = loadConfig(paths);
    const fires = new FireLog(paths.fires);
    const secrets = new Secrets(paths);
    const notifier = options.notifier ?? new ChannelNotifier(paths, new SystemNotifier(log), log);
    const codexBin = () => resolveCodex(config);
    const codex =
      options.codex ??
      (() => {
        const bin = codexBin();
        return bin ? new CodexCli(bin) : undefined;
      });
    const deno = () => resolveDeno(config);
    const clock = options.now ? { now: options.now } : {};
    const executor = new Executor({ store, fires, paths, config, notifier, codex, log, ...clock });
    const engine = new Engine({ store, executor, secrets, paths, config, deno, log, ...clock });
    const recipesDir = options.recipesDir ?? join(PACKAGE_ROOT, "recipes");
    const service = new TriggerService({ store, fires, engine, executor, paths, config, version: VERSION, recipesDir, deno, codexBin, log, ...clock });
    const handlers = service.handlers();
    handlers["daemon.stop"] = () => {
      setTimeout(() => options.onStopRequest?.(), 50);
      return { stopping: options.onStopRequest !== undefined };
    };
    const server = await startControlServer(paths.socket, handlers, log);
    engine.start();
    executor.kick();
    log(`self-starter daemon ${VERSION} started (pid ${process.pid}, home ${paths.home}, deno ${deno() ?? "missing"}, codex ${codexBin() ?? "missing"})`);
    return {
      paths,
      store,
      fires,
      engine,
      executor,
      service,
      log,
      async stop() {
        engine.stop();
        executor.close();
        await server.close();
        releaseLock();
        log("self-starter daemon stopped");
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}
