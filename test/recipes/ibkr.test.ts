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
const TOKEN = "good-token";

/** Speaks the Flex Web Service protocol: SendRequest hands out a reference, GetStatement returns the report. */
class FakeFlex {
  origin = "";
  host = "";
  reports = new Map<string, string>();
  notReady = 0;
  sendRequests = 0;
  getStatements = 0;
  private refs = new Map<string, string>();
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("content-type", "text/xml");
      const fail = (code: string, message: string, status = "Fail") =>
        res.end(`<FlexStatementResponse timestamp="12 October, 2026 10:15 AM EDT"><Status>${status}</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`);
      if (url.searchParams.get("v") !== "3") return fail("1020", "Invalid request or unable to validate request.");
      if (url.searchParams.get("t") !== TOKEN) return fail("1015", "Token is invalid.");
      if (url.pathname.endsWith("/SendRequest")) {
        this.sendRequests += 1;
        const ref = `REF${this.sendRequests}`;
        this.refs.set(ref, url.searchParams.get("q") ?? "");
        return res.end(
          `<FlexStatementResponse timestamp="12 October, 2026 10:15 AM EDT"><Status>Success</Status><ReferenceCode>${ref}</ReferenceCode><Url>${this.origin}/GetStatement</Url></FlexStatementResponse>`,
        );
      }
      if (url.pathname.endsWith("/GetStatement")) {
        this.getStatements += 1;
        const query = this.refs.get(url.searchParams.get("q") ?? "");
        if (query === undefined) return fail("1017", "Reference code is invalid.");
        if (this.notReady > 0) {
          this.notReady -= 1;
          return fail("1019", "Statement generation in progress. Please try again shortly.", "Warn");
        }
        return res.end(this.reports.get(query) ?? "<FlexQueryResponse><FlexStatements count=\"0\"></FlexStatements></FlexQueryResponse>");
      }
      res.statusCode = 404;
      res.end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.host = `127.0.0.1:${port}`;
    this.origin = `http://${this.host}/AccountManagement/FlexWebService`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const statement = (account: string, date: string, body: string) =>
  `<FlexQueryResponse queryName="watch" type="AF"><FlexStatements count="1"><FlexStatement accountId="${account}" fromDate="${date}" toDate="${date}" period="LastBusinessDay" whenGenerated="${date};063000">${body}</FlexStatement></FlexStatements></FlexQueryResponse>`;

const tradeConfirm = (t: { id: string; symbol: string; side: string; qty: number; price: number; code?: string }) =>
  `<TradeConfirm accountId="U1234567" currency="USD" assetCategory="STK" symbol="${t.symbol}" description="${t.symbol} &amp; CO" conid="c-${t.symbol}" tradeID="${t.id}" buySell="${t.side}" quantity="${t.side === "SELL" ? -t.qty : t.qty}" price="${t.price}" amount="${t.qty * t.price}" dateTime="20261012;101000" orderType="LMT" code="${t.code ?? ""}" />`;

const activity = (date: string, opts: { positions: Array<[string, number]>; cash?: Array<[string, number]>; nav: number; start: number; trades?: string[] }) =>
  statement(
    "U1234567",
    date,
    `<ChangeInNAV accountId="U1234567" currency="USD" startingValue="${opts.start}" endingValue="${opts.nav}" />` +
      `<EquitySummaryInBase><EquitySummaryByReportDateInBase accountId="U1234567" currency="USD" reportDate="${date}" total="${opts.nav}" /></EquitySummaryInBase>` +
      `<CashTransactions>${(opts.cash ?? []).map(([id, amount]) => `<CashTransaction accountId="U1234567" currency="USD" type="Deposits/Withdrawals" amount="${amount}" dateTime="${date};120000" transactionID="${id}" levelOfDetail="DETAIL" />`).join("")}</CashTransactions>` +
      `<OpenPositions>${opts.positions.map(([symbol, qty]) => `<OpenPosition accountId="U1234567" currency="USD" symbol="${symbol}" conid="c-${symbol}" position="${qty}" levelOfDetail="SUMMARY" />`).join("")}</OpenPositions>` +
      `<Trades>${(opts.trades ?? []).map((symbol) => `<Trade accountId="U1234567" currency="USD" symbol="${symbol}" conid="c-${symbol}" tradeID="A-${symbol}" buySell="BUY" quantity="10" tradePrice="100" dateTime="${date};110000" />`).join("")}</Trades>`,
  );

describe("IBKR account watch recipe", { skip: deno ? false : "the deno npm package is not installed" }, () => {
  const flex = new FakeFlex();
  let home: ReturnType<typeof tempHome>;
  const { recipe } = loadRecipe(RECIPES, "ibkr-account");
  const dir = join(RECIPES, "ibkr-account");

  before(async () => {
    await flex.start();
    home = tempHome();
  });
  after(async () => {
    await flex.close();
    home.cleanup();
  });

  /** The recipe's definition, pointed at the fake service (tests cannot reach IBKR). */
  function definition(params: Record<string, unknown>): TriggerDefinition {
    const applied = applyRecipe(recipe, {
      id: "ibkr-watch",
      name: "IBKR watch",
      intent: "Tell me about changes in my IBKR account",
      probe: { params: { base_url: flex.origin, retry_delays_ms: [5, 5, 5], request_spacing_ms: 0, ...params } },
      action: { type: "notify" },
    });
    assert.deepEqual(applied.errors, []);
    const probe = applied.definition.probe as Record<string, unknown>;
    probe.permissions = { net: [flex.host], env: ["IBKR_FLEX_TOKEN"] };
    const validated = validateDefinition(applied.definition);
    if (!validated.ok) assert.fail(validated.errors.join("; "));
    return validated.definition;
  }

  async function run(def: TriggerDefinition, now: string, state: unknown = null, token: string | null = TOKEN) {
    const result = await runProbe({
      denoBin: deno!,
      denoDir: home.paths.denoDir,
      dir,
      definition: def,
      input: { version: 1, trigger_id: def.id, now, params: def.probe.params, state, last: null },
      env: token ? { IBKR_FLEX_TOKEN: token } : {},
    });
    return result;
  }

  it("rejects unknown and mistyped parameters, and keeps its own permissions", () => {
    const applied = applyRecipe(recipe, { probe: { params: { trade_query_id: 42, nav_move: 3 }, permissions: { net: ["evil.example"], env: [] } } });
    assert.match(applied.errors.join("\n"), /trade_query_id must be a string/);
    assert.match(applied.errors.join("\n"), /no parameter nav_move/);
    assert.match(applied.errors.join("\n"), /fixes the probe's permissions/);
  });

  it("reports new executions, naming option assignments", async () => {
    flex.reports.set("TC1", statement("U1234567", "20261012", `<TradeConfirms>${tradeConfirm({ id: "T1", symbol: "AAPL", side: "BUY", qty: 100, price: 190.5 })}${tradeConfirm({ id: "T2", symbol: "NVDA", side: "SELL", qty: 100, price: 200, code: "A" })}</TradeConfirms>`));
    const result = await run(definition({ trade_query_id: "TC1" }), "2026-10-12T14:20:00Z");
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.output.mode, "event");
    const events = result.output.mode === "event" ? result.output.events : [];
    assert.deepEqual(events.map((e) => e.key), ["trade:U1234567:T1", "trade:U1234567:T2"]);
    assert.equal(events[0]!.summary, "BUY 100 AAPL @ 190.5 USD (U1234567)");
    assert.equal(events[1]!.summary, "assignment: SELL 100 NVDA @ 200 USD (U1234567)");
    assert.equal((events[0]!.data as Record<string, unknown>).description, "AAPL & CO");
    assert.equal(result.output.summary, "U1234567 · 2 executions today");
    assert.equal(result.output.nextCheckInMs, 15 * 60_000, "10:20 New York time on a Monday: every 15 minutes");
  });

  it("keeps a report that is still being generated for the next run", async () => {
    const def = definition({ trade_query_id: "TC1" });
    flex.notReady = 10;
    const sendsBefore = flex.sendRequests;
    const first = await run(def, "2026-10-12T14:20:00Z");
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.equal(first.output.mode === "event" && first.output.events.length, 0);
    assert.match(first.output.summary, /still generating/);
    const state = first.output.state as { pending: Record<string, { ref: string }> };
    assert.ok(state.pending.TC1?.ref);

    flex.notReady = 0;
    const second = await run(def, "2026-10-12T14:25:00Z", state);
    assert.ok(second.ok, second.ok ? "" : second.error);
    assert.equal(flex.sendRequests, sendsBefore + 1, "the stored reference is reused");
    assert.equal(second.output.mode === "event" && second.output.events.length, 2);
    assert.deepEqual((second.output.state as { pending: object }).pending, {});
  });

  it("explains token problems and a missing token", async () => {
    const bad = await run(definition({ trade_query_id: "TC1" }), "2026-10-12T14:20:00Z", null, "wrong");
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.error, /1015\): Token is invalid\. Generate a new token/);
    const missing = await run(definition({ trade_query_id: "TC1" }), "2026-10-12T14:20:00Z", null, null);
    assert.match(missing.ok ? "" : missing.error, /IBKR_FLEX_TOKEN is not set; run: ctrig secret set/);
  });

  it("reports cash movements, unexplained position changes and large NAV moves from the daily report", async () => {
    const def = definition({ activity_query_id: "ACT" });
    flex.reports.set("ACT", activity("20261009", { positions: [["AAPL", 100], ["MSFT", 50]], cash: [["C1", 10000]], nav: 100000, start: 99500 }));
    const first = await run(def, "2026-10-12T10:00:00Z");
    assert.ok(first.ok, first.ok ? "" : first.error);
    const firstKeys = first.output.mode === "event" ? first.output.events.map((e) => e.key) : [];
    assert.deepEqual(firstKeys, ["cash:U1234567:C1"], "a 0.5% move is below the 3% default");

    flex.reports.set(
      "ACT",
      activity("20261012", { positions: [["AAPL", 100], ["NVDA", 10]], cash: [["C1", 10000], ["C2", -5000]], nav: 94000, start: 100000, trades: ["NVDA"] }),
    );
    const getsBefore = flex.getStatements;
    const soon = await run(def, "2026-10-12T15:00:00Z", first.output.state);
    assert.ok(soon.ok);
    assert.equal(flex.getStatements, getsBefore, "the daily report is not fetched again within 12 hours");

    const next = await run(def, "2026-10-12T23:00:00Z", first.output.state);
    assert.ok(next.ok, next.ok ? "" : next.error);
    const events = next.output.mode === "event" ? next.output.events : [];
    assert.deepEqual(events.map((e) => e.key).sort(), [
      "cash:U1234567:C1",
      "cash:U1234567:C2",
      "nav:U1234567:20261012",
      "position:U1234567:c-MSFT:20261012",
      "trade:U1234567:A-NVDA",
    ]);
    const byKey = Object.fromEntries(events.map((e) => [e.key, e.summary]));
    assert.equal(byKey["cash:U1234567:C2"], "Withdrawal of 5,000 USD (U1234567)");
    assert.equal(byKey["position:U1234567:c-MSFT:20261012"], "Position closed without a trade: MSFT (was 50) (U1234567)");
    assert.equal(byKey["nav:U1234567:20261012"], "NAV down 6.0% to 94,000 USD (U1234567, 20261012)");
    assert.equal(byKey["trade:U1234567:A-NVDA"], "BUY 10 NVDA @ 100 USD (U1234567)", "executions in the daily report count too; the same trade id fires once");
    assert.equal(next.output.summary, "U1234567 · NAV 94,000 USD · 2 positions");
    assert.equal(next.output.nextCheckInMs, 2 * 3_600_000, "no trade query: every 2 hours");
  });
});
