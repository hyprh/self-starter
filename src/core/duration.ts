// Durations are written as an integer and a unit, such as "30s", "5m", "2h" or "1d".

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PATTERN = /^(\d+)\s*(ms|s|m|h|d)$/;

/** Parses a duration string into milliseconds; returns undefined when malformed. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = PATTERN.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2]!];
  if (!Number.isSafeInteger(amount) || unit === undefined) return undefined;
  return amount * unit;
}

/** Formats milliseconds with the largest unit that divides them exactly. */
export function formatDuration(ms: number): string {
  for (const unit of ["d", "h", "m", "s"] as const) {
    const size = UNIT_MS[unit]!;
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
