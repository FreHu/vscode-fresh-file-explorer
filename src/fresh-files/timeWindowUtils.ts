import { formatDaysLabel } from "../utils/formatUtils";

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
 * Default time window day values (excluding pending changes which is always available)
 */
export const DEFAULT_TIME_WINDOW_DAYS: number[] = [1, 3, 7, 14, 30, 60, 90, 180];

/**
 * Build TimeWindow array from configured day values
 */
export function buildTimeWindows(dayValues: number[]): TimeWindow[] {
  // Always start with pending changes
  const windows: TimeWindow[] = [{ type: "pending", label: "Pending changes" }];

  // Add configured day windows, sorted ascending (sort defensively even if caller already sorted)
  for (const days of [...dayValues].sort((a, b) => a - b)) {
    if (days > 0) {
      windows.push({ type: "historical", label: formatDaysLabel(days), days });
    }
  }

  return windows;
}
