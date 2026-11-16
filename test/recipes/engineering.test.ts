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
const SINCE_7D = encodeURIComponent(new Date(Date.parse(NOW) - 7 * 86_400_000).toISOString());

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

  it("watches a pull request across paginated reviews and comments while skipping ignored actors", async () => {
    const headSha = "abcdef1234567890fedcba";
    // Page 1 has 100 older empty COMMENTED reviews so page 2's newest CHANGES_REQUESTED review must still be reached.
    const page1Reviews = Array.from({ length: 100 }, (_, i) => ({
      id: 100 + i,
      state: "COMMENTED",
      body: "",
      user: { login: "reviewer" },
    }));
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
        ["repos/acme/widget/commits/" + headSha + "/check-runs?per_page=100&page=1"]: {
          total_count: 2,
          check_runs: [
            { id: 901, name: "CI / Test (ubuntu)", status: "completed", conclusion: "success", html_url: "https://github.com/acme/widget/runs/901" },
            { id: 902, name: "CI / Test (macos)", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/widget/runs/902" },
          ],
        },
        ["repos/acme/widget/commits/" + headSha + "/status"]: {
          statuses: [{ context: "vercel", state: "success" }],
        },
        "repos/acme/widget/pulls/42/reviews?per_page=100&page=1": page1Reviews,
        "repos/acme/widget/pulls/42/reviews?per_page=100&page=2": [
          { id: 500, state: "PENDING", body: "draft", user: { login: "alice" } },
          { id: 502, state: "CHANGES_REQUESTED", body: "Please handle log rotation.", user: { login: "alice" }, html_url: "https://github.com/acme/widget/pull/42#pullrequestreview-502" },
          { id: 503, state: "APPROVED", body: "LGTM", user: { login: "dependabot[bot]" } },
        ],
        "repos/acme/widget/pulls/42/comments?sort=created&direction=desc&per_page=40": [
          { id: 701, path: "src/probe.ts", line: 18, body: "Check offset reset on truncate.", user: { login: "bob" }, html_url: "https://github.com/acme/widget/pull/42#discussion_r701" },
        ],
        ["repos/acme/widget/issues/42/comments?since=" + SINCE_7D + "&per_page=100&page=1"]: [
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

  it("watches slash-named branches, ignores superseded failures, and does not treat cancelled runs as running or passed", async () => {
    const currentHead = "222222222222333333333333";
    const oldHead = "111111111111000000000000";
    const branch = "feat/sub-branch";
    const encoded = encodeURIComponent(branch);
    writeFileSync(
      responsesFile,
      JSON.stringify({
        ["repos/acme/widget/commits?sha=" + encoded + "&per_page=1"]: [{ sha: currentHead }],
        ["repos/acme/widget/actions/workflows/ci.yml/runs?branch=" + encoded + "&per_page=25"]: {
          workflow_runs: [
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

    const failing = await run(definition({ repo: "acme/widget", branch, workflow: "ci.yml", watch: ["ci", "ci_pass"] }));
    assert.ok(failing.ok, failing.ok ? "" : failing.error);
    assert.deepEqual(failing.output.mode === "event" && failing.output.events.map((e) => e.key), ["ci-fail:acme/widget:101:2"]);

    // A cancelled latest run is neither `running` nor `ci_pass`.
    writeFileSync(
      responsesFile,
      JSON.stringify({
        ["repos/acme/widget/commits?sha=" + encoded + "&per_page=1"]: [{ sha: currentHead }],
        ["repos/acme/widget/actions/workflows/ci.yml/runs?branch=" + encoded + "&per_page=25"]: {
          workflow_runs: [
            {
              id: 102,
              workflow_id: 1,
              name: "CI",
              run_number: 12,
              run_attempt: 1,
              created_at: "2026-11-16T02:40:00Z",
              head_sha: currentHead,
              status: "completed",
              conclusion: "cancelled",
              html_url: "https://github.com/acme/widget/actions/runs/102",
            },
          ],
        },
      }),
    );
    const cancelledRun = await run(definition({ repo: "acme/widget", branch, workflow: "ci.yml", watch: ["ci", "ci_pass"] }));
    assert.ok(cancelledRun.ok, cancelledRun.ok ? "" : cancelledRun.error);
    assert.deepEqual(cancelledRun.output.mode === "event" && cancelledRun.output.events, []);
    assert.match(cancelledRun.output.summary, /1 cancelled/);
    assert.doesNotMatch(cancelledRun.output.summary, /running/);

    // Once run #13 succeeds on currentHead, ci_pass fires once.
    writeFileSync(
      responsesFile,
      JSON.stringify({
        ["repos/acme/widget/commits?sha=" + encoded + "&per_page=1"]: [{ sha: currentHead }],
        ["repos/acme/widget/actions/workflows/ci.yml/runs?branch=" + encoded + "&per_page=25"]: {
          workflow_runs: [
            {
              id: 103,
              workflow_id: 1,
              name: "CI",
              run_number: 13,
              run_attempt: 1,
              created_at: "2026-11-16T02:45:00Z",
              head_sha: currentHead,
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/widget/actions/runs/103",
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
    const recovered = await run(definition({ repo: "acme/widget", branch, workflow: "ci.yml", watch: ["ci", "ci_pass"] }));
    assert.ok(recovered.ok, recovered.ok ? "" : recovered.error);
    assert.deepEqual(recovered.output.mode === "event" && recovered.output.events.map((e) => e.key), [
      "ci-pass:acme/widget:" + branch + ":ci.yml:222222222222",
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

  it("records EOF baseline, coalesces stack traces & Python tracebacks without swallowing separate errors, handles CRLF & copytruncate, and dedupes lines", async () => {
    const logFile = join(scratch, "app.log");
    writeFileSync(logFile, "2026-11-16T01:00:00Z ERROR historical failure before watch started\n");

    const def = definition({ path: "app.log", exclude: "healthcheck" });
    const first = await run(def, null);
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.deepEqual(first.output.mode === "event" && first.output.events, []);

    // Append CRLF lines: 1 JS stack trace, 1 Python traceback, and 2 adjacent independent ERROR lines.
    const initialSize = (first.output.state as { offset: number }).offset;
    const chunk = [
      "2026-11-16T02:00:01Z INFO request ok",
      "2026-11-16T02:00:02Z ERROR healthcheck transient noise",
      "2026-11-16T02:00:03Z ERROR Unhandled exception in worker:",
      "    at processJob (src/worker.ts:42:11)",
      "Caused by: Error: connection reset",
      "Traceback (most recent call last):",
      '  File "train.py", line 14, in main',
      "    step()",
      "RuntimeError: CUDA out of memory",
      "2026-11-16T02:00:04Z ERROR First independent failure",
      "2026-11-16T02:00:05Z INFO normal line between failures",
      "2026-11-16T02:00:06Z ERROR Second independent failure",
      "",
    ].join("\r\n");
    writeFileSync(logFile, chunk, { flag: "a" });

    const second = await run(def, first.output.state);
    assert.ok(second.ok, second.ok ? "" : second.error);
    const events2 = second.output.mode === "event" ? second.output.events : [];
    assert.equal(events2.length, 4, "JS trace, Python traceback, and both independent ERROR lines emit separate events");
    assert.match(String((events2[0]!.data as Record<string, unknown>).snippet), /Caused by: Error: connection reset/);
    assert.match(String((events2[1]!.data as Record<string, unknown>).snippet), /RuntimeError: CUDA out of memory/);
    assert.match(events2[2]!.summary ?? "", /First independent failure/);
    assert.doesNotMatch(String((events2[2]!.data as Record<string, unknown>).snippet), /Second independent failure/);
    assert.match(events2[3]!.summary ?? "", /Second independent failure/);
    // Exact byte offset of "2026-11-16T02:00:03Z ERROR..." under CRLF:
    const expectedFirstMatchOffset =
      initialSize +
      Buffer.byteLength("2026-11-16T02:00:01Z INFO request ok\r\n2026-11-16T02:00:02Z ERROR healthcheck transient noise\r\n");
    assert.equal((events2[0]!.data as Record<string, unknown>).byte_offset, expectedFirstMatchOffset);

    // Simulate copytruncate rotation with completely new content.
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
  let mode: "ok" | "503" | "bad-json" | "redirect-outside" | "body-stall" = "ok";
  let origin = "";
  let host = "";
  let forbiddenOrigin = "";

  const server = createServer((_req, res) => {
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
    if (mode === "body-stall") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":');
      // Intentionally never finish the stream until client aborts.
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

  it("derives sandbox permissions.net strictly from params.url, supports quoted JSON strings, and blocks cross-host redirects", async () => {
    const def = definition({ url: origin + "/healthz", expect_json: 'status="ok"' });
    assert.equal(def.probe.access, "sandbox");
    assert.deepEqual(def.probe.permissions, { net: [host], env: [] });

    mode = "ok";
    const okRes = await run(def);
    assert.ok(okRes.ok, okRes.ok ? "" : okRes.error);
    assert.equal(okRes.output.mode === "state" && okRes.output.fire, false);
    assert.equal(okRes.output.mode === "state" && okRes.output.rearm, true);

    const boolDef = definition({ url: origin + "/healthz", expect_json: "data.healthy=true" });
    mode = "bad-json";
    const mismatch = await run(boolDef);
    assert.ok(mismatch.ok, mismatch.ok ? "" : mismatch.error);
    assert.equal(mismatch.output.mode === "state" && mismatch.output.fire, true);
    assert.match(mismatch.output.summary, /JSON data\.healthy=false/);

    mode = "503";
    const down = await run(boolDef);
    assert.ok(down.ok, down.ok ? "" : down.error);
    assert.equal(down.output.mode === "state" && down.output.fire, true);
    assert.match(down.output.summary, /HTTP 503/);

    // Mid-stream response body stall fires `timeout` cleanly instead of crashing the probe.
    mode = "body-stall";
    const stalled = await run(definition({ url: origin + "/healthz", expect_json: "status=ok", request_timeout_ms: 500 }));
    assert.ok(stalled.ok, stalled.ok ? "" : stalled.error);
    assert.equal(stalled.output.mode === "state" && stalled.output.fire, true);
    assert.match(stalled.output.summary, /timed out/);

    // Redirecting to a port outside `permissions.net` is blocked by Deno's sandbox!
    mode = "redirect-outside";
    const redirected = await run(boolDef);
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

  it("re-derives sandbox host allowlist on parameter changes and validates URL and allow_hosts syntax", () => {
    const badUrl = applyRecipe(recipe, { probe: { params: { url: "ftp://example.com/file" } } });
    assert.match(badUrl.errors.join("\n"), /probe\.params\.url must be an http:\/\/ or https:\/\/ URL/);

    const badHost = applyRecipe(recipe, {
      probe: { params: { url: "https://status.example.com/healthz", allow_hosts: ["https://cdn.example.com"] } },
    });
    assert.match(badHost.errors.join("\n"), /probe\.params\.allow_hosts\[0\] must be a host or host:port/);

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
