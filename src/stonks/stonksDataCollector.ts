import { CommitStats } from "../types";
import type { StonksDataPoint } from "../webview/messages";

export { aggregateStonksData } from "../webview/stonksBucketing";

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
