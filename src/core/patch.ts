// Partial changes to a definition (trigger_update), and a readable list of differences.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Merges `patch` into `base`: mappings merge key by key, other values replace, null removes the key. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isRecord(value) && isRecord(out[key])) out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

/** Dotted paths of every leaf in a patch, such as "policy.cooldown". */
export function patchPaths(patch: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && Object.keys(value).length > 0) out.push(...patchPaths(value, path));
    else out.push(path);
  }
  return out;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (value !== undefined && value !== null) {
    out.set(prefix, JSON.stringify(value));
  }
}

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Lines such as `policy.cooldown: "1h" → "2h"`, ignoring the paths in `ignore`. */
export function describeChanges(before: unknown, after: unknown, ignore: string[] = []): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(before, "", a);
  flatten(after, "", b);
  const skip = (path: string) => ignore.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
  const paths = [...new Set([...a.keys(), ...b.keys()])].filter((path) => !skip(path)).sort();
  const lines: string[] = [];
  for (const path of paths) {
    const old = a.get(path);
    const now = b.get(path);
    if (old === now) continue;
    if (old === undefined) lines.push(`${path}: ${shorten(now!)} (new)`);
    else if (now === undefined) lines.push(`${path}: ${shorten(old)} (removed)`);
    else lines.push(`${path}: ${shorten(old)} → ${shorten(now)}`);
  }
  return lines;
}
