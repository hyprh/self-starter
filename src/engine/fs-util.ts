import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Creates a directory readable only by the current user. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Writes through a temporary file and a rename, so readers never see half a file. */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Reads a JSON Lines file, skipping lines that do not parse (such as a torn last write). */
export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A crash in the middle of an append can leave a partial line; ignore it.
    }
  }
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}
