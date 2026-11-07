import * as assert from "assert";
import { committerLocalDayHour, heatmapAuthorFilter } from "../../webview/stonksHeatmap";
import type { StonksDataPoint } from "../../webview/messages";

function commit(author: string, date: string, tzOffsetMinutes?: number): StonksDataPoint {
  return { author, date, tzOffsetMinutes, filesChanged: 1, filesAdded: 0, filesDeleted: 0, cumulativeFileCount: 1, commitCount: 1 };
}

suite("committerLocalDayHour", () => {
  test("uses the committer's offset, not the viewer's time zone", () => {
    // Sat 23:30 UTC is already Sun 01:30 for a committer at UTC+2.
    assert.deepStrictEqual(committerLocalDayHour(commit("a", "2026-01-03T23:30:00Z", 120)), { day: 0, hour: 1 });
  });

  test("falls back to UTC without an offset", () => {
    assert.deepStrictEqual(committerLocalDayHour(commit("a", "2026-01-03T23:30:00Z")), { day: 6, hour: 23 });
  });
});

suite("heatmapAuthorFilter", () => {
  const ada = commit("Ada", "2026-01-01T10:00:00Z");
  const bo = commit("Bo", "2026-01-01T10:00:00Z");

  test("no selection counts everyone", () => {
    assert.deepStrictEqual([ada, bo].filter(heatmapAuthorFilter(undefined, undefined)), [ada, bo]);
  });

  test("a selection counts only the selected authors", () => {
    assert.deepStrictEqual([ada, bo].filter(heatmapAuthorFilter(["Bo"], undefined)), [bo]);
  });

  test("a hovered author wins over the selection", () => {
    assert.deepStrictEqual([ada, bo].filter(heatmapAuthorFilter(["Bo"], "Ada")), [ada]);
  });
});
