import * as assert from "assert";
import { suite, test } from "mocha";
import { isIgnoredRepository } from "../../git/ignoredRepositories";

const check = (repoRoot: string, ignored: string[], caseInsensitive = false) =>
  isIgnoredRepository({ repoRoot, ignored, workspaceFolders: ["/work/shop"], caseInsensitive });

suite("git.ignoredRepositories", () => {
  test("an absolute entry matches that root", () => {
    assert.strictEqual(check("/work/shop/legacy", ["/work/shop/legacy"]), true);
  });

  test("a relative entry resolves against a workspace folder", () => {
    assert.strictEqual(check("/work/shop/legacy", ["legacy"]), true);
    assert.strictEqual(check("/work/shop/vendor/legacy", ["vendor/legacy"]), true);
  });

  test("the folder itself, via '.'", () => {
    assert.strictEqual(check("/work/shop", ["."]), true);
  });

  test("an entry names the root only, not repos below it", () => {
    assert.strictEqual(check("/work/shop/legacy/tools", ["legacy"]), false);
  });

  test("a trailing separator and backslashes don't matter", () => {
    assert.strictEqual(check("/work/shop/legacy", ["/work/shop/legacy/"]), true);
    assert.strictEqual(isIgnoredRepository({
      repoRoot: "D:/work/shop/legacy", ignored: ["D:\\work\\shop\\legacy\\"], workspaceFolders: [], caseInsensitive: true,
    }), true);
  });

  test("case matters only on case-sensitive file systems", () => {
    assert.strictEqual(check("/work/shop/Legacy", ["legacy"]), false);
    assert.strictEqual(check("/work/shop/Legacy", ["legacy"], true), true);
  });

  test("no entries, nothing ignored", () => {
    assert.strictEqual(check("/work/shop/legacy", []), false);
  });
});
