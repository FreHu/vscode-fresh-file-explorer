import * as assert from "assert";
import { asAbsolutePath, normalizePath } from "../../pathTypes";

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
