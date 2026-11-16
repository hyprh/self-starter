import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { validateDefinition, type TriggerDefinition } from "../../src/core/definition.js";
import { bundledDeno } from "../../src/engine/config.js";
import { runProbe } from "../../src/engine/probe-runner.js";
import { applyRecipe, listRecipes, loadRecipe } from "../../src/engine/recipes.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { tempHome } from "../engine/fixtures.js";

const deno = bundledDeno();
const RECIPES = join(PACKAGE_ROOT, "recipes");
const NOW = "2026-11-16T03:00:00Z";

describe("built-in recipe catalog", () => {
  it("loads all five official engineering and market recipes", () => {
    const ids = listRecipes(RECIPES).map((r) => r.id);
    assert.deepEqual(ids, ["futu-news", "github-ci", "http-health", "ibkr-account", "log-watch"]);
  });
});

describe("github-ci recipe", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  const { recipe } = loadRecipe(RECIPES, "github-ci");
  const dir = join(RECIPES, "github-ci");
  let home: ReturnType<typeof tempHome>;
  let scratch: string;
  let fakeGh: string;
  let responsesFile: string;

  before(() => {
    home = tempHome();
    scratch = mkdtempSync(join(tmpdir(), "ss-gh-recipe-"));
    responsesFile = join(scratch, "responses.json");
    fakeGh = join(scratch, "fake-gh");
    writeFileSync(
      fakeGh,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        "const table = JSON.parse(fs.readFileSync(" + JSON.stringify(responsesFile) + ', "utf8"));',
        "const args = process.argv.slice(2);",
        'if (args[0] === "repo" && args[1] === "view") {',
        "  if (!table.__repo) { console.error('not a git repo'); process.exit(1); }",
        "  console.log(table.__repo);",
        "  process.exit(0);",
        "}",
        'if (args[0] === "api") {',
        "  const endpoint = args.at(-1);",
        "  if (!(endpoint in table)) { console.error('unexpected endpoint: ' + endpoint); process.exit(1); }",
        "  const entry = table[endpoint];",
        "  if (entry && entry.__error) { console.error(entry.__error); process.exit(1); }",
        "  console.log(JSON.stringify(entry));",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
    );
    chmodSync(fakeGh, 0o755);
  });

  after(() => {
    home.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  function definition(params: Record<string, unknown>): TriggerDefinition {
    const applied = applyRecipe(recipe, {
      id: "gh-watch",
      name: "GitHub watch",
      intent: "Watch PR and CI",
      probe: { params: { gh_bin: fakeGh, ...params } },
      action: { type: "notify" },
    });
    assert.deepEqual(applied.errors, []);
    const validated = validateDefinition(applied.definition);
    if (!validated.ok) assert.fail(validated.errors.join("; "));
    return validated.definition;
  }

  function run(def: TriggerDefinition, cwd = scratch) {
    return runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      cwd,
      definition: def,
      input: { version: 1, trigger_id: def.id, now: NOW, params: def.probe.params, state: null, last: null },
      env: {},
    });
  }

  it("validates parameters and locks access and permissions", () => {
    const bad = applyRecipe(recipe, {
      mode: "state",
      probe: { access: "sandbox", permissions: { net: ["api.github.com"], env: [] }, params: { unknown_knob: 1 } },
    });
    assert.match(bad.errors.join("\n"), /runs in event mode/);
    assert.match(bad.errors.join("\n"), /runs with full access/);
    assert.match(bad.errors.join("\n"), /fixes the probe's permissions/);
    assert.match(bad.errors.join("\n"), /no parameter unknown_knob/);
  });

  it("watches a pull request for failed checks, reviews, comments, and merge conflicts while skipping ignored actors", async () => {
    const headSha = "abcdef1234567890fedcba";
    writeFileSync(
      responsesFile,
      JSON.stringify({
        __repo: "acme/widget",
        "repos/acme/widget/pulls/42": {
          number: 42,
          state: "open",
          merged: false,
          title: "Add event recipes",
          html_url: "https://github.com/acme/widget/pull/42",
          mergeable: false,
          mergeable_state: "dirty",
          head: { sha: headSha, ref: "feat/recipes" },
        },
        ["repos/acme/widget/commits/" + headSha + "/check-runs?per_page=100"]: {
          check_runs: [
            { id: 901, name: "CI / Test (ubuntu)", status: "completed", conclusion: "success", html_url: "https://github.com/acme/widget/runs/901" },
            { id: 902, name: "CI / Test (macos)", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/widget/runs/902" },
          ],
        },
        ["repos/acme/widget/commits/" + headSha + "/status"]: {
          statuses: [{ context: "vercel", state: "success" }],
        },
        "repos/acme/widget/pulls/42/reviews?per_page=50": [
          { id: 500, state: "PENDING", body: "draft", user: { login: "alice" } },
          { id: 501, state: "COMMENTED", body: "", user: { login: "alice" } },
          { id: 502, state: "CHANGES_REQUESTED", body: "Please handle log rotation.", user: { login: "alice" }, html_url: "https://github.com/acme/widget/pull/42#pullrequestreview-502" },
          { id: 503, state: "APPROVED", body: "LGTM", user: { login: "dependabot[bot]" } },
        ],
        "repos/acme/widget/pulls/42/comments?sort=created&direction=desc&per_page=30": [
          { id: 701, path: "src/probe.ts", line: 18, body: "Check offset reset on truncate.", user: { login: "bob" }, html_url: "https://github.com/acme/widget/pull/42#discussion_r701" },
        ],
        "repos/acme/widget/issues/42/comments?per_page=30": [
          { id: 801, body: "Can we also cover HEAD requests?", user: { login: "carol" }, html_url: "https://github.com/acme/widget/pull/42#issuecomment-801" },
          { id: 802, body: "Automated preview deployed", user: { login: "Dependabot[bot]" } },
        ],
      }),
    );

    const res = await run(definition({ pr: 42, ignore_actors: ["dependabot[bot]"] }));
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.equal(res.output.mode, "event");
    const keys = res.output.mode === "event" ? res.output.events.map((e) => e.key) : [];
    assert.deepEqual(keys, [
      "check-fail:acme/widget:pr-42:902",
      "conflict:acme/widget:pr-42:abcdef123456",
      "review:acme/widget:pr-42:502",
      "review-comment:acme/widget:pr-42:701",
      "issue-comment:acme/widget:pr-42:801",
    ]);
  });

  it("watches branch workflow runs on the current head commit and ignores superseded failures", async () => {
    const currentHead = "222222222222333333333333";
    const oldHead = "111111111111000000000000";
    writeFileSync(
      responsesFile,
      JSON.stringify({
        "repos/acme/widget/commits/main": { sha: currentHead },
        "repos/acme/widget/actions/workflows/ci.yml/runs?branch=main&per_page=25": {
          workflow_runs: [
            // Older failure on previous commit, plus older failed run superseded by a newer run on current commit:
            {
              id: 100,
              workflow_id: 1,
              name: "CI",
              run_number: 10,
              run_attempt: 1,
              created_at: "2026-11-16T02:00:00Z",
              head_sha: oldHead,
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/widget/actions/runs/100",
            },
            {
              id: 101,
              workflow_id: 1,
              name: "CI",
              run_number: 11,
              run_attempt: 2,
              created_at: "2026-11-16T02:30:00Z",
              head_sha: currentHead,
              status: "completed",
              conclusion: "timed_out",
              html_url: "https://github.com/acme/widget/actions/runs/101",
            },
          ],
        },
      }),
    );

    const failing = await run(definition({ repo: "acme/widget", branch: "main", workflow: "ci.yml", watch: ["ci", "ci_pass"] }));
    assert.ok(failing.ok, failing.ok ? "" : failing.error);
    assert.deepEqual(failing.output.mode === "event" && failing.output.events.map((e) => e.key), ["ci-fail:acme/widget:101:2"]);

    // Once a newer run #12 succeeds on currentHead, the superseded failure #11 no longer emits and ci_pass fires once.
    writeFileSync(
      responsesFile,
      JSON.stringify({
        "repos/acme/widget/commits/main": { sha: currentHead },
        "repos/acme/widget/actions/workflows/ci.yml/runs?branch=main&per_page=25": {
          workflow_runs: [
            {
              id: 102,
              workflow_id: 1,
              name: "CI",
              run_number: 12,
              run_attempt: 1,
              created_at: "2026-11-16T02:45:00Z",
              head_sha: currentHead,
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/widget/actions/runs/102",
            },
            {
              id: 101,
              workflow_id: 1,
              name: "CI",
              run_number: 11,
              run_attempt: 2,
              created_at: "2026-11-16T02:30:00Z",
              head_sha: currentHead,
              status: "completed",
              conclusion: "timed_out",
              html_url: "https://github.com/acme/widget/actions/runs/101",
            },
          ],
        },
      }),
    );
    const recovered = await run(definition({ repo: "acme/widget", branch: "main", workflow: "ci.yml", watch: ["ci", "ci_pass"] }));
    assert.ok(recovered.ok, recovered.ok ? "" : recovered.error);
    assert.deepEqual(recovered.output.mode === "event" && recovered.output.events.map((e) => e.key), [
      "ci-pass:acme/widget:main:ci.yml:222222222222",
    ]);
  });
});

describe("log-watch recipe", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  const { recipe } = loadRecipe(RECIPES, "log-watch");
  const dir = join(RECIPES, "log-watch");
  let home: ReturnType<typeof tempHome>;
  let scratch: string;

  before(() => {
    home = tempHome();
    scratch = mkdtempSync(join(tmpdir(), "ss-log-recipe-"));
  });

  after(() => {
    home.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  function definition(params: Record<string, unknown>): TriggerDefinition {
    const applied = applyRecipe(recipe, {
      id: "app-log",
      name: "App log watch",
      intent: "Watch app.log for errors",
      probe: { params },
      action: { type: "notify" },
    });
    assert.deepEqual(applied.errors, []);
    const validated = validateDefinition(applied.definition);
    if (!validated.ok) assert.fail(validated.errors.join("; "));
    return validated.definition;
  }

  function run(def: TriggerDefinition, state: unknown = null) {
    return runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      cwd: scratch,
      definition: def,
      input: { version: 1, trigger_id: def.id, now: NOW, params: def.probe.params, state, last: null },
      env: {},
    });
  }

  it("records EOF baseline on first run, groups stack traces incrementally, handles copytruncate rotation, and supports dedupe_by_line", async () => {
    const logFile = join(scratch, "app.log");
    writeFileSync(logFile, "2026-11-16T01:00:00Z ERROR historical failure before watch started\n");

    const def = definition({ path: "app.log", exclude: "healthcheck" });
    const first = await run(def, null);
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.deepEqual(first.output.mode === "event" && first.output.events, []);

    // Append routine INFO, an excluded ERROR, and a real multi-line stack trace.
    writeFileSync(
      logFile,
      [
        "2026-11-16T02:00:01Z INFO request ok",
        "2026-11-16T02:00:02Z ERROR healthcheck transient noise",
        "2026-11-16T02:00:03Z ERROR Unhandled exception in worker:",
        "    at processJob (src/worker.ts:42:11)",
        "    at async main (src/index.ts:10:3)",
        "Caused by: Error: connection reset",
        "",
      ].join("\n"),
      { flag: "a" },
    );

    const second = await run(def, first.output.state);
    assert.ok(second.ok, second.ok ? "" : second.error);
    const events2 = second.output.mode === "event" ? second.output.events : [];
    assert.equal(events2.length, 1, "one stack trace coalesces into one event while excluded noise is ignored");
    assert.match(String((events2[0]!.data as Record<string, unknown>).snippet), /at processJob/);
    assert.match(String((events2[0]!.data as Record<string, unknown>).snippet), /Caused by: Error: connection reset/);

    // Simulate copytruncate rotation with completely new content larger than 0 bytes.
    writeFileSync(
      logFile,
      "2026-11-16T02:10:00Z INFO rotated fresh file\n2026-11-16T02:10:01Z FATAL disk full on /var/lib/data\n",
    );
    const afterRotate = await run(def, second.output.state);
    assert.ok(afterRotate.ok, afterRotate.ok ? "" : afterRotate.error);
    const rotateEvents = afterRotate.output.mode === "event" ? afterRotate.output.events : [];
    assert.equal(rotateEvents.length, 1);
    assert.match(rotateEvents[0]!.summary ?? "", /FATAL disk full/);
    assert.equal((rotateEvents[0]!.data as Record<string, unknown>).rotated, true);

    // Verify dedupe_by_line collapses identical errors across different timestamps.
    const dedupeDef = definition({ path: "app.log", dedupe_by_line: true });
    writeFileSync(
      logFile,
      [
        "2026-11-16T02:20:01Z ERROR upstream timeout after 5000ms",
        "2026-11-16T02:25:44Z ERROR upstream timeout after 5000ms",
        "",
      ].join("\n"),
      { flag: "a" },
    );
    const deduped = await run(dedupeDef, afterRotate.output.state);
    assert.ok(deduped.ok, deduped.ok ? "" : deduped.error);
    assert.equal(deduped.output.mode === "event" && deduped.output.events.length, 1);
  });

  it("waits quietly when missing_ok is true and fails clearly when missing_ok is false", async () => {
    mkdirSync(join(scratch, "logs"), { recursive: true });
    const strict = await run(definition({ path: "logs/not-yet.log" }));
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.match(strict.error, /cannot access log file/);

    const tolerant = await run(definition({ path: "logs/not-yet.log", missing_ok: true }));
    assert.ok(tolerant.ok, tolerant.ok ? "" : tolerant.error);
    assert.match(tolerant.output.summary, /waiting for logs\/not-yet\.log/);
  });
});

describe("http-health recipe", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  const { recipe } = loadRecipe(RECIPES, "http-health");
  const dir = join(RECIPES, "http-health");
  let home: ReturnType<typeof tempHome>;
  let mode: "ok" | "503" | "bad-json" | "redirect-outside" = "ok";
  let origin = "";
  let host = "";
  let forbiddenOrigin = "";

  const server = createServer((req, res) => {
    if (mode === "503") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("maintenance");
      return;
    }
    if (mode === "bad-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { healthy: false } }));
      return;
    }
    if (mode === "redirect-outside") {
      res.writeHead(302, { location: forbiddenOrigin + "/secret" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", data: { healthy: true } }));
  });

  const forbiddenServer = createServer((_req, res) => {
    res.writeHead(200);
    res.end("should never be reached");
  });

  before(async () => {
    home = tempHome();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => forbiddenServer.listen(0, "127.0.0.1", resolve));
    host = "127.0.0.1:" + (server.address() as AddressInfo).port;
    origin = "http://" + host;
    forbiddenOrigin = "http://127.0.0.1:" + (forbiddenServer.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => forbiddenServer.close(() => resolve()));
    home.cleanup();
  });

  function definition(params: Record<string, unknown>): TriggerDefinition {
    const applied = applyRecipe(recipe, {
      id: "api-health",
      name: "API health",
      intent: "Alert when local API goes unhealthy",
      probe: { params },
      action: { type: "notify" },
    });
    assert.deepEqual(applied.errors, []);
    const validated = validateDefinition(applied.definition);
    if (!validated.ok) assert.fail(validated.errors.join("; "));
    return validated.definition;
  }

  function run(def: TriggerDefinition) {
    return runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      definition: def,
      input: { version: 1, trigger_id: def.id, now: NOW, params: def.probe.params, state: null, last: null },
      env: {},
    });
  }

  it("derives sandbox permissions.net strictly from params.url and blocks cross-host redirects", async () => {
    const def = definition({ url: origin + "/healthz", expect_json: "data.healthy=true" });
    assert.equal(def.probe.access, "sandbox");
    assert.deepEqual(def.probe.permissions, { net: [host], env: [] });

    mode = "ok";
    const okRes = await run(def);
    assert.ok(okRes.ok, okRes.ok ? "" : okRes.error);
    assert.equal(okRes.output.mode === "state" && okRes.output.fire, false);
    assert.equal(okRes.output.mode === "state" && okRes.output.rearm, true);

    mode = "bad-json";
    const mismatch = await run(def);
    assert.ok(mismatch.ok, mismatch.ok ? "" : mismatch.error);
    assert.equal(mismatch.output.mode === "state" && mismatch.output.fire, true);
    assert.match(mismatch.output.summary, /JSON data\.healthy=false/);

    mode = "503";
    const down = await run(def);
    assert.ok(down.ok, down.ok ? "" : down.error);
    assert.equal(down.output.mode === "state" && down.output.fire, true);
    assert.match(down.output.summary, /HTTP 503/);

    // Redirecting to a port outside `permissions.net` is blocked by Deno's sandbox!
    mode = "redirect-outside";
    const redirected = await run(def);
    assert.equal(redirected.ok, false);
    if (!redirected.ok) assert.match(redirected.error, /blocked redirect outside allowed sandbox host/);
  });

  it("fires (instead of crashing the probe) when the target port refuses connections", async () => {
    const unusedServer = createServer();
    await new Promise<void>((resolve) => unusedServer.listen(0, "127.0.0.1", resolve));
    const deadPort = (unusedServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => unusedServer.close(() => resolve()));

    const def = definition({ url: "http://127.0.0.1:" + deadPort + "/healthz", request_timeout_ms: 2000 });
    const res = await run(def);
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.equal(res.output.mode === "state" && res.output.fire, true);
    assert.match(res.output.summary, /unhealthy/);
  });

  it("re-derives sandbox host allowlist on parameter changes and rejects non-HTTP URLs", () => {
    const bad = applyRecipe(recipe, { probe: { params: { url: "ftp://example.com/file" } } });
    assert.match(bad.errors.join("\n"), /probe\.params\.url must be an http:\/\/ or https:\/\/ URL/);

    const updated = applyRecipe(recipe, {
      probe: { params: { url: "https://status.example.com:8443/healthz", allow_hosts: ["cdn.example.com"] } },
    });
    assert.deepEqual(updated.errors, []);
    assert.deepEqual((updated.definition.probe as { permissions: unknown }).permissions, {
      net: ["status.example.com:8443", "cdn.example.com"],
      env: [],
    });
  });
});
