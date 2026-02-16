import * as assert from "assert";
import {
  formatRepoDescription,
  formatRepoTooltip,
  formatDirectoryTooltip,
  formatRelativeDate
} from "../../utils/formatUtils";

suite("Format Utils", () => {
  suite("formatRepoDescription", () => {
    test("should format with branch name and file count", () => {
      assert.strictEqual(formatRepoDescription("main", 5), "(5) 🔀 main ");
    });

    test("should format without branch name", () => {
      assert.strictEqual(formatRepoDescription(undefined, 5), "(5)");
    });

    test("should show no files message with branch", () => {
      assert.strictEqual(formatRepoDescription("main", 0), "🔀 main (no fresh files)");
    });

    test("should show no files message without branch", () => {
      assert.strictEqual(formatRepoDescription(undefined, 0), "(no fresh files)");
    });
  });

  suite("formatRepoTooltip", () => {
    test("should format tooltip with branch name", () => {
      const result = formatRepoTooltip("my-project", "main", 10);
      assert.strictEqual(result, "my-project (main)\n10 file(s) modified");
    });

    test("should format tooltip without branch name", () => {
      const result = formatRepoTooltip("my-project", undefined, 5);
      assert.strictEqual(result, "my-project\n5 file(s) modified");
    });

    test("should handle singular file count", () => {
      const result = formatRepoTooltip("my-project", "main", 1);
      assert.strictEqual(result, "my-project (main)\n1 file(s) modified");
    });
  });

  suite("formatDirectoryTooltip", () => {
    test("should format directory tooltip with count and date", () => {
      const date = new Date("2026-01-28T12:00:00");
      const result = formatDirectoryTooltip(5, date);
      assert.ok(result.match(/5 file\(s\) modified, most recent: .+/));
    });

    test("should handle singular file count", () => {
      const date = new Date("2026-01-28T12:00:00");
      const result = formatDirectoryTooltip(1, date);
      assert.ok(result.match(/1 file\(s\) modified, most recent: .+/));
    });
  });

  suite("formatRelativeDate", () => {
    const now = new Date("2026-01-28T12:00:00");
    
    // Helper to create a date relative to 'now'
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    setup(() => {
      // Mock Date.now() to return our test date
      const originalDate = Date;
      (global as any).Date = class extends originalDate {
        constructor(...args: [] | [string | number | Date]) {
          if (args.length === 0) {
            super(now.getTime());
          } else {
            super(args[0]);
          }
        }
        static now() {
          return now.getTime();
        }
      };
    });

    teardown(() => {
      // Restore original Date
      (global as any).Date = Date;
    });

    test("should format very recent times as 'just now'", () => {
      assert.strictEqual(formatRelativeDate(minutesAgo(0)), "just now");
      assert.strictEqual(formatRelativeDate(minutesAgo(1)), "just now");
    });

    test("should format minutes ago", () => {
      assert.strictEqual(formatRelativeDate(minutesAgo(5)), "5 minutes ago");
      assert.strictEqual(formatRelativeDate(minutesAgo(30)), "30 minutes ago");
      assert.strictEqual(formatRelativeDate(minutesAgo(59)), "59 minutes ago");
    });

    test("should format hours ago", () => {
      assert.strictEqual(formatRelativeDate(hoursAgo(1)), "1 hour ago");
      assert.strictEqual(formatRelativeDate(hoursAgo(5)), "5 hours ago");
      assert.strictEqual(formatRelativeDate(hoursAgo(23)), "23 hours ago");
    });

    test("should format days ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(1)), "yesterday");
      assert.strictEqual(formatRelativeDate(daysAgo(2)), "2 days ago");
      assert.strictEqual(formatRelativeDate(daysAgo(6)), "6 days ago");
    });

    test("should format weeks ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(7)), "1 week ago");
      assert.strictEqual(formatRelativeDate(daysAgo(14)), "2 weeks ago");
      assert.strictEqual(formatRelativeDate(daysAgo(21)), "3 weeks ago");
    });

    test("should format months ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(30)), "1 month ago");
      assert.strictEqual(formatRelativeDate(daysAgo(60)), "2 months ago");
    });
  });
});
