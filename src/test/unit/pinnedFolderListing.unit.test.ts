import * as assert from "assert";
import { listPinnedFolder } from "../../fresh-files/pinnedFolderListing";

suite("listPinnedFolder", () => {
  test("folders first, then files, each by name, with absolute paths", () => {
    const rows = listPinnedFolder("/ws/docs", [["b.md", false], ["img", true], ["a.md", false], ["api", true]], () => false);
    assert.deepStrictEqual(rows.map(r => r.name), ["api", "img", "a.md", "b.md"]);
    assert.strictEqual(rows[0].path, "/ws/docs/api");
    assert.strictEqual(rows[0].isDirectory, true);
  });

  test("excluded entries are left out", () => {
    const rows = listPinnedFolder("/ws", [["node_modules", true], ["src", true], [".DS_Store", false]],
      p => p.endsWith("/node_modules") || p.endsWith("/.DS_Store"));
    assert.deepStrictEqual(rows.map(r => r.name), ["src"]);
  });

  test("a trailing slash on the folder doesn't double up", () => {
    assert.strictEqual(listPinnedFolder("D:/", [["x.txt", false]], () => false)[0].path, "D:/x.txt");
  });
});
