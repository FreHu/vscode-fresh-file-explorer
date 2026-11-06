import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseGitLogL } from "../../git/gitLogLParser";

// The fixture is copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`
const fixture = fs.readFileSync(path.join(__dirname, "..", "fixtures", "gitLogL.txt"), "utf-8");
const commits = parseGitLogL(fixture);

suite("gitLogLParser", () => {
  suite("parseGitLogL - handleOpenDiffMatch fixture", () => {
    test("parses two commits", () => {
      assert.strictEqual(commits.length, 2);
    });

    suite("first commit (ccdbfbb - modification)", () => {
      const c = commits[0];

      test("hash", () => {
        assert.strictEqual(c.hash, "ccdbfbb86b0ece6bfa2ff18d6fac97c83cd1445f");
      });

      test("shortHash is first 8 chars of hash", () => {
        assert.strictEqual(c.shortHash, c.hash.slice(0, 8));
        assert.strictEqual(c.shortHash, "ccdbfbb8");
      });

      test("author", () => {
        assert.strictEqual(c.author, "FreHu <frederik.hudak@gmail.com>");
      });

      test("message", () => {
        assert.strictEqual(c.message, "1.1");
      });

      test("date year", () => {
        assert.strictEqual(c.date.getFullYear(), 2026);
      });

      test("filePathAtCommit", () => {
        assert.strictEqual(c.filePathAtCommit, "src/commands/diffSearchCommand.ts");
      });

      test("hunk starts with @@", () => {
        assert.ok(c.hunk.startsWith("@@"), `Expected hunk to start with @@, got: ${c.hunk.slice(0, 20)}`);
      });

      test("added line count", () => {
        assert.strictEqual(c.added, 42);
      });

      test("removed line count", () => {
        assert.strictEqual(c.removed, 22);
      });
    });

    suite("second commit (8a74405 - file creation)", () => {
      const c = commits[1];

      test("hash", () => {
        assert.strictEqual(c.hash, "8a74405ef3903c05af7d3634e729ca5eaa25a6a6");
      });

      test("shortHash is first 8 chars of hash", () => {
        assert.strictEqual(c.shortHash, c.hash.slice(0, 8));
        assert.strictEqual(c.shortHash, "8a74405e");
      });

      test("author", () => {
        assert.strictEqual(c.author, "FreHu <frederik.hudak@gmail.com>");
      });

      test("message", () => {
        assert.strictEqual(c.message, "Diff search");
      });

      test("date year", () => {
        assert.strictEqual(c.date.getFullYear(), 2026);
      });

      test("filePathAtCommit", () => {
        assert.strictEqual(c.filePathAtCommit, "src/commands/diffSearchCommand.ts");
      });

      test("hunk starts with @@", () => {
        assert.ok(c.hunk.startsWith("@@"), `Expected hunk to start with @@, got: ${c.hunk.slice(0, 20)}`);
      });

      test("added line count", () => {
        assert.strictEqual(c.added, 92);
      });

      test("no removals (file created from /dev/null)", () => {
        assert.strictEqual(c.removed, 0);
      });
    });
  });
});
