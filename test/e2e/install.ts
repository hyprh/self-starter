// End to end on this machine, the way a user installs Self-Starter (see
// "Install" and "Try it in two minutes" in the README). `self-starter install`
// registers the plugin with the real Codex CLI and starts the background
// service: launchd on macOS, systemd on Linux. A trigger made through the MCP
// server, as Codex makes one, waits for a file and fires when it appears. Then
// the service brings the daemon back after a crash, installing again keeps the
// triggers, and `uninstall --purge` removes everything. It replaces the
// background service of any installation on the machine, so it only runs in CI
// (the Install job): node dist/test/e2e/install.js

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { callDaemon } from "../../src/client/client.js";
import { resolvePaths } from "../../src/engine/paths.js";
import { LAUNCHD_LABEL, serviceManager, SYSTEMD_UNIT } from "../../src/service/manager.js";
import { cli, createTrigger, show, waitFor } from "./harness.js";

if (!process.env.CI) {
  console.error("This replaces the Self-Starter background service on this machine, so it only runs in CI (CI=1 runs it anyway).");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "self-starter-install-"));
const env = { ...process.env, SELF_STARTER_HOME: join(scratch, "home"), CODEX_HOME: join(scratch, "codex") };
mkdirSync(env.CODEX_HOME, { recursive: true });
const paths = resolvePaths(env.SELF_STARTER_HOME);
const manager = serviceManager();
const selfStarter = (args: string[]) => cli(env, args);

const demoFile = join(scratch, "demo", "done");
const DEFINITION = {
  id: "demo-file",
  name: "Demo file",
  intent: "Tell me when the demo file appears, and what it says",
  probe: { params: { path: demoFile }, interval: { min: "10s", default: "10s" } },
  mode: "state",
  action: { type: "notify" },
  policy: { max_fires: 1 },
};
const PROBE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const text = await Deno.readTextFile(input.params.path).catch(() => null);
console.log(JSON.stringify(text === null ? { fire: false, summary: "no file yet" } : { fire: true, summary: "it says: " + text.trim() }));
`;

/** What the service manager says about the background service. */
function serviceState(): string {
  if (process.platform === "darwin") {
    const out = spawnSync("launchctl", ["print", `gui/${userInfo().uid}/${LAUNCHD_LABEL}`], { encoding: "utf8" });
    return out.status === 0 ? (/^\s*state = (.+)$/m.exec(out.stdout)?.[1] ?? "loaded") : "not loaded";
  }
  return spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { encoding: "utf8" }).stdout.trim() || "unknown";
}

const RUNNING = process.platform === "darwin" ? "running" : "active";

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
  console.log(`✓ ${what}`);
}

const daemonPid = () =>
  callDaemon<{ pid: number }>(paths.socket, "status", {}, { via: "cli" }, 2000).then(
    (status) => status.pid,
    () => undefined,
  );

const codexPlugins = () => spawnSync("codex", ["plugin", "list"], { encoding: "utf8", env }).stdout ?? "";

async function main(): Promise<void> {
  expect(manager.kind !== "none", `this machine has a service manager (${manager.kind})`);

  show("self-starter install", await selfStarter(["install"]));
  expect(serviceState() === RUNNING, `${manager.kind} runs the service (${serviceState()})`);
  show("self-starter doctor", await selfStarter(["doctor"]));

  show("(Codex, through MCP) trigger_draft, trigger_activate", await createTrigger(env, DEFINITION, PROBE));
  mkdirSync(join(scratch, "demo"), { recursive: true });
  writeFileSync(demoFile, "build finished in 4m12s\n");
  console.log(`\n$ echo "build finished in 4m12s" > ${demoFile}`);
  const history = await waitFor(
    "the trigger to fire",
    async () => {
      const text = await selfStarter(["history", DEFINITION.id]);
      return /#1\s+done/.test(text) ? text : undefined;
    },
    { timeoutMs: 60_000, explain: () => selfStarter(["show", DEFINITION.id]) },
  );
  show(`self-starter history ${DEFINITION.id}`, history);

  const before = await daemonPid();
  if (before === undefined) throw new Error("the daemon does not answer");
  process.kill(before, "SIGKILL");
  const after = await waitFor(
    "the service to start the daemon again",
    async () => {
      const pid = await daemonPid();
      return pid !== undefined && pid !== before ? pid : undefined;
    },
    { timeoutMs: 60_000 },
  );
  console.log(`✓ after a crash, ${manager.kind} started the daemon again (pid ${before} → ${after})`);

  show("self-starter install", await selfStarter(["install"]));
  const list = await selfStarter(["list"]);
  show("self-starter list", list);
  expect(list.includes(DEFINITION.id) && serviceState() === RUNNING, "installing again keeps the service running and the triggers");

  show("self-starter uninstall --purge", await selfStarter(["uninstall", "--purge"]));
  expect(serviceState() !== RUNNING && !existsSync(manager.file!), `the service is gone (${serviceState()})`);
  expect(!codexPlugins().includes("self-starter"), "Codex no longer lists the plugin");
  expect(!existsSync(paths.home), "the Self-Starter folder is gone");
}

try {
  await main();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  const serviceLog = join(paths.logs, "service.log");
  if (existsSync(serviceLog)) console.error(`\nservice.log:\n${readFileSync(serviceLog, "utf8").slice(-4000)}`);
  console.error(`\nself-starter logs:\n${await selfStarter(["logs", "-n", "40"]).catch((e: Error) => e.message)}`);
  await selfStarter(["uninstall", "--purge"]).catch(() => undefined);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
