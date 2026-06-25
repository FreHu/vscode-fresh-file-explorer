import * as assert from "assert";
import { blameTimestampToBucket, HEATMAP_IN_WINDOW_BUCKETS } from "../../heatmap/heatmapUtils";
import { parseBranchHunks, parseGitBlamePorcelain } from "../../git/blameDiffParsers";

suite("blameHeatmapController", () => {
  // ─── parseGitBlamePorcelain ──────────────────────────────────────────────

  suite("parseGitBlamePorcelain", () => {
    // Minimal well-formed porcelain output for a 3-line file.
    // Line 1 and 3 share the same commit; line 2 has a different commit.
    const COMMIT_A = "a".repeat(40);
    const COMMIT_B = "b".repeat(40);
    const TS_A = 1_700_000_000;
    const TS_B = 1_600_000_000;

    function makeHeader(sha: string, origLine: number, finalLine: number, timestamp: number, filename = "foo.ts", author = "Alice", summary = "initial"): string {
      return [
        `${sha} ${origLine} ${finalLine} 1`,
        `author ${author}`,
        `author-mail <alice@example.com>`,
        `author-time ${timestamp}`,
        `author-tz +0000`,
        `committer Alice`,
        `committer-mail <alice@example.com>`,
        `committer-time ${timestamp}`,
        `committer-tz +0000`,
        `summary ${summary}`,
        `filename ${filename}`,
      ].join("\n");
    }

    /** Short form used for repeated commit lines (no header fields). */
    function makeRepeatLine(sha: string, origLine: number, finalLine: number): string {
      return `${sha} ${origLine} ${finalLine}`;
    }

    test("parses three lines with two distinct commits", () => {
      const output = [
        makeHeader(COMMIT_A, 1, 1, TS_A, "foo.ts", "Alice", "Add feature"),
        "\tconst x = 1;",
        makeHeader(COMMIT_B, 2, 2, TS_B, "foo.ts", "Bob", "Fix bug"),
        "\tconst y = 2;",
        // Commit A appears again (no header, short form)
        makeRepeatLine(COMMIT_A, 3, 3),
        "\tconst z = 3;",
        "",
      ].join("\n");

      const result = parseGitBlamePorcelain(output);

      assert.strictEqual(result.length, 3);

      assert.strictEqual(result[0].lineIndex, 0);
      assert.strictEqual(result[0].sha, COMMIT_A);
      assert.strictEqual(result[0].timestamp, TS_A);
      assert.strictEqual(result[0].author, "Alice");
      assert.strictEqual(result[0].summary, "Add feature");

      assert.strictEqual(result[1].lineIndex, 1);
      assert.strictEqual(result[1].sha, COMMIT_B);
      assert.strictEqual(result[1].timestamp, TS_B);
      assert.strictEqual(result[1].author, "Bob");
      assert.strictEqual(result[1].summary, "Fix bug");

      assert.strictEqual(result[2].lineIndex, 2);
      assert.strictEqual(result[2].sha, COMMIT_A);
      assert.strictEqual(result[2].timestamp, TS_A, "repeated commit reuses cached timestamp");
      assert.strictEqual(result[2].author, "Alice", "repeated commit reuses cached author");
      assert.strictEqual(result[2].summary, "Add feature", "repeated commit reuses cached summary");
    });

    test("returns empty array for empty output", () => {
      assert.deepStrictEqual(parseGitBlamePorcelain(""), []);
    });

    test("returns empty array for output with no tab-lines", () => {
      // Commit header without content lines should produce nothing.
      const output = makeHeader(COMMIT_A, 1, 1, TS_A);
      assert.deepStrictEqual(parseGitBlamePorcelain(output), []);
    });

    test("line indices are 0-based (git blame final_line is 1-based)", () => {
      const output = [makeHeader(COMMIT_A, 1, 5, TS_A), "\tsome line", ""].join("\n");
      const result = parseGitBlamePorcelain(output);
      assert.strictEqual(result[0].lineIndex, 4, "final_line=5 → lineIndex=4");
    });

    test("handles a single-line file", () => {
      const output = [makeHeader(COMMIT_A, 1, 1, TS_A), "\thello", ""].join("\n");
      const result = parseGitBlamePorcelain(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].lineIndex, 0);
      assert.strictEqual(result[0].timestamp, TS_A);
    });
  });

  // ─── blameTimestampToBucket ─────────────────────────────────────────────

  suite("blameTimestampToBucket", () => {
    // windowDays is derived from the oldest line in the file, so the oldest
    // line always sits at the boundary and produces the highest in-window bucket.
    // age8 (HEATMAP_BUCKET_COUNT-1) is therefore never produced.
    const WINDOW_DAYS = 90;
    const NOW_MS = new Date("2026-01-15T12:00:00Z").getTime();

    const secondsAgo = (days: number): number =>
      Math.floor((NOW_MS - days * 24 * 60 * 60 * 1000) / 1000);

    test("brand-new line (0 days old) maps to bucket 0 (freshest)", () => {
      assert.strictEqual(blameTimestampToBucket(secondsAgo(0), WINDOW_DAYS, NOW_MS), 0);
    });

    test("line at exactly the window boundary maps to age7 (HEATMAP_IN_WINDOW_BUCKETS-1)", () => {
      const bucket = blameTimestampToBucket(secondsAgo(WINDOW_DAYS), WINDOW_DAYS, NOW_MS);
      assert.strictEqual(bucket, HEATMAP_IN_WINDOW_BUCKETS - 1);
    });

    test("all lines produce buckets in [0, HEATMAP_IN_WINDOW_BUCKETS-1] (age8 never produced)", () => {
      for (const d of [0, 1, 7, 14, 30, 60, 90]) {
        const bucket = blameTimestampToBucket(secondsAgo(d), WINDOW_DAYS, NOW_MS);
        assert.ok(bucket >= 0 && bucket < HEATMAP_IN_WINDOW_BUCKETS,
          `days=${d}: expected bucket in [0,${HEATMAP_IN_WINDOW_BUCKETS - 1}], got ${bucket}`);
      }
    });

    test("fresher lines get lower bucket numbers than older lines", () => {
      const fresh = blameTimestampToBucket(secondsAgo(1), WINDOW_DAYS, NOW_MS);
      const older = blameTimestampToBucket(secondsAgo(60), WINDOW_DAYS, NOW_MS);
      assert.ok(fresh < older, `fresh bucket ${fresh} should be less than older bucket ${older}`);
    });
  });

  // ─── parseBranchHunks ───────────────────────────────────────────────────

  suite("parseBranchHunks", () => {
    test("returns empty record for empty input", () => {
      const result = parseBranchHunks("");
      assert.deepStrictEqual(result.deletions, []);
      assert.strictEqual(result.addedLines.size, 0);
      assert.strictEqual(result.modifiedLines.size, 0);
    });

    test("parses a pure deletion hunk", () => {
      const diff = "@@ -10,3 +9,0 @@\n-line1\n-line2\n-line3\n";
      const { deletions, addedLines, modifiedLines } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 1);
      assert.strictEqual(deletions[0].afterNewLine1, 9);
      assert.strictEqual(deletions[0].count, 3);
      assert.deepStrictEqual(deletions[0].lines, ["line1", "line2", "line3"]);
      assert.strictEqual(addedLines.size, 0);
      assert.strictEqual(modifiedLines.size, 0);
    });

    test("handles omitted count (,1 shorthand means count=1)", () => {
      const diff = "@@ -5 +4,0 @@\n-only line\n";
      const { deletions } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 1);
      assert.strictEqual(deletions[0].afterNewLine1, 4);
      assert.strictEqual(deletions[0].count, 1);
      assert.deepStrictEqual(deletions[0].lines, ["only line"]);
    });

    test("classifies mixed hunks as modifications, not deletions", () => {
      // 3 lines removed, 1 line added at new-file line 8 — modification.
      const diff = "@@ -10,3 +8,1 @@\n-old1\n-old2\n-old3\n+new\n";
      const { deletions, addedLines, modifiedLines } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 0);
      assert.strictEqual(addedLines.size, 0);
      assert.deepStrictEqual([...modifiedLines], [8]);
    });

    test("classifies pure additions correctly (OLDCOUNT = 0)", () => {
      const diff = "@@ -5,0 +6,2 @@\n+new1\n+new2\n";
      const { deletions, addedLines, modifiedLines } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 0);
      assert.deepStrictEqual([...addedLines].sort((a, b) => a - b), [6, 7]);
      assert.strictEqual(modifiedLines.size, 0);
    });

    test("handles BOF deletion (afterNewLine1 = 0)", () => {
      const diff = "@@ -1,2 +0,0 @@\n-first\n-second\n";
      const { deletions } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 1);
      assert.strictEqual(deletions[0].afterNewLine1, 0);
      assert.strictEqual(deletions[0].count, 2);
      assert.deepStrictEqual(deletions[0].lines, ["first", "second"]);
    });

    test("returns multiple categories from a mixed diff", () => {
      const diff = [
        "@@ -3,1 +2,0 @@",       // pure deletion
        "-removed early",
        "@@ -10,0 +9,2 @@",       // pure addition at lines 9,10
        "+new1",
        "+new2",
        "@@ -20,2 +20,1 @@",      // modification at line 20
        "-old1",
        "-old2",
        "+replacement",
      ].join("\n");
      const { deletions, addedLines, modifiedLines } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 1);
      assert.deepStrictEqual(deletions[0], { afterNewLine1: 2, count: 1, lines: ["removed early"] });
      assert.deepStrictEqual([...addedLines].sort((a, b) => a - b), [9, 10]);
      assert.deepStrictEqual([...modifiedLines], [20]);
    });

    test("ignores non-hunk lines", () => {
      const diff = [
        "diff --git a/foo.ts b/foo.ts",
        "index abc..def 100644",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -7,2 +6,0 @@",
        "-line1",
        "-line2",
      ].join("\n");
      const { deletions } = parseBranchHunks(diff);
      assert.strictEqual(deletions.length, 1);
      assert.deepStrictEqual(deletions[0], { afterNewLine1: 6, count: 2, lines: ["line1", "line2"] });
    });
  });
});
