import * as assert from "assert";
import { normalizePath, formatDaysLabel, setDifference, dotsDots } from "../../utils";

suite("Utils", () => {
  suite("normalizePath", () => {
    test("should convert backslashes to forward slashes", () => {
      assert.strictEqual(normalizePath("C:\\Users\\test\\file.txt"), "C:/Users/test/file.txt");
    });

    test("should handle paths with mixed separators", () => {
      assert.strictEqual(normalizePath("C:\\Users/test\\file.txt"), "C:/Users/test/file.txt");
    });

    test("should leave forward slashes unchanged", () => {
      assert.strictEqual(normalizePath("/home/user/file.txt"), "/home/user/file.txt");
    });

    test("should handle empty string", () => {
      assert.strictEqual(normalizePath(""), "");
    });

    test("should handle UNC paths", () => {
      assert.strictEqual(normalizePath("\\\\server\\share\\file.txt"), "//server/share/file.txt");
    });
  });

  suite("formatDaysLabel", () => {
    test("should format pending changes label", () => {
      assert.strictEqual(formatDaysLabel(-1), "Pending changes");
    });

    test("should format single day", () => {
      assert.strictEqual(formatDaysLabel(1), "1 day");
    });

    test("should format weeks", () => {
      assert.strictEqual(formatDaysLabel(7), "1 week");
      assert.strictEqual(formatDaysLabel(14), "2 weeks");
    });

    test("should format months", () => {
      assert.strictEqual(formatDaysLabel(30), "1 month");
      assert.strictEqual(formatDaysLabel(60), "2 months");
      assert.strictEqual(formatDaysLabel(90), "3 months");
      assert.strictEqual(formatDaysLabel(180), "6 months");
    });

    test("should format year", () => {
      assert.strictEqual(formatDaysLabel(365), "1 year");
    });

    test("should format custom day counts", () => {
      assert.strictEqual(formatDaysLabel(5), "5 days");
      assert.strictEqual(formatDaysLabel(100), "100 days");
    });
  });

  suite("setDifference", () => {
    test("should return elements in first set not in second", () => {
      const all = new Set([1, 2, 3, 4, 5]);
      const exclude = new Set([2, 4]);
      const result = setDifference(all, exclude);
      assert.deepStrictEqual(result, new Set([1, 3, 5]));
    });

    test("should handle empty exclude set", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set<number>([]);
      const result = setDifference(all, exclude);
      assert.deepStrictEqual(result, new Set([1, 2, 3]));
    });

    test("should handle exclude with no overlaps", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set([4, 5, 6]);
      const result = setDifference(all, exclude);
      assert.deepStrictEqual(result, new Set([1, 2, 3]));
    });

    test("should handle complete overlap", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set([1, 2, 3]);
      const result = setDifference(all, exclude);
      assert.deepStrictEqual(result, new Set([]));
    });

    test("should work with arrays as input", () => {
      const all = [1, 2, 3, 4, 5];
      const exclude = new Set([2, 4]);
      const result = setDifference(all, exclude);
      assert.deepStrictEqual(result, new Set([1, 3, 5]));
    });
  });

  suite("dotsDots", () => {
    test("should truncate strings longer than the specified length", () => {
      const longString = "a".repeat(100);
      assert.strictEqual(dotsDots(longString, 80), "a".repeat(77) + "...");
    });

    test("should not truncate strings shorter than the length", () => {
      const shortString = "hello world";
      assert.strictEqual(dotsDots(shortString, 80), "hello world");
    });

    test("should handle exact length strings", () => {
      const exactString = "a".repeat(80);
      assert.strictEqual(dotsDots(exactString, 80), "a".repeat(80));
    });

    test("should use default length of 80", () => {
      const longString = "a".repeat(100);
      assert.strictEqual(dotsDots(longString), "a".repeat(77) + "...");
    });

    test("should handle empty strings", () => {
      assert.strictEqual(dotsDots("", 80), "");
    });

    test("should handle custom lengths", () => {
      const string = "hello world this is a long string";
      assert.strictEqual(dotsDots(string, 10), "hello w...");
    });
  });
});
