import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseGitLogNumstat, parseGitDiffNumstat } from "../../git/gitOperations";

// ---------------------------------------------------------------------------
// Fixtures: real git numstat output from this repository
// Copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`
// ---------------------------------------------------------------------------

const NUMSTAT_FIXTURE = fs.readFileSync(
  path.join(__dirname, "../fixtures/numstat.txt"),
  "utf-8",
);

const NUMSTAT_HEAD_FIXTURE = fs.readFileSync(
  path.join(__dirname, "../fixtures/numstat-head.txt"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(...strs: string[]): string {
  return strs.join("\n");
}

// ---------------------------------------------------------------------------
// parseGitLogNumstat — synthetic inputs
// ---------------------------------------------------------------------------

suite("parseGitLogNumstat", () => {
  suite("synthetic inputs", () => {
    test("empty input returns empty map", () => {
      assert.strictEqual(parseGitLogNumstat("", "").size, 0);
    });

    test("single commit, single file", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Initial commit",
        "10\t2\tsrc/foo.ts",
      );
      const map = parseGitLogNumstat(raw, "");
      assert.strictEqual(map.size, 1);
      const entry = map.get("src/foo.ts");
      assert.ok(entry, "file should be in map");
      assert.strictEqual(entry!.added, 10);
      assert.strictEqual(entry!.deleted, 2);
    });

    test("first commit wins (dedup)", () => {
      const raw = lines(
        "__COMMIT__aaa0001|Alice|2024-01-02T00:00:00+00:00|Newer",
        "5\t1\tsrc/foo.ts",
        "",
        "__COMMIT__bbb0002|Alice|2024-01-01T00:00:00+00:00|Older",
        "100\t50\tsrc/foo.ts",
      );
      const map = parseGitLogNumstat(raw, "");
      const entry = map.get("src/foo.ts");
      assert.ok(entry);
      assert.strictEqual(entry!.added, 5);
      assert.strictEqual(entry!.deleted, 1);
    });

    test("binary files (dash counts) are skipped", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Add image",
        "-\t-\tassets/logo.png",
      );
      const map = parseGitLogNumstat(raw, "");
      assert.strictEqual(map.size, 0);
    });

    test("__COMMIT__ header lines are not treated as file entries", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Some message",
        "3\t1\tsrc/a.ts",
      );
      const map = parseGitLogNumstat(raw, "");
      assert.strictEqual(map.size, 1);
      assert.ok(!map.has("__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Some message"));
    });

    test("repoRelativePath is prepended", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Commit",
        "4\t0\tsrc/bar.ts",
      );
      const map = parseGitLogNumstat(raw, "packages/core");
      assert.ok(!map.has("src/bar.ts"), "bare path should not exist");
      const entry = map.get("packages/core/src/bar.ts");
      assert.ok(entry, "prefixed path should exist");
      assert.strictEqual(entry!.added, 4);
    });

    test("multiple files across multiple commits", () => {
      const raw = lines(
        "__COMMIT__aaa0001|Alice|2024-01-03T00:00:00+00:00|Third",
        "2\t1\tsrc/c.ts",
        "",
        "__COMMIT__bbb0002|Alice|2024-01-02T00:00:00+00:00|Second",
        "10\t5\tsrc/b.ts",
        "",
        "__COMMIT__ccc0003|Alice|2024-01-01T00:00:00+00:00|First",
        "20\t0\tsrc/a.ts",
        "1\t1\tsrc/c.ts",  // c.ts appears again — should be ignored (first-wins)
      );
      const map = parseGitLogNumstat(raw, "");
      assert.strictEqual(map.size, 3);
      assert.strictEqual(map.get("src/a.ts")!.added, 20);
      assert.strictEqual(map.get("src/b.ts")!.added, 10);
      assert.strictEqual(map.get("src/c.ts")!.added, 2); // first entry wins
    });

    test("lines without tabs are ignored", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Commit",
        "this is not a valid numstat line",
        "5\t2\tsrc/valid.ts",
      );
      const map = parseGitLogNumstat(raw, "");
      assert.strictEqual(map.size, 1);
      assert.ok(map.has("src/valid.ts"));
    });
  });

  // ---------------------------------------------------------------------------
  // Fixture: numstat.txt — git log --numstat from this repository
  // ---------------------------------------------------------------------------

  suite("fixture (numstat.txt)", () => {
    test("does not throw", () => {
      assert.doesNotThrow(() => parseGitLogNumstat(NUMSTAT_FIXTURE, ""));
    });

    test("package.json from most recent commit → {added:8, deleted:3}", () => {
      const map = parseGitLogNumstat(NUMSTAT_FIXTURE, "");
      const entry = map.get("package.json");
      assert.ok(entry, "package.json not found");
      assert.strictEqual(entry!.added, 8);
      assert.strictEqual(entry!.deleted, 3);
    });

    test("CHANGELOG.md → {added:1, deleted:0} (first-wins: commit 9c3bf17)", () => {
      const map = parseGitLogNumstat(NUMSTAT_FIXTURE, "");
      const entry = map.get("CHANGELOG.md");
      assert.ok(entry, "CHANGELOG.md not found");
      assert.strictEqual(entry!.added, 1);
      assert.strictEqual(entry!.deleted, 0);
    });

    test("src/utils/logger.ts → {added:6, deleted:2}", () => {
      const map = parseGitLogNumstat(NUMSTAT_FIXTURE, "");
      const entry = map.get("src/utils/logger.ts");
      assert.ok(entry, "logger.ts not found");
      assert.strictEqual(entry!.added, 6);
      assert.strictEqual(entry!.deleted, 2);
    });

    test("contains at least 10 unique files", () => {
      const map = parseGitLogNumstat(NUMSTAT_FIXTURE, "");
      assert.ok(map.size >= 10, `expected ≥10 files but got ${map.size}`);
    });

    test("repoRelativePath prefix is applied to all keys", () => {
      const prefix = "sub/repo";
      const map = parseGitLogNumstat(NUMSTAT_FIXTURE, prefix);
      for (const key of map.keys()) {
        assert.ok(key.startsWith(prefix + "/"), `key "${key}" missing prefix`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// parseGitDiffNumstat — synthetic inputs
// ---------------------------------------------------------------------------

suite("parseGitDiffNumstat", () => {
  suite("synthetic inputs", () => {
    test("empty input returns empty map", () => {
      assert.strictEqual(parseGitDiffNumstat("").size, 0);
    });

    test("single entry", () => {
      const raw = "5\t3\tsrc/foo.ts\n";
      const map = parseGitDiffNumstat(raw);
      assert.strictEqual(map.size, 1);
      const entry = map.get("src/foo.ts");
      assert.ok(entry);
      assert.strictEqual(entry!.added, 5);
      assert.strictEqual(entry!.deleted, 3);
    });

    test("binary file is skipped", () => {
      const raw = "-\t-\tassets/image.png\n";
      const map = parseGitDiffNumstat(raw);
      assert.strictEqual(map.size, 0);
    });

    test("multiple files parsed correctly", () => {
      const raw = lines(
        "10\t0\tsrc/a.ts",
        "0\t5\tsrc/b.ts",
        "-\t-\timages/bg.png",
        "3\t3\tsrc/c.ts",
      );
      const map = parseGitDiffNumstat(raw);
      assert.strictEqual(map.size, 3);
      assert.strictEqual(map.get("src/a.ts")!.added, 10);
      assert.strictEqual(map.get("src/b.ts")!.deleted, 5);
      assert.strictEqual(map.get("src/c.ts")!.added, 3);
      assert.ok(!map.has("images/bg.png"), "binary should be excluded");
    });

    test("lines without 3 tab-separated parts are ignored", () => {
      const raw = lines("not a valid line", "5\t2\tsrc/valid.ts");
      const map = parseGitDiffNumstat(raw);
      assert.strictEqual(map.size, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Fixture: numstat-head.txt — git diff --numstat HEAD from this repository
  // ---------------------------------------------------------------------------

  suite("fixture (numstat-head.txt)", () => {
    test("does not throw", () => {
      assert.doesNotThrow(() => parseGitDiffNumstat(NUMSTAT_HEAD_FIXTURE));
    });

    test("package.json → {added:1, deleted:1}", () => {
      const map = parseGitDiffNumstat(NUMSTAT_HEAD_FIXTURE);
      const entry = map.get("package.json");
      assert.ok(entry, "package.json not found");
      assert.strictEqual(entry!.added, 1);
      assert.strictEqual(entry!.deleted, 1);
    });

    test("src/git/gitOperations.ts → {added:137, deleted:57}", () => {
      const map = parseGitDiffNumstat(NUMSTAT_HEAD_FIXTURE);
      const entry = map.get("src/git/gitOperations.ts");
      assert.ok(entry, "gitOperations.ts not found");
      assert.strictEqual(entry!.added, 137);
      assert.strictEqual(entry!.deleted, 57);
    });

    test("contains exactly 5 files", () => {
      const map = parseGitDiffNumstat(NUMSTAT_HEAD_FIXTURE);
      assert.strictEqual(map.size, 5);
    });
  });
});
