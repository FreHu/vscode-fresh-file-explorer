import * as assert from "assert";
import { searchCommits, findRanges, compileMatcher, describeResult, escapeRegex, splitByRanges } from "../../webview/logLSearch";
import type { CommitData } from "../../webview/messages";
import type { LogLSearchQuery } from "../../webview/logLSearch";

function commit(overrides?: Partial<CommitData>): CommitData {
  return {
    hash: "aaaaaaaaaaaa",
    shortHash: "aaaaaaa",
    author: "dev",
    date: "2026-01-01T00:00:00Z",
    message: "commit message",
    hunk: null,
    added: 0,
    removed: 0,
    filePathAtCommit: null,
    ...overrides,
  };
}

function q(text: string, overrides?: Partial<LogLSearchQuery>): LogLSearchQuery {
  return { text, isRegex: false, caseSensitive: false, scope: "all", ...overrides };
}

suite("logLSearch", () => {
  test("empty query matches nothing", () => {
    const r = searchCommits([commit({ message: "anything" })], q(""));
    assert.strictEqual(r.totalMatches, 0);
    assert.strictEqual(r.commitCount, 0);
    assert.strictEqual(r.error, null);
  });

  test("matches collapsed hunk text, not just the header", () => {
    const commits = [commit({ message: "unrelated", hunk: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const needle = 1;" })];
    const r = searchCommits(commits, q("needle"));
    assert.strictEqual(r.commitCount, 1);
    assert.strictEqual(r.totalMatches, 1);
    assert.deepStrictEqual(r.matches[0].hunkLines, [{ line: 2, ranges: [[7, 13]] }]);
    assert.deepStrictEqual(r.matches[0].messageRanges, []);
  });

  test("counts every occurrence, including several on one line", () => {
    const commits = [
      commit({ hash: "h1", message: "fix foo", hunk: "+foo foo\n bar" }),
      commit({ hash: "h2", message: "unrelated", hunk: "+baz" }),
    ];
    const r = searchCommits(commits, q("foo"));
    assert.strictEqual(r.commitCount, 1);
    assert.strictEqual(r.totalMatches, 3); // 1 in message + 2 on the hunk line
    assert.strictEqual(r.matches[0].hash, "h1");
    assert.strictEqual(r.matches[0].count, 3);
    assert.deepStrictEqual(r.matches[0].hunkLines[0].ranges, [[1, 4], [5, 8]]);
  });

  test("index points back into the searched array", () => {
    const commits = [commit({ hash: "h0" }), commit({ hash: "h1", message: "target" }), commit({ hash: "h2" })];
    const r = searchCommits(commits, q("target"));
    assert.strictEqual(r.matches[0].index, 1);
  });

  test("case insensitive by default, exact when asked", () => {
    const commits = [commit({ message: "Needle" })];
    assert.strictEqual(searchCommits(commits, q("needle")).totalMatches, 1);
    assert.strictEqual(searchCommits(commits, q("needle", { caseSensitive: true })).totalMatches, 0);
  });

  test("literal mode does not interpret regex metacharacters", () => {
    const commits = [commit({ message: "a.c" }), commit({ message: "abc" })];
    const r = searchCommits(commits, q("a.c"));
    assert.strictEqual(r.commitCount, 1);
    assert.strictEqual(r.matches[0].index, 0);
  });

  test("regex mode compiles the pattern", () => {
    const commits = [commit({ message: "fix #1234" })];
    const r = searchCommits(commits, q("#\\d+", { isRegex: true }));
    assert.strictEqual(r.totalMatches, 1);
    assert.deepStrictEqual(r.matches[0].messageRanges, [[4, 9]]);
  });

  test("invalid regex reports an error instead of throwing", () => {
    const r = searchCommits([commit({ message: "x" })], q("(unclosed", { isRegex: true }));
    assert.ok(r.error);
    assert.strictEqual(r.totalMatches, 0);
    assert.strictEqual(describeResult(r), "Invalid regex");
  });

  test("scope limits which side is searched", () => {
    const commits = [commit({ message: "needle", hunk: "+needle" })];
    assert.strictEqual(searchCommits(commits, q("needle", { scope: "all" })).totalMatches, 2);
    assert.strictEqual(searchCommits(commits, q("needle", { scope: "message" })).totalMatches, 1);
    assert.strictEqual(searchCommits(commits, q("needle", { scope: "diff" })).totalMatches, 1);
    assert.deepStrictEqual(searchCommits(commits, q("needle", { scope: "diff" })).matches[0].messageRanges, []);
  });

  test("null hunk is skipped without matching", () => {
    const r = searchCommits([commit({ message: "x", hunk: null })], q("needle", { scope: "diff" }));
    assert.strictEqual(r.commitCount, 0);
  });

  test("zero-length regex match terminates", () => {
    const r = searchCommits([commit({ message: "abc" })], q("x*", { isRegex: true }));
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.matches[0].messageRanges.length, 4); // one empty match per position + end
  });

  test("findRanges is reusable across calls on one matcher", () => {
    const re = compileMatcher(q("a")) as RegExp;
    assert.deepStrictEqual(findRanges("aa", re), [[0, 1], [1, 2]]);
    assert.deepStrictEqual(findRanges("ba", re), [[1, 2]]);
  });

  test("describeResult singularizes", () => {
    const one = searchCommits([commit({ message: "needle" })], q("needle"));
    assert.strictEqual(describeResult(one), "1 match in 1 commit");
    const many = searchCommits([commit({ hash: "a", message: "needle needle" }), commit({ hash: "b", message: "needle" })], q("needle"));
    assert.strictEqual(describeResult(many), "3 matches in 2 commits");
    assert.strictEqual(describeResult(searchCommits([commit()], q("zzz"))), "No matches");
  });

  test("escapeRegex neutralizes metacharacters", () => {
    assert.strictEqual(new RegExp(escapeRegex("a+b")).test("a+b"), true);
    assert.strictEqual(new RegExp(escapeRegex("a+b")).test("aab"), false);
  });
});

suite("splitByRanges", () => {
  test("no ranges yields the whole string as one plain segment", () => {
    assert.deepStrictEqual(splitByRanges("abc", []), [{ text: "abc", hit: false }]);
    assert.deepStrictEqual(splitByRanges("", []), []);
  });

  test("splits around a mid-string match", () => {
    assert.deepStrictEqual(splitByRanges("a foo b", [[2, 5]]), [
      { text: "a ", hit: false },
      { text: "foo", hit: true },
      { text: " b", hit: false },
    ]);
  });

  test("handles matches at both ends", () => {
    assert.deepStrictEqual(splitByRanges("ab", [[0, 1], [1, 2]]), [
      { text: "a", hit: true },
      { text: "b", hit: true },
    ]);
  });

  test("normalizes unsorted, overlapping and empty ranges", () => {
    assert.deepStrictEqual(splitByRanges("abcdef", [[3, 5], [0, 2], [1, 4], [2, 2]]), [
      { text: "ab", hit: true },
      { text: "cd", hit: true },
      { text: "e", hit: true },
      { text: "f", hit: false },
    ]);
  });

  test("segments concatenate back to the input", () => {
    const text = "the needle in the needlestack";
    const re = compileMatcher(q("needle")) as RegExp;
    const segments = splitByRanges(text, findRanges(text, re));
    assert.strictEqual(segments.map(s => s.text).join(""), text);
    assert.strictEqual(segments.filter(s => s.hit).length, 2);
  });
});
