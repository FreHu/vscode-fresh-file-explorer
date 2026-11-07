import * as assert from "assert";
import { EMPTY_FRAME, renderStonksTooltip, RenderedFrame } from "../../webview/stonksTooltip";
import type { SectionKey } from "../../webview/stonksLayout";
import type { StonksDataPoint } from "../../webview/messages";

const ALL: Record<SectionKey, boolean> = {
  fileCount: true, filesChanged: true, authors: true, authorConcentration: true,
  velocity: true, churn: true, commitSize: true, activityHeatmap: true,
};
const point: StonksDataPoint = {
  hash: "abc1234", message: "Fix it", author: "Ada", date: "2026-01-02T10:00:00Z",
  filesChanged: 3, filesAdded: 2, filesDeleted: 1, cumulativeFileCount: 40, commitCount: 2,
};
const frame: RenderedFrame = {
  ...EMPTY_FRAME, visibleData: [point], authorCounts: [2], authorConcentration: [66.6],
  velocity: [4], churn: [7.5], commitSize: [1.25],
};
const settings = { mode: "commit" as const, sections: ALL, authorWindow: 10, topX: 1, colorForRepo: () => "red" };

suite("renderStonksTooltip", () => {
  test("per commit: commit header, then one line per enabled section", () => {
    const out = renderStonksTooltip(frame, 0, settings);
    assert.ok(out.includes("abc1234") && out.includes("Fix it"));
    for (const line of ["Files in repo: 40", "Changed: 3", "Authors (10): 2", "Top-1: 67%", "Commits/day: 4", "Churn: 7.5%", "Avg size: 1.3 files"]) {
      assert.ok(out.includes(line), `missing "${line}"`);
    }
  });

  test("per bucket: commit count header, no author lines", () => {
    const out = renderStonksTooltip(frame, 0, { ...settings, mode: "week" });
    assert.ok(out.includes("2 commits"));
    assert.ok(out.includes("Commits/week: 4"));
    assert.ok(!out.includes("Authors ("));
  });

  test("disabled sections are left out; compare repos follow the file count", () => {
    const withCompare = { ...frame, compareLines: [{ repoName: "other", repoPath: "/o", values: [12] }] };
    const out = renderStonksTooltip(withCompare, 0, { ...settings, mode: "day", sections: { ...ALL, churn: false } });
    assert.ok(out.includes("other: 12"));
    assert.ok(!out.includes("Churn"));
  });
});
