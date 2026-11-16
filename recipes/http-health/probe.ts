// HTTP health check (recipe http-health v1).
//
// Runs in a network-only Deno sandbox restricted to `url.host` (plus any explicit
// `allow_hosts`). Configuration mistakes throw so `trigger_draft` rejects them;
// runtime connection errors, timeouts (including mid-body stalls), unexpected status
// codes, body/JSON mismatches, and slow responses report `{ fire: true }` so the state
// trigger fires when the service goes unhealthy and re-arms once it recovers.

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const params = input.params ?? {};

const rawUrl = String(params.url ?? "").trim();
let targetUrl: URL;
try {
  targetUrl = new URL(rawUrl);
} catch {
  throw new Error("probe.params.url must be a valid http:// or https:// URL");
}
if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
  throw new Error("probe.params.url must use http:// or https://");
}

const method = String(params.method ?? "GET").trim().toUpperCase();
if (!ALLOWED_METHODS.has(method)) {
  throw new Error("probe.params.method must be GET or HEAD");
}

const expectedStatuses: number[] = Array.isArray(params.expected_status) && params.expected_status.length > 0
  ? params.expected_status.map((n: unknown) => Number(n))
  : [200];
if (expectedStatuses.some((code) => !Number.isInteger(code) || code < 100 || code > 599)) {
  throw new Error("probe.params.expected_status must contain valid HTTP status codes (100-599)");
}
const allowedStatusSet = new Set(expectedStatuses);

let bodyRe: RegExp | undefined;
if (params.expect_body) {
  if (method === "HEAD") throw new Error("probe.params.expect_body cannot be used with method HEAD");
  try {
    bodyRe = new RegExp(String(params.expect_body));
  } catch (error) {
    throw new Error("probe.params.expect_body is not a valid regular expression: " + (error as Error).message);
  }
}

let jsonExpect: { path: string[]; rawExpected: string } | undefined;
if (params.expect_json) {
  if (method === "HEAD") throw new Error("probe.params.expect_json cannot be used with method HEAD");
  const spec = String(params.expect_json).trim();
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error('probe.params.expect_json must look like "field.path=expectedValue" (for example "status=ok")');
  }
  const path = spec.slice(0, eq).trim().split(".").filter(Boolean);
  if (path.length === 0) {
    throw new Error('probe.params.expect_json must specify a non-empty JSON field path before "="');
  }
  jsonExpect = { path, rawExpected: spec.slice(eq + 1).trim() };
}

const maxLatencyMs = Number(params.max_latency_ms ?? 0);
if (!Number.isFinite(maxLatencyMs) || maxLatencyMs < 0) {
  throw new Error("probe.params.max_latency_ms must be 0 or a positive number of milliseconds");
}
const timeoutMs = Math.min(Math.max(Number(params.request_timeout_ms ?? 10_000), 500), 120_000);

function lookupPath(root: unknown, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || !(key in (cursor as Record<string, unknown>))) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function matchesExpectedScalar(actual: unknown, expectedText: string): boolean {
  if (actual === undefined) return false;
  if (typeof actual === "string") return actual === expectedText || JSON.stringify(actual) === expectedText;
  if (typeof actual === "number" || typeof actual === "boolean") return String(actual) === expectedText;
  if (actual === null) return expectedText === "null";
  return JSON.stringify(actual) === expectedText;
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

const started = performance.now();
let response: Response;
let bodyText = "";
try {
  response = await fetch(targetUrl, {
    method,
    redirect: "follow",
    headers: {
      "User-Agent": "self-starter-http-health/1",
      Accept: jsonExpect ? "application/json, */*;q=0.8" : "*/*",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (method !== "HEAD" && (bodyRe || jsonExpect || !allowedStatusSet.has(response.status))) {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const limit = 64 * 1024;
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = value.subarray(0, Math.min(value.byteLength, limit - total));
        chunks.push(take);
        total += take.byteLength;
        if (total >= limit) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bodyText = new TextDecoder().decode(merged);
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
} catch (error) {
  const latencyMs = Math.round(performance.now() - started);
  // Permission errors mean the URL redirected to a host outside `allow_hosts`; surface clearly.
  if (error instanceof Deno.errors.NotCapable) {
    throw new Error("blocked redirect outside allowed sandbox host(s); add the redirect host to probe.params.allow_hosts");
  }
  const isTimeout = (error as Error)?.name === "TimeoutError" || /timed?\s*out|aborted/i.test(String((error as Error)?.message ?? ""));
  const reason = isTimeout ? "request timed out after " + timeoutMs + " ms" : clip((error as Error)?.message ?? String(error), 160);
  console.log(
    JSON.stringify({
      fire: true,
      summary: "unhealthy (" + targetUrl.host + targetUrl.pathname + "): " + reason,
      data: {
        url: targetUrl.href,
        ok: false,
        reason: isTimeout ? "timeout" : "network_error",
        error: reason,
        latency_ms: latencyMs,
      },
    }),
  );
  Deno.exit(0);
}

const latencyMs = Math.round(performance.now() - started);
const failures: string[] = [];

if (!allowedStatusSet.has(response.status)) {
  const location = response.headers.get("location");
  const redirectHint = response.status >= 300 && response.status < 400 && location ? " -> " + clip(location, 80) : "";
  failures.push("HTTP " + response.status + redirectHint + " (expected " + expectedStatuses.join("/") + ")");
}

if (failures.length === 0 && bodyRe && !bodyRe.test(bodyText)) {
  failures.push("body did not match /" + bodyRe.source + "/");
}

if (failures.length === 0 && jsonExpect) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    failures.push("response body is not valid JSON");
  }
  if (failures.length === 0) {
    const actual = lookupPath(parsed, jsonExpect.path);
    if (!matchesExpectedScalar(actual, jsonExpect.rawExpected)) {
      failures.push(
        "JSON " + jsonExpect.path.join(".") + "=" + JSON.stringify(actual) + " (expected " + jsonExpect.rawExpected + ")",
      );
    }
  }
}

if (failures.length === 0 && maxLatencyMs > 0 && latencyMs > maxLatencyMs) {
  failures.push("latency " + latencyMs + " ms exceeded " + maxLatencyMs + " ms");
}

if (failures.length > 0) {
  console.log(
    JSON.stringify({
      fire: true,
      summary: "unhealthy (" + targetUrl.host + targetUrl.pathname + "): " + failures.join("; "),
      data: {
        url: targetUrl.href,
        ok: false,
        status: response.status,
        latency_ms: latencyMs,
        failures,
        body_excerpt: clip(bodyText, 300),
      },
    }),
  );
} else {
  console.log(
    JSON.stringify({
      fire: false,
      rearm: true,
      summary: "healthy (" + targetUrl.host + targetUrl.pathname + "): HTTP " + response.status + " in " + latencyMs + " ms",
      data: {
        url: targetUrl.href,
        ok: true,
        status: response.status,
        latency_ms: latencyMs,
      },
    }),
  );
}
