import * as assert from "assert";
import {
  isPendingChangesMode,
  buildTimeWindows,
  DEFAULT_TIME_WINDOW_DAYS,
  type TimeWindow
} from "../../timeWindowUtils";

suite("Time Window Utils", () => {
  suite("isPendingChangesMode", () => {
    test("should return true for pending time window", () => {
      const pendingWindow: TimeWindow = { type: "pending", label: "Pending changes" };
      assert.strictEqual(isPendingChangesMode(pendingWindow), true);
    });

    test("should return false for historical time window", () => {
      const historicalWindow: TimeWindow = { type: "historical", label: "1 week", days: 7 };
      assert.strictEqual(isPendingChangesMode(historicalWindow), false);
    });
  });

  suite("buildTimeWindows", () => {
    test("should always include pending changes as first item", () => {
      const windows = buildTimeWindows([7, 14]);
      assert.deepStrictEqual(windows[0], { type: "pending", label: "Pending changes" });
    });

    test("should sort day values in ascending order", () => {
      const windows = buildTimeWindows([30, 7, 14, 1]);
      assert.strictEqual(windows.length, 5); // pending + 4 day values
      assert.deepStrictEqual(windows[1], { type: "historical", label: "1 day", days: 1 });
      assert.deepStrictEqual(windows[2], { type: "historical", label: "1 week", days: 7 });
      assert.deepStrictEqual(windows[3], { type: "historical", label: "2 weeks", days: 14 });
      assert.deepStrictEqual(windows[4], { type: "historical", label: "1 month", days: 30 });
    });

    test("should filter out non-positive values", () => {
      const windows = buildTimeWindows([7, 0, -5, 14]);
      assert.strictEqual(windows.length, 3); // pending + 2 positive values
      assert.strictEqual(windows.some(w => w.type === "historical" && w.days! <= 0), false);
    });

    test("should handle empty input", () => {
      const windows = buildTimeWindows([]);
      assert.deepStrictEqual(windows, [{ type: "pending", label: "Pending changes" }]);
    });

    test("should handle single day value", () => {
      const windows = buildTimeWindows([7]);
      assert.strictEqual(windows.length, 2);
      assert.deepStrictEqual(windows[0], { type: "pending", label: "Pending changes" });
      assert.deepStrictEqual(windows[1], { type: "historical", label: "1 week", days: 7 });
    });

    test("should use formatDaysLabel for custom labels", () => {
      const windows = buildTimeWindows([1, 7, 30, 365]);
      assert.deepStrictEqual(windows[1], { type: "historical", label: "1 day", days: 1 });
      assert.deepStrictEqual(windows[2], { type: "historical", label: "1 week", days: 7 });
      assert.deepStrictEqual(windows[3], { type: "historical", label: "1 month", days: 30 });
      assert.deepStrictEqual(windows[4], { type: "historical", label: "1 year", days: 365 });
    });

    test("should handle duplicate day values", () => {
      const windows = buildTimeWindows([7, 7, 14]);
      // Should sort but not deduplicate
      assert.strictEqual(windows.length, 4); // pending + 3 values
    });

    test("should work with DEFAULT_TIME_WINDOW_DAYS", () => {
      const windows = buildTimeWindows(DEFAULT_TIME_WINDOW_DAYS);
      assert.strictEqual(windows.length, DEFAULT_TIME_WINDOW_DAYS.length + 1);
      assert.strictEqual(windows[0].type, "pending");
      // Verify all are historical after the first
      for (let i = 1; i < windows.length; i++) {
        assert.strictEqual(windows[i].type, "historical");
      }
    });
  });

  suite("DEFAULT_TIME_WINDOW_DAYS", () => {
    test("should be an array of positive integers", () => {
      assert.ok(Array.isArray(DEFAULT_TIME_WINDOW_DAYS));
      assert.strictEqual(DEFAULT_TIME_WINDOW_DAYS.every(d => d > 0), true);
    });

    test("should contain expected default values", () => {
      assert.ok(DEFAULT_TIME_WINDOW_DAYS.includes(1));
      assert.ok(DEFAULT_TIME_WINDOW_DAYS.includes(7));
      assert.ok(DEFAULT_TIME_WINDOW_DAYS.includes(30));
    });
  });
});
