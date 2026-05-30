import * as assert from "assert";
import {
  formatRepoDescription,
  formatRepoTooltip,
  formatDirectoryTooltip,
  formatRelativeDate,
  escapeRegex,
  getStatusLabel,
  truncate,
  formatLineChanges,
} from "../../utils/formatUtils";

suite("Format Utils", () => {
  suite("formatRepoDescription", () => {
    test("should format with branch name and file count", () => {
      assert.strictEqual(formatRepoDescription("main", 5), "(5) 🔀 main");
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
        static override now() {
          return now.getTime();
        }
      };
    });

    teardown(() => {
      // Restore original Date
      (global as any).Date = Date;
    });

    test("should format very recent times as 'now'", () => {
      assert.strictEqual(formatRelativeDate(minutesAgo(0)), "now");
      assert.strictEqual(formatRelativeDate(minutesAgo(1)), "1m");
    });

    test("should format minutes ago", () => {
      assert.strictEqual(formatRelativeDate(minutesAgo(5)), "5m");
      assert.strictEqual(formatRelativeDate(minutesAgo(30)), "30m");
      assert.strictEqual(formatRelativeDate(minutesAgo(59)), "59m");
    });

    test("should format hours ago", () => {
      assert.strictEqual(formatRelativeDate(hoursAgo(1)), "1h");
      assert.strictEqual(formatRelativeDate(hoursAgo(5)), "5h");
      assert.strictEqual(formatRelativeDate(hoursAgo(23)), "23h");
    });

    test("should format days ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(1)), "1d");
      assert.strictEqual(formatRelativeDate(daysAgo(2)), "2d");
      assert.strictEqual(formatRelativeDate(daysAgo(6)), "6d");
    });

    test("should format weeks ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(7)), "1w");
      assert.strictEqual(formatRelativeDate(daysAgo(14)), "2w");
      assert.strictEqual(formatRelativeDate(daysAgo(21)), "3w");
    });

    test("should format months ago", () => {
      assert.strictEqual(formatRelativeDate(daysAgo(30)), "1mo");
      assert.strictEqual(formatRelativeDate(daysAgo(60)), "2mo");
    });
  });

  suite("escapeRegex", () => {
    test("leaves plain alphanumeric strings unchanged", () => {
      assert.strictEqual(escapeRegex("hello"), "hello");
      assert.strictEqual(escapeRegex("foo123"), "foo123");
    });

    test("escapes all regex special characters", () => {
      assert.strictEqual(escapeRegex("."), "\\.");
      assert.strictEqual(escapeRegex("*"), "\\*");
      assert.strictEqual(escapeRegex("+"), "\\+");
      assert.strictEqual(escapeRegex("?"), "\\?");
      assert.strictEqual(escapeRegex("^"), "\\^");
      assert.strictEqual(escapeRegex("$"), "\\$");
      assert.strictEqual(escapeRegex("{"), "\\{");
      assert.strictEqual(escapeRegex("}"), "\\}");
      assert.strictEqual(escapeRegex("("), "\\(");
      assert.strictEqual(escapeRegex(")"), "\\)");
      assert.strictEqual(escapeRegex("|"), "\\|");
      assert.strictEqual(escapeRegex("["), "\\[");
      assert.strictEqual(escapeRegex("]"), "\\]");
      assert.strictEqual(escapeRegex("\\"), "\\\\");
    });

    test("escapes special characters embedded in a longer string", () => {
      assert.strictEqual(escapeRegex("foo.bar"), "foo\\.bar");
      assert.strictEqual(escapeRegex("a+b*c"), "a\\+b\\*c");
    });

    test("returns empty string for empty input", () => {
      assert.strictEqual(escapeRegex(""), "");
    });
  });

  suite("getStatusLabel", () => {
    // Standard single-letter codes
    test("M → modified", () => assert.strictEqual(getStatusLabel("M"), "modified"));
    test("A → added",    () => assert.strictEqual(getStatusLabel("A"), "added"));
    test("D → deleted",  () => assert.strictEqual(getStatusLabel("D"), "deleted"));
    test("R → renamed",  () => assert.strictEqual(getStatusLabel("R"), "renamed"));
    test("C → copied",   () => assert.strictEqual(getStatusLabel("C"), "copied"));
    test("T → type changed", () => assert.strictEqual(getStatusLabel("T"), "type changed"));
    test("?? → untracked",   () => assert.strictEqual(getStatusLabel("??"), "untracked"));
    test("!! → ignored",     () => assert.strictEqual(getStatusLabel("!!"), "ignored"));

    // Staged + unstaged combinations
    test("MM → modified (staged + unstaged)", () => assert.strictEqual(getStatusLabel("MM"), "modified (staged + unstaged)"));
    test("AM → added (staged) + modified",    () => assert.strictEqual(getStatusLabel("AM"), "added (staged) + modified"));
    test("AD → added (staged) + deleted",     () => assert.strictEqual(getStatusLabel("AD"), "added (staged) + deleted"));
    test("MD → modified (staged) + deleted",  () => assert.strictEqual(getStatusLabel("MD"), "modified (staged) + deleted"));
    test("RM → renamed (staged) + modified",  () => assert.strictEqual(getStatusLabel("RM"), "renamed (staged) + modified"));

    // Merge conflict codes
    test("UU → conflict (both modified)",  () => assert.strictEqual(getStatusLabel("UU"), "conflict (both modified)"));
    test("AA → conflict (both added)",     () => assert.strictEqual(getStatusLabel("AA"), "conflict (both added)"));
    test("DD → conflict (both deleted)",   () => assert.strictEqual(getStatusLabel("DD"), "conflict (both deleted)"));
    test("AU → conflict (added by us)",    () => assert.strictEqual(getStatusLabel("AU"), "conflict (added by us)"));
    test("UA → conflict (added by them)",  () => assert.strictEqual(getStatusLabel("UA"), "conflict (added by them)"));
    test("DU → conflict (deleted by us)",  () => assert.strictEqual(getStatusLabel("DU"), "conflict (deleted by us)"));
    test("UD → conflict (deleted by them)", () => assert.strictEqual(getStatusLabel("UD"), "conflict (deleted by them)"));

    // Raw XY porcelain codes (unstaged-only: leading space)
    test(" M → modified", () => assert.strictEqual(getStatusLabel(" M"), "modified"));
    test(" D → deleted",  () => assert.strictEqual(getStatusLabel(" D"), "deleted"));
    test(" A → added",    () => assert.strictEqual(getStatusLabel(" A"), "added"));
    test(" T → type changed", () => assert.strictEqual(getStatusLabel(" T"), "type changed"));

    // Raw XY porcelain codes (staged-only: trailing space)
    test("M  → modified (staged)", () => assert.strictEqual(getStatusLabel("M "), "modified (staged)"));
    test("A  → added (staged)",    () => assert.strictEqual(getStatusLabel("A "), "added (staged)"));
    test("D  → deleted (staged)",  () => assert.strictEqual(getStatusLabel("D "), "deleted (staged)"));
    test("R  → renamed (staged)",  () => assert.strictEqual(getStatusLabel("R "), "renamed (staged)"));

    // git log --name-status R<score> / C<score> codes
    test("R078 → renamed",  () => assert.strictEqual(getStatusLabel("R078"), "renamed"));
    test("R100 → renamed",  () => assert.strictEqual(getStatusLabel("R100"), "renamed"));
    test("C100 → copied",   () => assert.strictEqual(getStatusLabel("C100"), "copied"));
    test("C050 → copied",   () => assert.strictEqual(getStatusLabel("C050"), "copied"));

    // Unknown codes fall back to lowercase
    test("unknown code is lowercased", () => assert.strictEqual(getStatusLabel("XY"), "xy"));
    test("already lowercase unknown is unchanged", () => assert.strictEqual(getStatusLabel("zz"), "zz"));
  });

  suite("truncate", () => {
    test("returns string unchanged when shorter than maxLength", () => {
      assert.strictEqual(truncate("hello", 10), "hello");
    });

    test("returns string unchanged when equal to maxLength", () => {
      assert.strictEqual(truncate("hello", 5), "hello");
    });

    test("truncates and appends ellipsis when longer than maxLength", () => {
      assert.strictEqual(truncate("hello world", 6), "hello…");
    });

    test("result length equals maxLength after truncation", () => {
      const result = truncate("abcdefgh", 5);
      assert.strictEqual([...result].length, 5); // spread handles the ellipsis char
    });

    test("handles empty string", () => {
      assert.strictEqual(truncate("", 5), "");
    });

    test("maxLength of 1 yields only the ellipsis", () => {
      assert.strictEqual(truncate("abc", 1), "…");
    });
  });

  suite("formatLineChanges", () => {
    test("returns empty string when both are 0", () => {
      assert.strictEqual(formatLineChanges(0, 0), "");
    });

    test("returns empty string when both are undefined", () => {
      assert.strictEqual(formatLineChanges(undefined, undefined), "");
    });

    test("shows only additions when deletions are 0", () => {
      assert.strictEqual(formatLineChanges(5, 0), "+5");
    });

    test("shows only deletions when additions are 0", () => {
      assert.strictEqual(formatLineChanges(0, 3), "-3");
    });

    test("shows both additions and deletions", () => {
      assert.strictEqual(formatLineChanges(15, 3), "+15 -3");
    });

    test("treats undefined as 0 for additions", () => {
      assert.strictEqual(formatLineChanges(undefined, 4), "-4");
    });

    test("treats undefined as 0 for deletions", () => {
      assert.strictEqual(formatLineChanges(7, undefined), "+7");
    });
  });
});
