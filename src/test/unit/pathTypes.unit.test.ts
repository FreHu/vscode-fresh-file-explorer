import * as assert from "assert";
import { asAbsolutePath, normalizePath, parentDir } from "../../pathTypes";

suite("parentDir", () => {
  test("drops the last segment", () => {
    assert.strictEqual(parentDir("C:/repo/src/a.ts"), "C:/repo/src");
    assert.strictEqual(parentDir("src/a.ts"), "src");
  });

  test("undefined with no slash or only a leading one", () => {
    assert.strictEqual(parentDir("a.ts"), undefined);
    assert.strictEqual(parentDir("/home"), undefined);
  });

  test("walking up ends below the root", () => {
    const seen: string[] = [];
    for (let d = parentDir("/home/u/repo/a.ts"); d !== undefined; d = parentDir(d)) { seen.push(d); }
    assert.deepStrictEqual(seen, ["/home/u/repo", "/home/u", "/home"]);
  });
});

suite("normalizePath", () => {
  test("turns every backslash into a forward slash", () => {
    assert.strictEqual(normalizePath("C:\\repo\\src\\a.ts"), "C:/repo/src/a.ts");
    assert.strictEqual(normalizePath("\\\\server\\share"), "//server/share");
  });

  test("leaves forward-slash paths alone", () => {
    assert.strictEqual(normalizePath("/home/u/repo"), "/home/u/repo");
  });

  test("asAbsolutePath normalizes the same way", () => {
    assert.strictEqual(asAbsolutePath("D:\\x\\y"), "D:/x/y");
  });
});
