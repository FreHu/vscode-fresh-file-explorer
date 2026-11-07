import * as assert from "assert";
import { computeDerivedSeries } from "../../webview/stonksDerivedSeries";
import type { StonksDataPoint } from "../../webview/messages";

function point(author: string, date: string, filesChanged: number, cumulativeFileCount = 10, commitCount = 1): StonksDataPoint {
  return { author, date, filesChanged, filesAdded: 0, filesDeleted: 0, cumulativeFileCount, commitCount };
}

const OPTS = { authorWindow: 3, topX: 1, commitSizeWindow: 2 };

suite("computeDerivedSeries", () => {
  const commits = [
    point("ada", "2026-01-01T10:00:00Z", 2),
    point("bo", "2026-01-01T12:00:00Z", 4),
    point("ada", "2026-01-02T09:00:00Z", 6),
    point("cy", "2026-01-03T09:00:00Z", 1, 0),
  ];

  test("unique authors count the rolling window, which shrinks at the start", () => {
    assert.deepStrictEqual(computeDerivedSeries(commits, "commit", OPTS).authorCounts, [1, 2, 2, 3]);
  });

  test("author concentration is the busiest author's share of the window", () => {
    const { authorConcentration } = computeDerivedSeries(commits, "commit", OPTS);
    assert.deepStrictEqual(authorConcentration.map(v => Math.round(v)), [100, 50, 67, 33]);
  });

  test("velocity counts commits on the same calendar day in commit mode", () => {
    assert.deepStrictEqual(computeDerivedSeries(commits, "commit", OPTS).velocity, [2, 2, 1, 1]);
  });

  test("churn is files changed over repo size, 0 for an empty repo", () => {
    assert.deepStrictEqual(computeDerivedSeries(commits, "commit", OPTS).churn, [20, 40, 60, 0]);
  });

  test("commit size is a rolling average of files changed", () => {
    assert.deepStrictEqual(computeDerivedSeries(commits, "commit", OPTS).commitSize, [2, 3, 5, 3.5]);
  });

  test("aggregated modes: no author series, per-bucket velocity and average size", () => {
    const buckets = [point("", "2026-01-01", 6, 10, 3), point("", "2026-01-02", 0, 10, 0)];
    const series = computeDerivedSeries(buckets, "day", OPTS);
    assert.deepStrictEqual(series.authorCounts, []);
    assert.deepStrictEqual(series.authorConcentration, []);
    assert.deepStrictEqual(series.velocity, [3, 0]);
    assert.deepStrictEqual(series.commitSize, [2, 0]);
  });
});
