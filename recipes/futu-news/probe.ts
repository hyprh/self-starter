// Futu news watch (recipe futu-news v1).
//
// Searches Futu's news for each stock and type, newest first, and reports what it
// finds as events keyed by Futu's item id, so each research report, announcement or
// article is reported once:
//   <news_id>   "<stock> · research: <title>", with the time and the link in its data
// The engine records what the first run sees without reporting it. Items published
// more than max_age_hours ago are left out, so that an old item the search shows again
// is not reported as new. When Futu answers 429 (too many requests), the run keeps
// what it found, stops, and asks to be run again later instead of failing.

type Item = { news_id: string; title: string; publish_time: string | number; url: string };

const TYPES: Record<string, { id: number; label: string }> = {
  news: { id: 1, label: "news" },
  notice: { id: 2, label: "announcement" },
  research: { id: 3, label: "research" },
};

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const params = input.params ?? {};
const now = new Date(input.now).getTime();

const stocks: string[] = params.stocks ?? [];
if (stocks.length === 0) throw new Error('set probe.params.stocks, such as ["腾讯控股", "NVDA"]');
const types: string[] = params.types;
const unknown = types.filter((type) => !(type in TYPES));
if (unknown.length > 0) throw new Error(`unknown type ${unknown.join(", ")}; use research, notice or news`);
let match: RegExp | undefined;
try {
  match = params.match ? new RegExp(params.match, "i") : undefined;
} catch (error) {
  throw new Error(`match is not a valid regular expression: ${(error as Error).message}`);
}
const maxAgeMs = Number(params.max_age_hours) * 3_600_000;
const size = String(Math.min(Math.max(Number(params.per_search), 1), 50));
const spacingMs = Number(params.request_spacing_ms);
const BASE = String(params.base_url).replace(/\/+$/, "");

/** Futu asked to slow down; waitMs is how long, from Retry-After or 15 minutes. */
class SlowDown extends Error {
  constructor(readonly waitMs: number) {
    super("Futu asked to slow down");
  }
}

/** Titles mark the matched words with <em>. */
const plain = (title: string) => title.replace(/<\/?em>/g, "").replace(/\s+/g, " ").trim();

/** Futu gives seconds, sometimes milliseconds. */
const publishedAt = (time: string | number) => {
  const n = Number(time);
  return new Date(n > 1e12 ? n : n * 1000);
};

async function search(stock: string, type: string): Promise<Item[]> {
  const query = new URLSearchParams({ keyword: stock, size, news_type: String(TYPES[type]!.id), lang: params.lang, sort_type: "2" });
  const response = await fetch(`${BASE}/news_search?${query}`, {
    headers: { "User-Agent": "self-starter-futu-news/1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SlowDown(seconds > 0 ? seconds * 1000 : 15 * 60_000);
  }
  if (!response.ok) throw new Error(`Futu news search answered HTTP ${response.status} for ${stock}`);
  const body = await response.json();
  if (body.code !== 0) throw new Error(`Futu news search failed for ${stock}: ${body.message ?? body.msg ?? `code ${body.code}`}`);
  return Array.isArray(body.data) ? body.data : [];
}

const events = new Map<string, { key: string; summary: string; data: Record<string, unknown> }>();
const counts: string[] = [];
let slowDown: SlowDown | undefined;
let requests = 0;
search: for (const stock of stocks) {
  let recent = 0;
  for (const type of types) {
    if (requests++ > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    let items: Item[];
    try {
      items = await search(stock, type);
    } catch (error) {
      if (!(error instanceof SlowDown)) throw error;
      slowDown = error;
      break search;
    }
    for (const item of items) {
      const at = publishedAt(item.publish_time);
      const title = plain(item.title);
      if (now - at.getTime() > maxAgeMs || (match && !match.test(title))) continue;
      recent += 1;
      // The same item can turn up for two stocks; it is reported once.
      if (!events.has(item.news_id)) {
        events.set(item.news_id, {
          key: item.news_id,
          summary: `${stock} · ${TYPES[type]!.label}: ${title}`,
          data: { stock, type, title, published: at.toISOString(), url: item.url },
        });
      }
    }
  }
  counts.push(`${stock} ${recent}`);
}

const hours = Number(params.max_age_hours);
const summary = `${events.size} item(s) from the last ${hours} h on Futu (${counts.join(", ")})`;
if (slowDown) {
  const minutes = Math.ceil(slowDown.waitMs / 60_000);
  console.log(JSON.stringify({ events: [...events.values()], summary: `${summary}; Futu asked to slow down, next check in ${minutes} min`, next_check_in: `${minutes}m` }));
} else {
  console.log(JSON.stringify({ events: [...events.values()], summary }));
}
