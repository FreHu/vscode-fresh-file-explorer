import type { StonksDataPoint, XAxisMode } from "./messages";

export interface DerivedSeriesOptions {
  /** Commits in the rolling window for unique authors and author concentration. */
  authorWindow: number;
  /** How many of the busiest authors author concentration counts. */
  topX: number;
  /** Commits in the rolling window for average commit size. */
  commitSizeWindow: number;
}

/** One value per data point, for the sections computed from the raw points. */
export interface DerivedSeries {
  /** Distinct authors in the rolling window (commit mode only; empty otherwise). */
  authorCounts: number[];
  /** Percent of the window's commits made by its `topX` busiest authors (commit mode only; empty otherwise). */
  authorConcentration: number[];
  /** Commit mode: commits on the same calendar day. Aggregated modes: commits in the bucket. */
  velocity: number[];
  /** Files changed as a percent of the files in the repo at that point. */
  churn: number[];
  /** Commit mode: rolling average of files changed. Aggregated modes: average per commit in the bucket. */
  commitSize: number[];
}

/** The derived CodeStonks series for `data`. Rolling windows end at each point and shrink at the start. */
export function computeDerivedSeries(data: StonksDataPoint[], mode: XAxisMode, opts: DerivedSeriesOptions): DerivedSeries {
  const perCommit = mode === "commit";
  const authorCounts: number[] = [];
  const authorConcentration: number[] = [];
  if (perCommit) {
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - opts.authorWindow + 1);
      const authorCommits = new Map<string, number>();
      for (let j = start; j <= i; j++) {
        const a = data[j].author!;
        authorCommits.set(a, (authorCommits.get(a) ?? 0) + 1);
      }
      authorCounts.push(authorCommits.size);
      const sorted = [...authorCommits.values()].sort((a, b) => b - a);
      const topXSum = sorted.slice(0, opts.topX).reduce((s, v) => s + v, 0);
      authorConcentration.push((topXSum / (i - start + 1)) * 100);
    }
  }

  let velocity: number[];
  if (perCommit) {
    const dayMap = new Map<string, number>();
    for (const d of data) {
      const dayKey = d.date.substring(0, 10);
      dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + 1);
    }
    velocity = data.map(d => dayMap.get(d.date.substring(0, 10)) ?? 0);
  } else {
    velocity = data.map(d => d.commitCount);
  }

  const churn = data.map(d => d.cumulativeFileCount > 0 ? (d.filesChanged / d.cumulativeFileCount) * 100 : 0);

  let commitSize: number[];
  if (perCommit) {
    commitSize = [];
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - opts.commitSizeWindow + 1);
      let sum = 0;
      for (let j = start; j <= i; j++) { sum += data[j].filesChanged; }
      commitSize.push(sum / (i - start + 1));
    }
  } else {
    commitSize = data.map(d => d.commitCount > 0 ? d.filesChanged / d.commitCount : 0);
  }

  return { authorCounts, authorConcentration, velocity, churn, commitSize };
}
