import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, saveConfig } from "../../src/engine/config.js";
import { VERSION } from "../../src/runtime.js";
import { compareVersions, daemonVersion, ensureDaemon, stopRunningDaemon } from "../../src/service/manager.js";
import { tempHome } from "../engine/fixtures.js";

/** Listens on the daemon's socket like a daemon of `version`, and stops when asked to. */
async function fakeDaemon(socket: string, version: string): Promise<{ stopped: boolean; close: () => Promise<void> }> {
  const state = { stopped: false, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  const server: Server = createServer((connection) => {
    connection.setEncoding("utf8");
    connection.on("data", (line: string) => {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      connection.end(`${JSON.stringify({ id, result: method === "ping" ? { version, pid: 1 } : {} })}\n`);
      if (method === "daemon.stop") {
        state.stopped = true;
        server.close();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return state;
}

describe("service manager", () => {
  it("compares versions", () => {
    assert.equal(compareVersions("0.0.1", "0.1.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), 0);
  });

  it("leaves a newer daemon running, and replaces an older one with this version", async () => {
    const home = tempHome();
    // A test must not touch the user's launchd or systemd services.
    saveConfig(home.paths, { ...loadConfig(home.paths), service: false });
    try {
      const newer = await fakeDaemon(home.paths.socket, "99.0.0");
      assert.equal(await ensureDaemon(home.paths), "running");
      assert.equal(newer.stopped, false);
      await newer.close();

      const older = await fakeDaemon(home.paths.socket, "0.0.0");
      assert.equal(await ensureDaemon(home.paths), "started");
      assert.equal(older.stopped, true);
      assert.equal(await daemonVersion(home.paths.socket), VERSION);
      assert.equal(execFileSync(join(home.paths.home, "bin", "self-starter"), ["version"], { encoding: "utf8" }).trim(), VERSION, "and its command runs this installation");
    } finally {
      await stopRunningDaemon(home.paths);
      home.cleanup();
    }
  });
});
