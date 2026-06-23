import { formatTimeWindowLabel } from "../utils/formatUtils";

/**
 * TimeWindow discriminated union
 * Either pending changes (no days field) or historical changes (with days field)
 */
export type TimeWindow = { type: "pending"; label: string } | { type: "historical"; label: string; days: number };

/** Check if a time window represents "pending changes only" mode */
export function isPendingChangesMode(tw: TimeWindow): tw is { type: "pending"; label: string } {
  return tw.type === "pending";
}

/**
 * A configured time window value: either a bare number (legacy — interpreted as
 * days) or a duration token like "6h", "1d", "2w", "1mo", "1y".
 */
export type TimeWindowValue = number | string;

/**
 * Default time windows (excluding pending changes, which is always available).
 * Must stay in sync with the `freshFileExplorer.timeWindows` default in
 * package.json — a drift test enforces this.
 */
export const DEFAULT_TIME_WINDOWS: TimeWindowValue[] = ["3h", "6h", "12h", "1d", "3d", "1w", "2w", "1mo", "3mo"];

const DURATION_UNIT_DAYS: Record<string, number> = {
  h: 1 / 24,
  d: 1,
  w: 7,
  mo: 30,
  y: 365,
};

// <amount><unit>, e.g. "6h", "1d", "1.5w", "2mo". Unit is case-insensitive.
const DURATION_TOKEN = /^\s*(\d+(?:\.\d+)?)\s*(h|d|w|mo|y)\s*$/i;

/**
 * Parse a configured time window value into a magnitude in (possibly fractional)
 * days. Bare numbers are treated as days for backward compatibility. Returns
 * `null` for unparseable or non-positive values so callers can skip them.
 */
export function parseTimeWindowValue(value: TimeWindowValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const match = DURATION_TOKEN.exec(value);
  if (!match) { return null; }
  const amount = parseFloat(match[1]);
  const days = amount * DURATION_UNIT_DAYS[match[2].toLowerCase()];
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Build TimeWindow array from configured values (numbers = days, or duration
 * tokens like "6h"/"1w"). Unparseable/non-positive entries are dropped.
 */
export function buildTimeWindows(values: ReadonlyArray<TimeWindowValue>): TimeWindow[] {
  // Always start with pending changes
  const windows: TimeWindow[] = [{ type: "pending", label: "Pending changes" }];

  const days = values
    .map(parseTimeWindowValue)
    .filter((d): d is number => d !== null)
    // sort ascending defensively even if caller already sorted
    .sort((a, b) => a - b);

  for (const d of days) {
    windows.push({ type: "historical", label: formatTimeWindowLabel(d), days: d });
  }

  return windows;
}
