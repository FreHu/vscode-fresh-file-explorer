import type { StonksDataPoint, XAxisMode } from "./messages";

/**
 * Time-bucket helpers for stonks data. Lives in the webview/ tree because both
 * the extension host (`stonksDataCollector`) and the chart webview (`stonksPanel`)
 * need byte-identical bucketing — duplicating it invited drift.
 *
 * All bucketing is UTC. That keeps axis labels stable across viewers regardless
 * of their local timezone; per-committer wall-clock charts (e.g. the activity
 * heatmap) take the committer's offset into account separately.
 */

export function bucketKey(iso: string, mode: XAxisMode): string {
  if (mode === "day") { return iso.substring(0, 10); }
  const d = new Date(iso);
  if (mode === "week") {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = day.getUTCDay() || 7; // Sunday=7 for ISO week (Monday-based)
    day.setUTCDate(day.getUTCDate() - dow + 1);
    return day.toISOString().substring(0, 10);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function bucketStartISO(iso: string, mode: XAxisMode): string {
  const d = new Date(iso);
  if (mode === "day") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }
  if (mode === "week") {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() - dow + 1);
    return day.toISOString();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Aggregate per-commit data points into time-based buckets.
 * "commit" mode returns the data unchanged (no aggregation).
 *
 * Note: `tzOffsetMinutes` is intentionally dropped — a bucket spans many
 * commits with potentially different offsets, so no single value is correct.
 * Charts that need committer-local time must operate on commit-mode data.
 */
export function aggregateStonksData(data: StonksDataPoint[], mode: XAxisMode): StonksDataPoint[] {
  if (mode === "commit") { return data; }
  const buckets = new Map<string, StonksDataPoint>();
  for (const d of data) {
    const key = bucketKey(d.date, mode);
    const existing = buckets.get(key);
    if (existing) {
      existing.filesChanged += d.filesChanged;
      existing.filesAdded += d.filesAdded;
      existing.filesDeleted += d.filesDeleted;
      existing.cumulativeFileCount = d.cumulativeFileCount; // last value wins (running total)
      existing.commitCount += d.commitCount;
    } else {
      buckets.set(key, {
        date: bucketStartISO(d.date, mode),
        filesChanged: d.filesChanged,
        filesAdded: d.filesAdded,
        filesDeleted: d.filesDeleted,
        cumulativeFileCount: d.cumulativeFileCount,
        commitCount: d.commitCount,
      });
    }
  }
  return [...buckets.values()];
}
