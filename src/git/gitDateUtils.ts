/**
 * Parse a strict ISO 8601 timestamp from `git log %aI`.
 *
 * Returns the absolute instant **and** the committer's timezone offset
 * (minutes east of UTC), since `new Date(iso)` discards the offset and
 * we need the original wall-clock for "hour of day" / "day of week" charts
 * that should reflect the committer's local time, not the viewer's.
 *
 * Format: `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`. `git log %aI` always
 * emits the colon variant; we also accept `±HHMM` for safety.
 */
export function parseCommitDate(iso: string): { date: Date; tzOffsetMinutes: number } {
  const date = new Date(iso);
  if (iso.endsWith("Z")) {
    return { date, tzOffsetMinutes: 0 };
  }
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) {
    return { date, tzOffsetMinutes: 0 };
  }
  const sign = m[1] === "+" ? 1 : -1;
  const tzOffsetMinutes = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  return { date, tzOffsetMinutes };
}
