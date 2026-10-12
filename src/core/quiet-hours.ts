// Quiet hours: a daily window, in a given time zone, during which notifications wait.

import type { QuietHours } from "./definition.js";

function minutesOfDay(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
}

/** Local minutes since midnight of `now` in time zone `tz`. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** True when `now` falls inside the window. Windows may wrap past midnight, such as 23:00 to 08:00. */
export function isQuietTime(now: Date, quiet: QuietHours | undefined): boolean {
  if (!quiet) return false;
  const from = minutesOfDay(quiet.from);
  const to = minutesOfDay(quiet.to);
  if (from === to) return false;
  const current = localMinutes(now, quiet.tz);
  return from < to ? current >= from && current < to : current >= from || current < to;
}
