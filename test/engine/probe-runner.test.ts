import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundledDeno } from "../../src/engine/config.js";
import { denoArgs, runProbe, type ProbeInput } from "../../src/engine/probe-runner.js";
import type { TriggerDefinition } from "../../src/core/definition.js";
import { makeDefinition } from "../helpers.js";
import { eventually, STATE_PROBE, startServer, tempHome, type TestServer } from "./fixtures.js";

const deno = bundledDeno();

/** Whether a process is still running (a zombie waiting to be reaped counts as gone). */
function running(pid: number): boolean {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

describe("probe runner", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  let server: TestServer;
  let home: ReturnType<typeof tempHome>;

  before(async () => {
    server = await startServer();
    home = tempHome();
  });
  after(async () => {
    await server.close();
    home.cleanup();
  });

  function probe(code: string, overrides: Record<string, unknown> = {}, access = "full"): { definition: TriggerDefinition; dir: string } {
    const definition = makeDefinition({
      probe: {
        entry: "probe.ts",
        access,
        params: { url: server.origin, threshold: 150 },
        permissions: { net: [server.host], env: [] },
        timeout: "10s",
      },
      ...overrides,
    });
    const dir = join(home.paths.home, `probe-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "probe.ts"), code);
    return { definition, dir };
  }

  function input(definition: TriggerDefinition, state: unknown = null): ProbeInput {
    return { version: 1, trigger_id: definition.id, now: new Date().toISOString(), params: definition.probe.params, state, last: null };
  }

  const run = (definition: TriggerDefinition, dir: string, extra: { env?: Record<string, string>; timeoutMs?: number; state?: unknown; cwd?: string } = {}) =>
    runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
      definition,
      input: input(definition, extra.state ?? null),
      env: extra.env ?? {},
      ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    });

  it("passes only the declared permissions to a sandboxed probe", () => {
    const definition = makeDefinition({ probe: { access: "sandbox", permissions: { net: ["api.example.com"], env: ["API_KEY"] } } });
    const args = denoArgs(definition, "/x/probe.ts");
    assert.ok(args.includes("--allow-net=api.example.com"));
    assert.ok(args.includes("--allow-env=API_KEY"));
    assert.ok(args.includes("--no-remote") && args.includes("--no-npm") && args.includes("--no-prompt"));
    assert.ok(!args.some((a) => a.startsWith("--allow-read") || a.startsWith("--allow-write") || a.startsWith("--allow-run") || a === "--allow-all"));
    assert.equal(args.at(-1), "/x/probe.ts");
  });

  it("gives a full-access probe everything", () => {
    const args = denoArgs(makeDefinition(), "/x/probe.ts");
    assert.ok(args.includes("--allow-all") && args.includes("--no-prompt"));
    assert.ok(!args.includes("--no-remote") && !args.includes("--no-npm"));
    assert.equal(args.at(-1), "/x/probe.ts");
  });

  it("runs a full-access probe as the user: files, commands, environment and its working folder", async () => {
    const work = join(home.paths.home, "project");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "build.log"), "step 1\nstep 2\nDONE in 42s\n");
    const { definition, dir } = probe(`
      const log = await Deno.readTextFile("build.log");
      const out = await new Deno.Command("sh", { args: ["-c", "echo from-a-command"] }).output();
      const summary = [log.trim().split("\\n").at(-1), new TextDecoder().decode(out.stdout).trim(), Deno.env.get("HOME") ? "home set" : "no home"].join(" | ");
      console.log(JSON.stringify({ fire: log.includes("DONE"), summary }));
    `);
    const result = await run(definition, dir, { cwd: work });
    assert.ok(result.ok, result.ok ? "" : `${result.error}\n${result.stderr}`);
    assert.equal(result.output.summary, "DONE in 42s | from-a-command | home set");
    assert.equal(result.output.mode === "state" && result.output.fire, true);
  });

  it("stops the commands a probe started when it times out", async () => {
    const { definition, dir } = probe(`
      const child = new Deno.Command("sleep", { args: ["30"] }).spawn();
      await Deno.writeTextFile("child.pid", String(child.pid));
      await child.status;
    `);
    const result = await run(definition, dir, { timeoutMs: 1500 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /timed out/);
    const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    await eventually(() => !running(pid));
  });

  it("runs a probe that fetches from an allowed host and reads its state", async () => {
    server.price = 160;
    const { definition, dir } = probe(STATE_PROBE);
    const result = await run(definition, dir, { state: { runs: 2 } });
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.output.mode, "state");
    assert.equal(result.output.mode === "state" && result.output.fire, true);
    assert.equal(result.output.summary, "price 160");
    assert.deepEqual(result.output.state, { runs: 3 });
  });

  it("blocks hosts a sandboxed probe did not declare", async () => {
    const { definition, dir } = probe(`await fetch("http://example.com/"); console.log("{}");`, {}, "sandbox");
    const result = await run(definition, dir);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /NotCapable|Requires net access|permission/i);
  });

  it("blocks file access, commands and undeclared environment variables in the sandbox", async () => {
    const files = probe(`await Deno.readTextFile("/etc/hostname"); console.log("{}");`, {}, "sandbox");
    const fileResult = await run(files.definition, files.dir);
    assert.equal(fileResult.ok, false);
    assert.match(fileResult.ok ? "" : fileResult.error, /read access|NotCapable|permission/i);

    const command = probe(`await new Deno.Command("/bin/sh", { args: ["-c", "true"] }).output(); console.log("{}");`, {}, "sandbox");
    const commandResult = await run(command.definition, command.dir);
    assert.equal(commandResult.ok, false);
    assert.match(commandResult.ok ? "" : commandResult.error, /run access|NotCapable|permission/i);

    const env = probe(`console.log(JSON.stringify({ fire: false, summary: String(Deno.env.get("HOME")) }));`, {}, "sandbox");
    const envResult = await run(env.definition, env.dir);
    assert.equal(envResult.ok, false);
    assert.match(envResult.ok ? "" : envResult.error, /env access|NotCapable|permission/i);
  });

  it("gives declared secrets to a sandboxed probe as environment variables", async () => {
    const { definition, dir } = probe(`console.log(JSON.stringify({ fire: false, summary: "key=" + Deno.env.get("API_KEY") }));`, {
      probe: { entry: "probe.ts", access: "sandbox", params: {}, permissions: { net: [], env: ["API_KEY"] } },
    });
    const result = await run(definition, dir, { env: { API_KEY: "s3cret" } });
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.output.summary, "key=s3cret");
  });

  it("reports thrown errors, bad output and timeouts as failures", async () => {
    const thrown = probe(`throw new Error("upstream said 503");`);
    const thrownResult = await run(thrown.definition, thrown.dir);
    assert.equal(thrownResult.ok, false);
    assert.equal(thrownResult.ok ? "" : thrownResult.error, "exited with code 1: Error: upstream said 503");

    const bad = probe(`console.log("not json");`);
    const badResult = await run(bad.definition, bad.dir);
    assert.equal(badResult.ok, false);
    assert.match(badResult.ok ? "" : badResult.error, /not a JSON object/);

    const slow = probe(`await new Promise((r) => setTimeout(r, 5000)); console.log("{}");`);
    const slowResult = await run(slow.definition, slow.dir, { timeoutMs: 1500 });
    assert.equal(slowResult.ok, false);
    assert.match(slowResult.ok ? "" : slowResult.error, /timed out/);
  });
});
