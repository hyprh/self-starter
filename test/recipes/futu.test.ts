import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { validateDefinition, type TriggerDefinition } from "../../src/core/definition.js";
import { bundledDeno } from "../../src/engine/config.js";
import { runProbe } from "../../src/engine/probe-runner.js";
import { applyRecipe, loadRecipe } from "../../src/engine/recipes.js";
import { PACKAGE_ROOT } from "../../src/runtime.js";
import { tempHome } from "../engine/fixtures.js";

const deno = bundledDeno();
const RECIPES = join(PACKAGE_ROOT, "recipes");

type Item = { news_id: string; title: string; publish_time: string; url: string };

/** Answers like Futu's news search: GET /news_search?keyword=&size=&news_type=&lang=&sort_type=2. */
class FakeNewsSearch {
  origin = "";
  host = "";
  /** Items by keyword and news type, newest first, such as items.set("NVDA/3", [...]). */
  items = new Map<string, Item[]>();
  failure: { status: number } | { code: number; message: string } | undefined;
  /** Answer 429 with this Retry-After once this many requests were served. */
  rateLimit: { after: number; retryAfter: string } | undefined;
  requests: URLSearchParams[] = [];
  private server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/news_search") {
      res.statusCode = 404;
      return res.end();
    }
    this.requests.push(url.searchParams);
    if (this.rateLimit && this.requests.length > this.rateLimit.after) {
      res.writeHead(429, { "retry-after": this.rateLimit.retryAfter });
      return res.end("too many requests");
    }
    if (this.failure && "status" in this.failure) {
      res.statusCode = this.failure.status;
      return res.end("unavailable");
    }
    res.setHeader("content-type", "application/json");
    if (this.failure) return res.end(JSON.stringify(this.failure));
    const items = this.items.get(`${url.searchParams.get("keyword")}/${url.searchParams.get("news_type")}`) ?? [];
    res.end(JSON.stringify({ code: 0, data: items.slice(0, Number(url.searchParams.get("size"))) }));
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.host = `127.0.0.1:${port}`;
    this.origin = `http://${this.host}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const item = (id: string, title: string, published: string): Item => ({
  news_id: id,
  title,
  publish_time: String(Date.parse(published) / 1000),
  url: `https://news.futunn.com/post/${id}`,
});

const NOW = "2026-10-13T05:00:00Z";

describe("Futu news watch recipe", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  const search = new FakeNewsSearch();
  let home: ReturnType<typeof tempHome>;
  const { recipe } = loadRecipe(RECIPES, "futu-news");
  const dir = join(RECIPES, "futu-news");

  before(async () => {
    await search.start();
    home = tempHome();
  });
  after(async () => {
    await search.close();
    home.cleanup();
  });

  /** The recipe's definition, pointed at the fake search (tests cannot reach Futu). */
  function definition(params: Record<string, unknown>): TriggerDefinition {
    const applied = applyRecipe(recipe, {
      id: "futu-watch",
      name: "Futu watch",
      intent: "Tell me when analysts change their view on the stocks I follow",
      probe: { params: { base_url: search.origin, request_spacing_ms: 0, ...params } },
      action: { type: "notify" },
    });
    assert.deepEqual(applied.errors, []);
    (applied.definition.probe as Record<string, unknown>).permissions = { net: [search.host], env: [] };
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

  it("needs stocks, and keeps its own access and permissions", () => {
    assert.match(applyRecipe(recipe, { probe: { params: {} } }).errors.join("\n"), /probe\.params\.stocks is required/);
    const errors = applyRecipe(recipe, { probe: { params: { stocks: ["NVDA"] }, access: "full", permissions: { net: ["evil.example"], env: [] } } }).errors.join("\n");
    assert.match(errors, /runs with sandbox access/);
    assert.match(errors, /fixes the probe's permissions/);
  });

  it("reports recent research once per item, with a plain title and the link", async () => {
    search.requests = [];
    search.items.set("腾讯控股/3", [
      item("1000932788", "大摩：维持<em>腾讯控股</em>(00700)“增持”评级 目标价550港元", "2026-10-13T01:18:00Z"),
      item("1000795534", "杰富瑞将<em>腾讯控股</em>的目标价从750港元下调至711港元", "2026-10-09T10:49:00Z"),
    ]);
    search.items.set("英伟达/3", [
      item("1000813059", "瑞银维持<em>英伟达</em>(NVDA.US)买入评级", "2026-10-12T18:31:00Z"),
      item("1000932788", "大摩：维持<em>腾讯控股</em>(00700)“增持”评级 目标价550港元", "2026-10-13T01:18:00Z"),
    ]);
    const result = await run(definition({ stocks: ["腾讯控股", "英伟达"] }));
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.output.mode, "event");
    const events = result.output.mode === "event" ? result.output.events : [];
    assert.deepEqual(
      events.map((event) => event.key),
      ["1000932788", "1000813059"],
      "the report from four days ago is too old, and the one found for both stocks counts once",
    );
    assert.equal(events[0]!.summary, "腾讯控股 · research: 大摩：维持腾讯控股(00700)“增持”评级 目标价550港元");
    assert.deepEqual(events[1]!.data, {
      stock: "英伟达",
      type: "research",
      title: "瑞银维持英伟达(NVDA.US)买入评级",
      published: "2026-10-12T18:31:00.000Z",
      url: "https://news.futunn.com/post/1000813059",
    });
    assert.equal(result.output.summary, "2 item(s) from the last 48 h on Futu (腾讯控股 1, 英伟达 2)");
    assert.deepEqual(
      search.requests.map((query) => [query.get("keyword"), query.get("news_type"), query.get("lang"), query.get("sort_type"), query.get("size")]),
      [
        ["腾讯控股", "3", "zh-CN", "2", "20"],
        ["英伟达", "3", "zh-CN", "2", "20"],
      ],
    );
  });

  it("watches announcements and news when asked, keeping only titles that match", async () => {
    search.items.set("00700/2", [item("notice:1", "<em>腾讯控股</em>：股份回购公告", "2026-10-12T09:00:00Z"), item("notice:2", "<em>腾讯控股</em>：董事名单", "2026-10-12T08:00:00Z")]);
    search.items.set("00700/1", [item("1000900001", "腾讯回购动作持续", "2026-10-12T10:00:00Z")]);
    const result = await run(definition({ stocks: ["00700"], types: ["notice", "news"], match: "回购|buyback" }));
    assert.ok(result.ok, result.ok ? "" : result.error);
    const events = result.output.mode === "event" ? result.output.events : [];
    assert.deepEqual(
      events.map((event) => event.summary),
      ["00700 · announcement: 腾讯控股：股份回购公告", "00700 · news: 腾讯回购动作持续"],
    );
  });

  it("keeps what it found and checks again later when Futu asks to slow down", async () => {
    search.requests = [];
    search.rateLimit = { after: 1, retryAfter: "600" };
    search.items.set("腾讯控股/3", [item("1000932788", "大摩：维持<em>腾讯控股</em>(00700)“增持”评级 目标价550港元", "2026-10-13T01:18:00Z")]);
    const result = await run(definition({ stocks: ["腾讯控股", "英伟达", "苹果"] }));
    search.rateLimit = undefined;
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.deepEqual(result.output.mode === "event" && result.output.events.map((event) => event.key), ["1000932788"]);
    assert.equal(result.output.summary, "1 item(s) from the last 48 h on Futu (腾讯控股 1); Futu asked to slow down, next check in 10 min");
    assert.equal(result.output.nextCheckInMs, 10 * 60_000);
    assert.equal(search.requests.length, 2, "it stops asking once told to slow down");
  });

  it("explains what went wrong", async () => {
    const badType = await run(definition({ stocks: ["NVDA"], types: ["rumors"] }));
    assert.match(badType.ok ? "" : badType.error, /unknown type rumors; use research, notice or news/);
    const badMatch = await run(definition({ stocks: ["NVDA"], match: "(" }));
    assert.match(badMatch.ok ? "" : badMatch.error, /match is not a valid regular expression/);

    search.failure = { code: 1001, message: "keyword is required" };
    const refused = await run(definition({ stocks: ["NVDA"] }));
    assert.match(refused.ok ? "" : refused.error, /Futu news search failed for NVDA: keyword is required/);
    search.failure = { status: 503 };
    const down = await run(definition({ stocks: ["NVDA"] }));
    assert.match(down.ok ? "" : down.error, /Futu news search answered HTTP 503 for NVDA/);
    search.failure = undefined;
  });
});
