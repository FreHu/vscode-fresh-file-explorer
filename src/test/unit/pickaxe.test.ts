import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseDiffOutput, filterMatchesByPattern } from "../../diff-search/diffSearchParser";

const fixture = fs.readFileSync(path.join(__dirname, "..", "fixtures", "pickaxe.txt"), "utf-8");
const CWD = "/repo";

suite("parseDiffOutput - pickaxe fixture (git log -p -S delete)", () => {
  const all = parseDiffOutput(fixture, CWD, true);
  const matches = filterMatchesByPattern(all, "delete", null, false);

  test("1 commit parsed", () => {
    const commits = new Set(matches.map(m => m.commitHash));
    assert.strictEqual(commits.size, 1);
    assert.ok([...commits][0]?.startsWith("ccdbfbb"));
  });

  test("12 total matches", () => {
    assert.strictEqual(matches.length, 12);
  });

  test("9 additions, 3 removals", () => {
    assert.strictEqual(matches.filter(m => m.changeType === "added").length, 9);
    assert.strictEqual(matches.filter(m => m.changeType === "removed").length, 3);
  });

  test("6 distinct files", () => {
    const files = new Set(matches.map(m => m.filePath));
    assert.strictEqual(files.size, 6);
  });

  test("commit message is '1.1'", () => {
    assert.ok(matches.every(m => m.commitMessage === "1.1"));
  });

  test("commit date is 2026", () => {
    assert.ok(matches.every(m => m.commitDate?.getFullYear() === 2026));
  });
});
