import * as assert from "assert";
import { parseDiffOutput } from "../../diff-search/diffSearchParser";

const CWD = "/repo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(...strs: string[]): string {
  return strs.join("\n");
}

// Minimal `git diff` output for a single file with one hunk
function plainDiff(fileAdded = false): string {
  return lines(
    "diff --git a/src/foo.ts b/src/foo.ts",
    ...(fileAdded ? ["new file mode 100644"] : []),
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " unchanged",
    "+added line",
    "-removed line",
    " another unchanged",
  );
}

// Minimal `git log -p` output for a single commit
function logPDiff(): string {
  return lines(
    "commit abc1234567890123456789012345678901234ab",  // 40 chars after 'commit '
    "Author: Dev <dev@example.com>",
    "Date:   Mon Jan 1 12:00:00 2024 +0000",
    "",
    "    My commit message",
    "",
    "diff --git a/src/bar.ts b/src/bar.ts",
    "--- a/src/bar.ts",
    "+++ b/src/bar.ts",
    "@@ -5,2 +5,3 @@",
    " context",
    "+new line",
    "-old line",
  );
}

// ---------------------------------------------------------------------------

suite("parseDiffOutput", () => {
  suite("plain git diff (extractCommitInfo=false)", () => {
    test("returns empty array for empty input", () => {
      assert.deepStrictEqual(parseDiffOutput("", CWD, false), []);
    });

    test("parses an added line with correct lineNumber", () => {
      const matches = parseDiffOutput(plainDiff(), CWD, false);
      const added = matches.find(m => m.changeType === "added");
      assert.ok(added, "expected an added match");
      assert.strictEqual(added!.lineContent, "added line");
      assert.strictEqual(added!.lineNumber, 2); // hunk starts at +1, context takes line 1
    });

    test("parses a removed line with correct lineNumber", () => {
      const matches = parseDiffOutput(plainDiff(), CWD, false);
      const removed = matches.find(m => m.changeType === "removed");
      assert.ok(removed, "expected a removed match");
      assert.strictEqual(removed!.lineContent, "removed line");
      assert.strictEqual(removed!.lineNumber, 2); // hunk starts at -1, context takes line 1
    });

    test("builds absolute filePath from cwd + relative path", () => {
      const matches = parseDiffOutput(plainDiff(), CWD, false);
      for (const m of matches) {
        assert.ok(m.filePath.startsWith("/repo/src/foo.ts"), `unexpected path: ${m.filePath}`);
      }
    });

    test("no commitHash/commitMessage/commitDate when extractCommitInfo=false", () => {
      const matches = parseDiffOutput(logPDiff(), CWD, false);
      for (const m of matches) {
        assert.strictEqual(m.commitHash, undefined);
        assert.strictEqual(m.commitMessage, undefined);
        assert.strictEqual(m.commitDate, undefined);
      }
    });

    test("context lines advance lineNumbers without producing matches", () => {
      // Hunk: removed starts at 1, added starts at 1
      // ' ' context moves both forward + 1, then +2 added line should be lineNumber 2
      const raw = lines(
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,3 +1,3 @@",
        " ctx1",    // line 1 on both sides, advance to 2
        " ctx2",    // line 2, advance to 3
        "+add3",    // added at line 3
        "-rem3",    // removed at line 3
      );
      const matches = parseDiffOutput(raw, CWD, false);
      const added = matches.find(m => m.changeType === "added")!;
      const removed = matches.find(m => m.changeType === "removed")!;
      assert.strictEqual(added.lineNumber, 3);
      assert.strictEqual(removed.lineNumber, 3);
    });

    test("fileAdded=true when new file mode precedes the hunk", () => {
      const matches = parseDiffOutput(plainDiff(true), CWD, false);
      const added = matches.filter(m => m.changeType === "added");
      assert.ok(added.length > 0, "expected at least one added match");
      for (const m of added) {
        assert.strictEqual(m.fileAdded, true, "expected fileAdded=true on added match");
      }
    });

    test("fileAdded is not set on normal modifications", () => {
      const matches = parseDiffOutput(plainDiff(false), CWD, false);
      const added = matches.find(m => m.changeType === "added")!;
      assert.ok(!added.fileAdded);
    });

    test("binary file entry produces no matches and does not affect subsequent files", () => {
      const raw = lines(
        "diff --git a/img.png b/img.png",
        "--- a/img.png",
        "+++ b/img.png",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/src/code.ts b/src/code.ts",
        "--- a/src/code.ts",
        "+++ b/src/code.ts",
        "@@ -1,1 +1,2 @@",
        " ctx",
        "+real add",
      );
      const matches = parseDiffOutput(raw, CWD, false);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].lineContent, "real add");
      assert.ok(matches[0].filePath.includes("src/code.ts"));
    });

    test("multiple files in one diff are parsed correctly", () => {
      const raw = lines(
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "+add in a",
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "+add in b",
      );
      const matches = parseDiffOutput(raw, CWD, false);
      assert.strictEqual(matches.length, 2);
      assert.ok(matches[0].filePath.includes("a.ts"));
      assert.ok(matches[1].filePath.includes("b.ts"));
    });

    test("multiple hunks in one file reset line numbers correctly", () => {
      const raw = lines(
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,1 +1,2 @@",
        "+hunk1 add",    // added at line 1
        "@@ -10,1 +11,2 @@",
        "+hunk2 add",    // added at line 11
      );
      const matches = parseDiffOutput(raw, CWD, false);
      assert.strictEqual(matches.length, 2);
      assert.strictEqual(matches[0].lineNumber, 1);
      assert.strictEqual(matches[1].lineNumber, 11);
    });
  });

  suite("git log -p (extractCommitInfo=true)", () => {
    test("attaches commitHash to matches", () => {
      const matches = parseDiffOutput(logPDiff(), CWD, true);
      assert.ok(matches.length > 0);
      for (const m of matches) {
        assert.strictEqual(m.commitHash, "abc1234567890123456789012345678901234ab");
      }
    });

    test("attaches commitMessage to matches", () => {
      const matches = parseDiffOutput(logPDiff(), CWD, true);
      for (const m of matches) {
        assert.strictEqual(m.commitMessage, "My commit message");
      }
    });

    test("attaches commitDate to matches", () => {
      const matches = parseDiffOutput(logPDiff(), CWD, true);
      for (const m of matches) {
        assert.ok(m.commitDate instanceof Date);
        assert.strictEqual(m.commitDate!.getFullYear(), 2024);
      }
    });

    test("second commit's matches get second commit's hash", () => {
      const raw = lines(
        "commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Author: A <a@x.com>",
        "Date:   Mon Jan 1 00:00:00 2024 +0000",
        "",
        "    First commit",
        "",
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,1 +1,1 @@",
        "+from first",
        "commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "Author: B <b@x.com>",
        "Date:   Tue Jan 2 00:00:00 2024 +0000",
        "",
        "    Second commit",
        "",
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,1 +1,1 @@",
        "+from second",
      );
      const matches = parseDiffOutput(raw, CWD, true);
      assert.strictEqual(matches.length, 2);
      assert.ok(matches[0].commitHash!.includes("aaaaaa"));
      assert.ok(matches[1].commitHash!.includes("bbbbbb"));
      assert.strictEqual(matches[0].commitMessage, "First commit");
      assert.strictEqual(matches[1].commitMessage, "Second commit");
    });
  });

  suite("octal-encoded filenames (decodeGitPath)", () => {
    test("decodes octal sequences in file paths", () => {
      // Git encodes non-ASCII filenames as octal: é = \303\251
      // The +++ line without quotes is the one the parser uses
      const raw2 = lines(
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/caf\\303\\251.ts",
        "@@ -1,1 +1,1 @@",
        "+content",
      );
      const matches = parseDiffOutput(raw2, CWD, false);
      assert.strictEqual(matches.length, 1);
      // The decoded path should contain the é character
      assert.ok(matches[0].filePath.includes("café"), `path was: ${matches[0].filePath}`);
    });
  });
});
