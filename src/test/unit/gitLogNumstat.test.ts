import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { createDiffNumstatLineProcessor } from "../../git/gitLogStream";

// ---------------------------------------------------------------------------
// Fixtures: real git numstat output from this repository
// Copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`
// ---------------------------------------------------------------------------

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
// parseGitDiffNumstat — synthetic inputs
// ---------------------------------------------------------------------------

function parseGitDiffNumstat(raw: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  const processLine = createDiffNumstatLineProcessor((fileName, added, deleted) => {
    if (!map.has(fileName)) map.set(fileName, { added, deleted });
  });
  for (const line of raw.split("\n")) processLine(line);
  return map;
}

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
