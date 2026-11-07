import * as assert from "assert";
import { alignCompareSeries, computeBands, PADDING, SECTION_GAP, SectionKey } from "../../webview/stonksLayout";
import type { StonksDataPoint } from "../../webview/messages";

const LABELS = { authorWindow: 10, topX: 2, commitSizeWindow: 5 };
const ALL: Record<SectionKey, boolean> = {
  fileCount: true, filesChanged: true, authors: true, authorConcentration: true,
  velocity: true, churn: true, commitSize: true, activityHeatmap: true,
};

function bucket(date: string, cumulativeFileCount: number): StonksDataPoint {
  return { date, cumulativeFileCount, filesChanged: 0, filesAdded: 0, filesDeleted: 0, commitCount: 1 };
}

suite("computeBands", () => {
  test("author and heatmap sections exist only per commit", () => {
    assert.deepStrictEqual(computeBands(2000, ALL, "commit", LABELS).map(b => b.key),
      ["fileCount", "filesChanged", "authors", "authorConcentration", "velocity", "churn", "commitSize", "activityHeatmap"]);
    assert.deepStrictEqual(computeBands(2000, ALL, "week", LABELS).map(b => b.key),
      ["fileCount", "filesChanged", "velocity", "churn", "commitSize"]);
  });

  test("labels carry the window settings and the bucket size", () => {
    const labels = computeBands(2000, ALL, "commit", LABELS).map(b => b.label);
    assert.ok(labels.includes("Unique authors (rolling 10 commits)"));
    assert.ok(labels.includes("Author concentration (top 2)"));
    assert.ok(computeBands(2000, ALL, "month", LABELS).some(b => b.label === "Avg commit size (files/month)"));
  });

  test("bands stack from the top padding with a gap between them, heavier sections taller", () => {
    const bands = computeBands(1000, { ...ALL, authors: false, authorConcentration: false, activityHeatmap: false }, "commit", LABELS);
    assert.strictEqual(bands[0].top, PADDING.top);
    for (let i = 1; i < bands.length; i++) {
      assert.strictEqual(bands[i].top, bands[i - 1].top + bands[i - 1].height + SECTION_GAP);
    }
    assert.ok(bands[0].height > bands[1].height, "file count weighs double");
  });

  test("a short viewport keeps the minimum band height instead of squashing", () => {
    assert.ok(computeBands(100, ALL, "commit", LABELS).every(b => b.height >= 60));
  });

  test("no enabled sections, no bands", () => {
    const none = Object.fromEntries(Object.keys(ALL).map(k => [k, false])) as Record<SectionKey, boolean>;
    assert.deepStrictEqual(computeBands(1000, none, "commit", LABELS), []);
  });
});

suite("alignCompareSeries", () => {
  test("carries the last known count into buckets where a repo has no data, 0 before its first", () => {
    const visible = [bucket("2026-01-01", 5), bucket("2026-01-02", 6), bucket("2026-01-03", 7), bucket("2026-01-04", 8)];
    const other = { repoName: "other", repoPath: "/other", data: [bucket("2026-01-02", 3), bucket("2026-01-04", 9)] };
    assert.deepStrictEqual(alignCompareSeries(visible, [other], "day"),
      [{ repoName: "other", repoPath: "/other", values: [0, 3, 3, 9] }]);
  });
});
