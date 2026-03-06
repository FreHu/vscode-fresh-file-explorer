import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { createNameStatusLineProcessor } from "../../git/gitOperations";
import type { CommitData } from "../../types";

// ---------------------------------------------------------------------------
// Fixture: real git log --name-status output from this repository
// The fixture is copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`
// ---------------------------------------------------------------------------

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "../fixtures/gitLogNameStatus.txt"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(...strs: string[]): string {
  return strs.join("\n");
}

function parseGitLogNameStatus(raw: string, repoRelativePath: string): Map<string, { status: string; commit: CommitData }> {
  const map = new Map<string, { status: string; commit: CommitData }>();
  const processLine = createNameStatusLineProcessor(repoRelativePath, (relativePath, status, commit) => {
    if (!map.has(relativePath)) map.set(relativePath, { status, commit });
  });
  for (const line of raw.split("\n")) processLine(line);
  return map;
}

// ---------------------------------------------------------------------------
// Synthetic input tests
// ---------------------------------------------------------------------------

suite("parseGitLogNameStatus", () => {
  suite("synthetic inputs", () => {
    test("empty input returns empty map", () => {
      assert.strictEqual(parseGitLogNameStatus("", "").size, 0);
    });

    test("single commit, single modified file", () => {
      const raw = lines(
        "__COMMIT__abc1234|Alice|2024-01-01T00:00:00+00:00|Initial",
        "M\tsrc/foo.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.size, 1);
      const entry = map.get("src/foo.ts");
      assert.ok(entry, "file should be in map");
      assert.strictEqual(entry!.status, "M");
      assert.strictEqual(entry!.commit.hash, "abc1234");
      assert.strictEqual(entry!.commit.author, "Alice");
      assert.strictEqual(entry!.commit.message, "Initial");
      assert.ok(entry!.commit.date instanceof Date);
      assert.strictEqual(entry!.commit.date.getFullYear(), 2024);
    });

    test("only the most recent (first) commit is kept for each file", () => {
      const raw = lines(
        "__COMMIT__newer|Dev|2024-02-01T00:00:00+00:00|New",
        "M\tsrc/foo.ts",
        "__COMMIT__older|Dev|2024-01-01T00:00:00+00:00|Old",
        "M\tsrc/foo.ts",
        "A\tsrc/bar.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.get("src/foo.ts")!.commit.hash, "newer");
      assert.strictEqual(map.get("src/bar.ts")!.commit.hash, "older");
    });

    test("deleted file status is preserved", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Remove file",
        "D\tsrc/gone.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      const entry = map.get("src/gone.ts");
      assert.ok(entry, "deleted file should be in map");
      assert.strictEqual(entry!.status, "D");
    });

    test("rename: new path is stored, old path is not", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Rename",
        "R100\tsrc/old.ts\tsrc/new.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.ok(!map.has("src/old.ts"), "old path should not be in map");
      assert.ok(map.has("src/new.ts"), "new path should be in map");
      assert.strictEqual(map.get("src/new.ts")!.status, "R100");
    });

    test("copy: destination path is stored", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Copy",
        "C100\tsrc/orig.ts\tsrc/copy.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.ok(map.has("src/copy.ts"), "destination path should be in map");
      assert.strictEqual(map.get("src/copy.ts")!.status, "C100");
    });

    test("repoRelativePath is prepended to file paths", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Init",
        "A\tsrc/foo.ts",
      );
      const map = parseGitLogNameStatus(raw, "packages/lib");
      assert.ok(map.has("packages/lib/src/foo.ts"), "path should be prefixed");
      assert.ok(!map.has("src/foo.ts"), "unprefixed path should not exist");
    });

    test("commit message containing | is preserved intact", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Fix foo|bar issue",
        "M\tsrc/fix.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.get("src/fix.ts")!.commit.message, "Fix foo|bar issue");
    });

    test("file-less commits produce no entries", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Empty commit",
        "",
        "__COMMIT__def5678|Dev|2024-01-02T00:00:00+00:00|Another",
        "M\tsrc/real.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.size, 1);
      assert.ok(map.has("src/real.ts"));
    });

    test("multiple files in one commit all get the same commit info", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Bulk change",
        "M\tsrc/a.ts",
        "A\tsrc/b.ts",
        "D\tsrc/c.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.size, 3);
      for (const entry of map.values()) {
        assert.strictEqual(entry.commit.hash, "abc1234");
      }
    });

    test("lines without a tab are ignored", () => {
      const raw = lines(
        "__COMMIT__abc1234|Dev|2024-01-01T00:00:00+00:00|Msg",
        "no-tab-here",
        "M\tsrc/valid.ts",
      );
      const map = parseGitLogNameStatus(raw, "");
      assert.strictEqual(map.size, 1);
      assert.ok(map.has("src/valid.ts"));
    });
  });

  // -------------------------------------------------------------------------
  // Fixture-based tests: real repository output
  // -------------------------------------------------------------------------

  suite("fixture: real repo history", () => {
    test("parses without throwing", () => {
      assert.doesNotThrow(() => parseGitLogNameStatus(FIXTURE, ""));
    });

    test("result contains a reasonable number of unique files", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      assert.ok(map.size >= 30, `expected >= 30 files, got ${map.size}`);
    });

    test("package.json resolves to the most recent commit (1.1.3)", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      const entry = map.get("package.json");
      assert.ok(entry, "package.json should be in map");
      assert.strictEqual(entry!.commit.hash, "4298420");
      assert.strictEqual(entry!.commit.message, "1.1.3");
      assert.strictEqual(entry!.status, "M");
    });

    test(".mocharc.json is present with deleted status", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      const entry = map.get(".mocharc.json");
      assert.ok(entry, ".mocharc.json should be in map");
      assert.strictEqual(entry!.status, "D");
    });

    test("src/utils/logger.ts resolves to the Logger commit", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      const entry = map.get("src/utils/logger.ts");
      assert.ok(entry, "logger.ts should be in map");
      assert.strictEqual(entry!.commit.hash, "e09af0b");
      assert.ok(
        entry!.commit.message.includes("Logger"),
        `unexpected message: ${entry!.commit.message}`,
      );
    });

    test("UTF-8 author name is preserved correctly", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      const entry = map.get("agents.md");
      assert.ok(entry, "agents.md should be in map");
      assert.strictEqual(
        entry!.commit.author,
        "Frederik Hudák",
        `author was: ${entry!.commit.author}`,
      );
    });

    test("commit dates are valid Date objects", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      for (const [filePath, entry] of map) {
        assert.ok(
          entry.commit.date instanceof Date && !isNaN(entry.commit.date.getTime()),
          `invalid date for ${filePath}`,
        );
      }
    });

    test("all entries have non-empty hash, author, message, and status", () => {
      const map = parseGitLogNameStatus(FIXTURE, "");
      for (const [filePath, entry] of map) {
        assert.ok(entry.commit.hash.length > 0, `empty hash for ${filePath}`);
        assert.ok(entry.commit.author.length > 0, `empty author for ${filePath}`);
        assert.ok(entry.commit.message.length > 0, `empty message for ${filePath}`);
        assert.ok(entry.status.length > 0, `empty status for ${filePath}`);
      }
    });
  });
});
