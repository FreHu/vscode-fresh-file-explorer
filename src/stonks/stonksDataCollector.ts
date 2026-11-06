import { CommitStats } from "../types";
import type { StonksDataPoint } from "../webview/messages";

export { aggregateStonksData } from "../webview/stonksBucketing";

/**
 * The commits from the last `days` calendar days (all of them when undefined),
 * and the oldest of those, whose parent's tree is the chart's baseline.
 * Undefined when no commit falls in the window.
 */
export function commitsInWindow(
  stats: Iterable<CommitStats>,
  days: number | undefined,
  now: Date = new Date(),
): { stats: CommitStats[]; oldest: CommitStats } | undefined {
  let inWindow = Array.from(stats);
  if (days !== undefined) {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    inWindow = inWindow.filter(s => s.commit.date >= cutoff);
  }
  if (inWindow.length === 0) { return undefined; }
  const oldest = inWindow.reduce((a, b) => a.commit.date < b.commit.date ? a : b);
  return { stats: inWindow, oldest };
}

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
      tzOffsetMinutes: s.commit.tzOffsetMinutes,
      message: s.commit.message,
      filesChanged: s.added + s.deleted + s.modified,
      filesAdded: s.added,
      filesDeleted: s.deleted,
      cumulativeFileCount: cumulative,
      commitCount: 1,
    };
  });
}
