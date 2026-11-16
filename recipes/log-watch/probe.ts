// Log error & pattern watch (recipe log-watch v1).
//
// Tracks byte offset, inode, and file-header signature in `state` so only newly
// appended complete lines are inspected on each check, while logrotate/copytruncate
// resets cleanly to byte 0 without losing new entries.

type LogState = {
  initialized: boolean;
  offset: number;
  ino: number | null;
  head: string;
  headLen: number;
  epoch: number;
};

type ProbeEvent = { key: string; summary: string; data: Record<string, unknown> };

const MAX_EVENTS = 50;
const PARTIAL_LINE_LIMIT = 16 * 1024;
const STACK_CONTINUATION = /^\s+(?:at\s|File\s+"|Caused by:|\.\.\.\s+\d+\s+more\b|\^+)/;
const LEADING_TIMESTAMP =
  /^(?:\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+)/;

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const params = input.params ?? {};
const prevState = (input.state && typeof input.state === "object" ? input.state : null) as Partial<LogState> | null;

const rawPath = String(params.path ?? "").trim();
if (!rawPath) throw new Error("set probe.params.path to the log file to watch");

function resolveLogPath(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) return p === "~" ? home : home.replace(/\/+$/, "") + p.slice(1);
  }
  if (p.startsWith("/")) return p;
  return Deno.cwd().replace(/\/+$/, "") + "/" + p;
}

const flags = params.case_sensitive === true ? "" : "i";
let matchRe: RegExp;
try {
  matchRe = new RegExp(String(params.pattern ?? ""), flags);
} catch (error) {
  throw new Error("probe.params.pattern is not a valid regular expression: " + (error as Error).message);
}

let excludeRe: RegExp | undefined;
if (params.exclude) {
  try {
    excludeRe = new RegExp(String(params.exclude), flags);
  } catch (error) {
    throw new Error("probe.params.exclude is not a valid regular expression: " + (error as Error).message);
  }
}

const contextLines = Math.min(Math.max(Math.trunc(Number(params.context_lines ?? 4)), 0), 20);
const dedupeByLine = params.dedupe_by_line === true;
const missingOk = params.missing_ok === true;
const maxBytes = Math.max(4096, Math.trunc(Number(params.max_bytes_per_check ?? 524_288)));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function clip(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

const filePath = resolveLogPath(rawPath);
let stat: Deno.FileInfo;
try {
  stat = await Deno.stat(filePath);
} catch (error) {
  if (error instanceof Deno.errors.NotFound && missingOk) {
    const waitingState: LogState = {
      initialized: true,
      offset: 0,
      ino: null,
      head: "",
      headLen: 0,
      epoch: (prevState?.epoch ?? 0),
    };
    console.log(JSON.stringify({ events: [], state: waitingState, summary: "waiting for " + rawPath + " to be created" }));
    Deno.exit(0);
  }
  throw new Error("cannot access log file " + filePath + ": " + (error as Error).message);
}

const file = await Deno.open(filePath, { read: true });
try {
  const headLen = Math.min(stat.size, 256);
  const headBuf = new Uint8Array(headLen);
  let headRead = 0;
  while (headRead < headLen) {
    const n = await file.read(headBuf.subarray(headRead));
    if (n === null) break;
    headRead += n;
  }
  const head = headRead > 0 ? (await sha256Hex(headBuf.subarray(0, headRead))).slice(0, 16) : "";

  if (!prevState?.initialized) {
    const initial: LogState = {
      initialized: true,
      offset: stat.size,
      ino: stat.ino ?? null,
      head,
      headLen: headRead,
      epoch: 1,
    };
    console.log(JSON.stringify({ events: [], state: initial, summary: "watching " + rawPath + " from byte " + stat.size }));
    Deno.exit(0);
  }

  const prevOffset = typeof prevState.offset === "number" && prevState.offset >= 0 ? prevState.offset : 0;
  const inoChanged = prevState.ino !== null && prevState.ino !== undefined && stat.ino !== null && stat.ino !== prevState.ino;
  const headChanged =
    typeof prevState.headLen === "number" &&
    prevState.headLen > 0 &&
    headRead >= prevState.headLen &&
    Boolean(prevState.head) &&
     (await sha256Hex(headBuf.subarray(0, prevState.headLen))).slice(0, 16) !== prevState.head;
  const rotated = stat.size < prevOffset || inoChanged || headChanged;

  const epoch = (prevState.epoch ?? 1) + (rotated ? 1 : 0);
  let readFrom = rotated ? 0 : prevOffset;
  let skippedBytes = 0;

  if (stat.size - readFrom > maxBytes) {
    skippedBytes = (stat.size - readFrom) - maxBytes;
    readFrom = stat.size - maxBytes;
  }

  const toRead = stat.size - readFrom;
  if (toRead <= 0) {
    const unchanged: LogState = { initialized: true, offset: stat.size, ino: stat.ino ?? null, head, headLen: headRead, epoch };
    console.log(JSON.stringify({ events: [], state: unchanged, summary: "no new output in " + rawPath + " (" + stat.size + " B)" }));
    Deno.exit(0);
  }

  await file.seek(readFrom, Deno.SeekMode.Start);
  const rawBuf = new Uint8Array(toRead);
  let got = 0;
  while (got < toRead) {
    const n = await file.read(rawBuf.subarray(got));
    if (n === null) break;
    got += n;
  }
  let slice = rawBuf.subarray(0, got);
  let sliceStartOffset = readFrom;

  // When skipping ahead mid-burst, drop the partial leading line fragment so matching starts at a line boundary.
  if (skippedBytes > 0) {
    const firstNl = slice.indexOf(0x0a);
    if (firstNl >= 0 && firstNl + 1 < slice.length) {
      skippedBytes += firstNl + 1;
      sliceStartOffset += firstNl + 1;
      slice = slice.subarray(firstNl + 1);
    }
  }

  // Hold an unterminated trailing line for the next check unless it is abnormally long.
  let nextOffset = sliceStartOffset + slice.length;
  if (slice.length > 0 && slice[slice.length - 1] !== 0x0a) {
    const lastNl = slice.lastIndexOf(0x0a);
    const trailingBytes = lastNl >= 0 ? slice.length - (lastNl + 1) : slice.length;
    if (trailingBytes <= PARTIAL_LINE_LIMIT) {
      const completeLen = lastNl >= 0 ? lastNl + 1 : 0;
      nextOffset = sliceStartOffset + completeLen;
      slice = slice.subarray(0, completeLen);
    }
  }

  const text = decoder.decode(slice).replace(/\r\n/g, "\n");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text ? text.split("\n") : [];

  const events: ProbeEvent[] = [];
  let totalMatches = 0;
  let byteCursor = sliceStartOffset;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(byteCursor);
    byteCursor += encoder.encode(line).byteLength + 1;
  }

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (!matchRe.test(line) || (excludeRe && excludeRe.test(line))) continue;
    const matchIndex = idx;
    const matchOffset = lineOffsets[matchIndex]!;
    totalMatches += 1;

    const snippetLines = [line];
    let consumeUntil = idx;
    const limitIdx = Math.min(lines.length - 1, idx + contextLines);
    for (let j = idx + 1; j <= limitIdx; j += 1) {
      const candidate = lines[j]!;
      snippetLines.push(candidate);
      if (STACK_CONTINUATION.test(candidate) || (matchRe.test(candidate) && !(excludeRe && excludeRe.test(candidate)))) {
        consumeUntil = j;
      }
    }
    idx = consumeUntil;

    if (events.length >= MAX_EVENTS) continue;
    const normalized = line.replace(LEADING_TIMESTAMP, "").trim();
    const key = dedupeByLine
      ? "log-line:" + (await sha256Hex(encoder.encode(normalized))).slice(0, 24)
      : "log:" + epoch + ":" + matchOffset;
    if (events.some((existing) => existing.key === key)) continue;

    events.push({
      key,
      summary: rawPath + " · " + clip(line, 130),
      data: {
        path: filePath,
        byte_offset: matchOffset,
        line: clip(line, 500),
        snippet: snippetLines.join("\n").slice(0, 1200),
        rotated,
      },
    });
  }

  let newHead = head;
  let newHeadLen = headRead;
  if (headRead === 0 && nextOffset > 0) {
    await file.seek(0, Deno.SeekMode.Start);
    const retryLen = Math.min(nextOffset, 256);
    const retryBuf = new Uint8Array(retryLen);
    const n = await file.read(retryBuf);
    if (n && n > 0) {
      newHead = (await sha256Hex(retryBuf.subarray(0, n))).slice(0, 16);
      newHeadLen = n;
    }
  }

  const nextState: LogState = {
    initialized: true,
    offset: nextOffset,
    ino: stat.ino ?? null,
    head: newHead,
    headLen: newHeadLen,
    epoch,
  };

  const parts = [lines.length + " new line(s) in " + rawPath, totalMatches + " match(es)"];
  if (rotated) parts.push("rotated");
  if (skippedBytes > 0) parts.push("skipped " + skippedBytes + " B");
  console.log(JSON.stringify({ events, state: nextState, summary: parts.join(", ") }));
} finally {
  file.close();
}
