import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundledDeno } from "../../src/engine/config.js";
import { denoArgs, runProbe, type ProbeInput } from "../../src/engine/probe-runner.js";
import type { TriggerDefinition } from "../../src/core/definition.js";
import { makeDefinition } from "../helpers.js";
import { STATE_PROBE, startServer, tempHome, type TestServer } from "./fixtures.js";

const deno = bundledDeno();

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

  function probe(code: string, overrides: Record<string, unknown> = {}): { definition: TriggerDefinition; dir: string } {
    const definition = makeDefinition({
      probe: {
        entry: "probe.ts",
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

  const run = (definition: TriggerDefinition, dir: string, extra: { env?: Record<string, string>; timeoutMs?: number; state?: unknown } = {}) =>
    runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      definition,
      input: input(definition, extra.state ?? null),
      env: extra.env ?? {},
      ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    });

  it("passes only the declared permissions to deno", () => {
    const definition = makeDefinition({ probe: { permissions: { net: ["api.example.com"], env: ["API_KEY"] } } });
    const args = denoArgs(definition, "/x/probe.ts");
    assert.ok(args.includes("--allow-net=api.example.com"));
    assert.ok(args.includes("--allow-env=API_KEY"));
    assert.ok(args.includes("--no-remote") && args.includes("--no-npm") && args.includes("--no-prompt"));
    assert.ok(!args.some((a) => a.startsWith("--allow-read") || a.startsWith("--allow-write") || a.startsWith("--allow-run")));
    assert.equal(args.at(-1), "/x/probe.ts");
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

  it("blocks hosts that are not declared", async () => {
    const { definition, dir } = probe(`await fetch("http://example.com/"); console.log("{}");`);
    const result = await run(definition, dir);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /NotCapable|Requires net access|permission/i);
  });

  it("blocks file access and undeclared environment variables", async () => {
    const files = probe(`await Deno.readTextFile("/etc/hostname"); console.log("{}");`);
    const fileResult = await run(files.definition, files.dir);
    assert.equal(fileResult.ok, false);
    assert.match(fileResult.ok ? "" : fileResult.error, /read access|NotCapable|permission/i);

    const env = probe(`console.log(JSON.stringify({ fire: false, summary: String(Deno.env.get("HOME")) }));`);
    const envResult = await run(env.definition, env.dir);
    assert.equal(envResult.ok, false);
    assert.match(envResult.ok ? "" : envResult.error, /env access|NotCapable|permission/i);
  });

  it("gives declared secrets to the probe as environment variables", async () => {
    const { definition, dir } = probe(`console.log(JSON.stringify({ fire: false, summary: "key=" + Deno.env.get("API_KEY") }));`, {
      probe: { entry: "probe.ts", params: {}, permissions: { net: [], env: ["API_KEY"] } },
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
