// IBKR account watch (recipe ibkr-account v1).
//
// Reads Interactive Brokers Flex Web Service reports and reports what changed as events:
//   trade:<account>:<id>             new executions, including option assignments and exercises
//                                    (Trade Confirmation query; IBKR publishes them 5 to 10 minutes after the fill)
//   cash:<account>:<id>              deposits and withdrawals, or other chosen cash types (Activity query, daily)
//   position:<account>:<id>:<date>   positions that changed without a trade in the same report (Activity query)
//   nav:<account>:<date>             day-over-day moves in net asset value of at least nav_move_pct (Activity query)
//
// IBKR asks clients not to poll the Flex Web Service actively, so the probe checks
// executions every 15 minutes around US market hours and every 2 hours otherwise,
// fetches the daily Activity report at most every activity_every_hours, and keeps the
// reference of a report that is still being generated to collect it on the next run.

type Attrs = Record<string, string>;
type FlexEvent = { key: string; summary: string; data: Record<string, unknown>; time?: string };
type Pending = { ref: string; url: string; at: string };
type Position = { symbol: string; qty: number };
interface State {
  pending?: Record<string, Pending>;
  activityAt?: string;
  positions?: Record<string, Position>;
  nav?: Record<string, { value: number; date: string; currency: string }>;
}

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const params = input.params ?? {};
const state: State = input.state ?? {};
const now = new Date(input.now);

const TOKEN = Deno.env.get("IBKR_FLEX_TOKEN");
if (!TOKEN) {
  throw new Error("IBKR_FLEX_TOKEN is not set; run: self-starter secret set IBKR_FLEX_TOKEN --hosts ndcdyn.interactivebrokers.com,gdcdyn.interactivebrokers.com");
}
const tradeQuery: string | undefined = params.trade_query_id || undefined;
const activityQuery: string | undefined = params.activity_query_id || undefined;
if (!tradeQuery && !activityQuery) throw new Error("set trade_query_id, activity_query_id, or both");

const BASE = String(params.base_url).replace(/\/+$/, "");
const navMovePct = Number(params.nav_move_pct);
const largeTrade = Number(params.large_trade_value);
const cashTypes: string[] = params.cash_types;
const watch: string[] = params.watch;
const retryDelays: number[] = params.retry_delays_ms;
const spacing = Number(params.request_spacing_ms);
const activityEveryMs = Number(params.activity_every_hours) * 3_600_000;

// ---- Flex reports are flat XML elements with attributes ----------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity] ?? match;
    const hex = entity[1] === "x" || entity[1] === "X";
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
const textOf = (xml: string, tag: string) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decode(match[1]!.trim()) : undefined;
};
const attrsOf = (text: string): Attrs => {
  const attrs: Attrs = {};
  for (const match of text.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) attrs[match[1]!] = decode(match[2]!);
  return attrs;
};
const elements = (xml: string, tag: string): Attrs[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, "g"))].map((match) => attrsOf(match[1]!));
const statements = (xml: string) =>
  [...xml.matchAll(/<FlexStatement\s([^>]*)>([\s\S]*?)<\/FlexStatement>/g)].map((match) => ({ attrs: attrsOf(match[1]!), body: match[2]! }));
const num = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

// ---- Flex Web Service: SendRequest, then GetStatement --------------------------

const RETRYABLE = new Set(["1001", "1004", "1005", "1006", "1007", "1008", "1009", "1018", "1019", "1021"]);
const TOKEN_PROBLEMS = new Set(["1011", "1012", "1013", "1015"]);
class NotReady extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequest = 0;

async function call(url: string): Promise<string> {
  const wait = lastRequest + spacing - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const response = await fetch(url, { headers: { "user-agent": "self-starter-ibkr/1" }, signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`IBKR Flex Web Service answered HTTP ${response.status}`);
  return body;
}

function checkStatus(xml: string, step: string): void {
  const code = textOf(xml, "ErrorCode");
  const status = textOf(xml, "Status");
  if (!code && (!status || status === "Success")) return;
  const message = textOf(xml, "ErrorMessage") ?? status ?? "unknown error";
  if (code && RETRYABLE.has(code)) throw new NotReady(`${code}: ${message}`);
  const hint = code && TOKEN_PROBLEMS.has(code) ? " Generate a new token in the IBKR Client Portal and run: self-starter secret set IBKR_FLEX_TOKEN ..." : "";
  throw new Error(`IBKR Flex ${step} failed (${code ?? status}): ${message.replace(/\.$/, "")}.${hint}`);
}

const pending: Record<string, Pending> = { ...(state.pending ?? {}) };
const stillGenerating: string[] = [];

/** Returns the report, or undefined when IBKR is still generating it (collected on the next run). */
async function report(queryId: string): Promise<string | undefined> {
  let ticket: Pending | undefined = pending[queryId];
  // References are only kept for a while; start over with an old one.
  if (ticket && now.getTime() - Date.parse(ticket.at) > 3_600_000) ticket = undefined;
  const fresh = !ticket;
  if (!ticket) {
    let xml: string;
    try {
      xml = await call(`${BASE}/SendRequest?t=${encodeURIComponent(TOKEN!)}&q=${encodeURIComponent(queryId)}&v=3`);
      checkStatus(xml, "SendRequest");
    } catch (error) {
      if (error instanceof NotReady) {
        stillGenerating.push(queryId);
        return undefined;
      }
      throw error;
    }
    const ref = textOf(xml, "ReferenceCode");
    if (!ref) throw new Error("IBKR Flex SendRequest returned no reference code");
    ticket = { ref, url: textOf(xml, "Url") ?? `${BASE}/GetStatement`, at: now.toISOString() };
    pending[queryId] = ticket;
  }
  const delays = fresh ? retryDelays : [0, ...retryDelays.slice(1)];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const xml = await call(`${ticket.url}?t=${encodeURIComponent(TOKEN!)}&q=${encodeURIComponent(ticket.ref)}&v=3`);
    try {
      checkStatus(xml, "GetStatement");
    } catch (error) {
      if (error instanceof NotReady) continue;
      delete pending[queryId];
      throw error;
    }
    delete pending[queryId];
    return xml;
  }
  stillGenerating.push(queryId);
  return undefined;
}

// ---- What changed ----------------------------------------------------------------

const events = new Map<string, FlexEvent>();
const accounts = new Map<string, { trades: number; nav?: number; currency?: string; navDate?: string; positions?: number }>();
const account = (id: string) => {
  let entry = accounts.get(id);
  if (!entry) accounts.set(id, (entry = { trades: 0 }));
  return entry;
};
const add = (event: FlexEvent) => events.set(event.key, event);

const NOTE_KINDS: Record<string, string> = { A: "assignment", Ex: "exercise", Ep: "expiry" };

function readTrades(xml: string, today: boolean): void {
  for (const statement of statements(xml)) {
    const accountId = statement.attrs.accountId || "account";
    for (const trade of [...elements(statement.body, "TradeConfirm"), ...elements(statement.body, "Trade")]) {
      const id = trade.tradeID || trade.execID || trade.ibExecID || trade.transactionID;
      if (!id) continue;
      if (today) account(accountId).trades += 1;
      if (!watch.includes("trades")) continue;
      const quantity = num(trade.quantity);
      const price = num(trade.tradePrice ?? trade.price);
      const multiplier = num(trade.multiplier) || 1;
      const value = Math.abs(num(trade.tradeMoney ?? trade.amount) || quantity * price * multiplier);
      if (largeTrade > 0 && value < largeTrade) continue;
      const notes = (trade.notes ?? trade.code ?? "").split(";").map((note) => note.trim()).filter(Boolean);
      const kind = notes.map((note) => NOTE_KINDS[note]).find(Boolean);
      const side = trade.buySell || (quantity < 0 ? "SELL" : "BUY");
      const symbol = trade.symbol || trade.description || "?";
      const time = trade.dateTime || [trade.tradeDate, trade.tradeTime].filter(Boolean).join(" ");
      add({
        key: `trade:${accountId}:${id}`,
        summary: `${kind ? `${kind}: ` : ""}${side} ${Math.abs(quantity)} ${symbol} @ ${price} ${trade.currency ?? ""} (${accountId})`.replace(/\s+/g, " "),
        time,
        data: {
          account: accountId,
          symbol,
          description: trade.description,
          assetCategory: trade.assetCategory,
          side,
          quantity,
          price,
          value,
          currency: trade.currency,
          time,
          orderType: trade.orderType,
          kind,
          notes: notes.join(";") || undefined,
        },
      });
    }
  }
}

const nextPositions: Record<string, Position> = { ...(state.positions ?? {}) };
const nextNav = { ...(state.nav ?? {}) };

function readActivity(xml: string): void {
  for (const statement of statements(xml)) {
    const accountId = statement.attrs.accountId || "account";
    const reportDate = statement.attrs.toDate || now.toISOString().slice(0, 10).replace(/-/g, "");

    if (watch.includes("cash")) {
      for (const cash of elements(statement.body, "CashTransaction")) {
        if (!cashTypes.includes(cash.type ?? "") || cash.levelOfDetail === "SUMMARY") continue;
        const amount = num(cash.amount);
        const id = cash.transactionID || `${cash.dateTime ?? cash.reportDate ?? reportDate}:${cash.amount}:${cash.currency}`;
        const what = cash.type === "Deposits/Withdrawals" ? (amount < 0 ? "Withdrawal" : "Deposit") : cash.type;
        add({
          key: `cash:${accountId}:${id}`,
          summary: `${what} of ${money(Math.abs(amount))} ${cash.currency ?? ""} (${accountId})`.replace(/\s+/g, " "),
          time: cash.dateTime ?? cash.reportDate,
          data: { account: accountId, type: cash.type, amount, currency: cash.currency, time: cash.dateTime ?? cash.reportDate, description: cash.description },
        });
      }
    }

    // Positions: compare with the previous report; changes explained by a trade in this report are left out.
    // A report without the Open Positions section says nothing about positions.
    if (!/<OpenPositions[\s>]/.test(statement.body)) {
      readNav(statement, accountId, reportDate);
      continue;
    }
    const traded = new Set(elements(statement.body, "Trade").flatMap((trade) => [trade.conid, trade.symbol].filter(Boolean)));
    const current: Record<string, Position> = {};
    for (const position of elements(statement.body, "OpenPosition")) {
      if (position.levelOfDetail && position.levelOfDetail !== "SUMMARY") continue;
      const id = position.conid || position.symbol;
      if (!id) continue;
      const entry = current[`${accountId}:${id}`];
      const qty = num(position.position) + (entry?.qty ?? 0);
      current[`${accountId}:${id}`] = { symbol: position.symbol || id, qty };
    }
    account(accountId).positions = Object.keys(current).length;
    const previous = Object.fromEntries(Object.entries(state.positions ?? {}).filter(([key]) => key.startsWith(`${accountId}:`)));
    if (watch.includes("positions") && Object.keys(previous).length > 0) {
      for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        const before = previous[key]?.qty ?? 0;
        const after = current[key]?.qty ?? 0;
        const id = key.slice(accountId.length + 1);
        const symbol = current[key]?.symbol ?? previous[key]?.symbol ?? id;
        if (before === after || traded.has(id) || traded.has(symbol)) continue;
        const summary =
          after === 0 ? `Position closed without a trade: ${symbol} (was ${before})`
          : before === 0 ? `New position without a trade: ${after} ${symbol}`
          : `${symbol} changed without a trade: ${before} → ${after}`;
        add({ key: `position:${key}:${reportDate}`, summary: `${summary} (${accountId})`, data: { account: accountId, symbol, before, after, reportDate } });
      }
    }
    for (const key of Object.keys(nextPositions)) if (key.startsWith(`${accountId}:`)) delete nextPositions[key];
    Object.assign(nextPositions, current);
    readNav(statement, accountId, reportDate);
  }
}

/** Net asset value: the latest daily row, compared with the previous report or the period start. */
function readNav(statement: { attrs: Attrs; body: string }, accountId: string, reportDate: string): void {
  {
    const rows = elements(statement.body, "EquitySummaryByReportDateInBase").filter((row) => row.total !== undefined);
    rows.sort((a, b) => (a.reportDate ?? "").localeCompare(b.reportDate ?? ""));
    const latest = rows.at(-1);
    const change = elements(statement.body, "ChangeInNAV")[0];
    const nav = latest ? num(latest.total) : change ? num(change.endingValue) : undefined;
    if (nav === undefined) return;
    const navDate = latest?.reportDate || reportDate;
    const currency = latest?.currency || change?.currency || statement.attrs.currency || "";
    Object.assign(account(accountId), { nav, currency, navDate });
    const before = state.nav?.[accountId];
    const base = before && before.date !== navDate ? before.value : change ? num(change.startingValue) : undefined;
    if (watch.includes("nav") && base) {
      const pct = ((nav - base) / Math.abs(base)) * 100;
      if (Math.abs(pct) >= navMovePct) {
        add({
          key: `nav:${accountId}:${navDate}`,
          summary: `NAV ${pct < 0 ? "down" : "up"} ${Math.abs(pct).toFixed(1)}% to ${money(nav)} ${currency} (${accountId}, ${navDate})`.replace(/\s+/g, " "),
          data: { account: accountId, nav, previous: base, changePct: Number(pct.toFixed(2)), currency, date: navDate },
        });
      }
    }
    nextNav[accountId] = { value: nav, date: navDate, currency };
  }
}

// ---- Run ---------------------------------------------------------------------------

let activityAt = state.activityAt;
if (tradeQuery) {
  const xml = await report(tradeQuery);
  if (xml) readTrades(xml, true);
}
if (activityQuery && (!activityAt || now.getTime() - Date.parse(activityAt) >= activityEveryMs || pending[activityQuery])) {
  const xml = await report(activityQuery);
  if (xml) {
    readTrades(xml, false);
    readActivity(xml);
    activityAt = now.toISOString();
  }
}

/** Around US market hours, executions are worth checking every 15 minutes; otherwise every 2 hours. */
function nearMarketHours(date: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 && minutes < 17 * 60 + 30;
}

// The engine accepts at most 100 events per run; keep the latest ones.
let list = [...events.values()];
const dropped = Math.max(0, list.length - 100);
if (dropped > 0) list = list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")).slice(-100);

const parts = [...accounts.entries()].map(([id, info]) => {
  const bits = [id];
  if (info.trades) bits.push(`${info.trades} execution${info.trades === 1 ? "" : "s"} today`);
  if (info.nav !== undefined) bits.push(`NAV ${money(info.nav)} ${info.currency ?? ""}`.trim());
  if (info.positions !== undefined) bits.push(`${info.positions} positions`);
  return bits.join(" · ");
});
if (stillGenerating.length > 0) parts.push("IBKR is still generating a report; collecting it next time");
if (dropped > 0) parts.push(`${dropped} older changes left out`);
const summary = (parts.join("; ") || "No changes").slice(0, 200);

console.log(JSON.stringify({
  events: list.map(({ key, summary, data }) => ({ key, summary, data })),
  summary,
  data: { accounts: Object.fromEntries(accounts), generating: stillGenerating },
  state: { pending, activityAt, positions: nextPositions, nav: nextNav },
  next_check_in: stillGenerating.length > 0 ? "5m" : tradeQuery && nearMarketHours(now) ? "15m" : "2h",
}));
