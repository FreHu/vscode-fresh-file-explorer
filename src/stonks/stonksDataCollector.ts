import { CommitStats } from "../types";
import type { StonksDataPoint, XAxisMode } from "../webview/messages";

/**
 * Build the stonks chart data from pre-collected per-commit stats.
 * Walks commits oldest-first, computing cumulative file count on top of a baseline.
 */
export function buildStonksData(stats: CommitStats[], baseline: number): StonksDataPoint[] {
  // Sort oldest-first by date
  const sorted = [...stats].sort((a, b) => a.commit.date.getTime() - b.commit.date.getTime());

  let cumulative = baseline;
  return sorted.map(s => {
    cumulative += s.added - s.deleted;
    return {
      hash: s.commit.hash,
      author: s.commit.author,
      date: s.commit.date.toISOString(),
      message: s.commit.message,
      filesChanged: s.added + s.deleted + s.modified,
      filesAdded: s.added,
      filesDeleted: s.deleted,
      cumulativeFileCount: cumulative,
      commitCount: 1,
    };
  });
}

/**
 * Aggregate per-commit data points into time-based buckets.
 * "commit" mode returns the data as-is.
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
      existing.cumulativeFileCount = d.cumulativeFileCount; // last value wins
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

function bucketKey(iso: string, mode: XAxisMode): string {
  const d = new Date(iso);
  if (mode === "day") { return iso.substring(0, 10); }
  if (mode === "week") {
    // ISO week — Monday-based
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = day.getUTCDay() || 7; // Sunday=7
    day.setUTCDate(day.getUTCDate() - dow + 1); // Monday
    return day.toISOString().substring(0, 10);
  }
  // month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function bucketStartISO(iso: string, mode: XAxisMode): string {
  const d = new Date(iso);
  if (mode === "day") { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); }
  if (mode === "week") {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() - dow + 1);
    return day.toISOString();
  }
  // month
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
