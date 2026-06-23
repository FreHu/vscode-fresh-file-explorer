import * as assert from "assert";
import {
  isPendingChangesMode,
  buildTimeWindows,
  parseTimeWindowValue,
  DEFAULT_TIME_WINDOWS,
  type TimeWindow
} from "../../fresh-files/timeWindowUtils";

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

    test("should work with DEFAULT_TIME_WINDOWS", () => {
      const windows = buildTimeWindows(DEFAULT_TIME_WINDOWS);
      assert.strictEqual(windows.length, DEFAULT_TIME_WINDOWS.length + 1);
      assert.strictEqual(windows[0].type, "pending");
      // Verify all are historical after the first
      for (let i = 1; i < windows.length; i++) {
        assert.strictEqual(windows[i].type, "historical");
      }
    });
  });

  suite("parseTimeWindowValue", () => {
    test("treats bare numbers as days (legacy)", () => {
      assert.strictEqual(parseTimeWindowValue(14), 14);
      assert.strictEqual(parseTimeWindowValue(1), 1);
    });

    test("parses hour tokens to fractional days", () => {
      assert.strictEqual(parseTimeWindowValue("6h"), 0.25);
      assert.strictEqual(parseTimeWindowValue("12h"), 0.5);
      assert.strictEqual(parseTimeWindowValue("24h"), 1);
    });

    test("parses day/week/month/year tokens", () => {
      assert.strictEqual(parseTimeWindowValue("1d"), 1);
      assert.strictEqual(parseTimeWindowValue("2w"), 14);
      assert.strictEqual(parseTimeWindowValue("1mo"), 30);
      assert.strictEqual(parseTimeWindowValue("1y"), 365);
    });

    test("is case-insensitive and tolerates whitespace", () => {
      assert.strictEqual(parseTimeWindowValue(" 6H "), 0.25);
      assert.strictEqual(parseTimeWindowValue("1MO"), 30);
    });

    test("accepts decimal amounts", () => {
      assert.strictEqual(parseTimeWindowValue("1.5w"), 10.5);
    });

    test("returns null for unparseable or non-positive values", () => {
      assert.strictEqual(parseTimeWindowValue("garbage"), null);
      assert.strictEqual(parseTimeWindowValue("6"), null); // bare numeric string, no unit
      assert.strictEqual(parseTimeWindowValue("6m"), null); // 'm' is not a supported unit
      assert.strictEqual(parseTimeWindowValue(0), null);
      assert.strictEqual(parseTimeWindowValue(-5), null);
    });
  });

  suite("buildTimeWindows with duration tokens", () => {
    test("builds sub-day windows labelled in hours", () => {
      const windows = buildTimeWindows(["6h"]);
      assert.deepStrictEqual(windows[1], { type: "historical", label: "6 hours", days: 0.25 });
    });

    test("labels a single-hour window in the singular", () => {
      const windows = buildTimeWindows(["1h"]);
      assert.deepStrictEqual(windows[1], { type: "historical", label: "1 hour", days: 1 / 24 });
    });

    test("sorts mixed tokens and numbers by magnitude", () => {
      const windows = buildTimeWindows([7, "6h", "1mo", "1d"]);
      const days = windows.filter(w => w.type === "historical").map(w => (w as { days: number }).days);
      assert.deepStrictEqual(days, [0.25, 1, 7, 30]);
    });

    test("drops unparseable entries", () => {
      const windows = buildTimeWindows(["6h", "garbage", "1d"]);
      assert.strictEqual(windows.length, 3); // pending + 2 valid
    });

    test("token days reuse the day-based labels", () => {
      const windows = buildTimeWindows(["1w"]);
      assert.deepStrictEqual(windows[1], { type: "historical", label: "1 week", days: 7 });
    });
  });

  suite("DEFAULT_TIME_WINDOWS", () => {
    test("should be a non-empty array", () => {
      assert.ok(Array.isArray(DEFAULT_TIME_WINDOWS));
      assert.ok(DEFAULT_TIME_WINDOWS.length > 0);
    });

    test("every default value parses to a positive magnitude", () => {
      for (const value of DEFAULT_TIME_WINDOWS) {
        const days = parseTimeWindowValue(value);
        assert.ok(days !== null && days > 0, `unparseable default: ${JSON.stringify(value)}`);
      }
    });

    test("includes at least one sub-day window", () => {
      const hasSubDay = DEFAULT_TIME_WINDOWS.some(v => {
        const days = parseTimeWindowValue(v);
        return days !== null && days < 1;
      });
      assert.ok(hasSubDay, "expected a sub-day default window");
    });
  });
});
