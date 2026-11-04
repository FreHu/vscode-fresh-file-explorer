import * as assert from "assert";
import * as path from "path";
import { nearestExistingPath } from "../../utils/nearestExistingPath";

suite("nearestExistingPath", () => {
  const root = path.resolve("/repo");
  const existing = new Set([root, path.join(root, "src"), path.join(root, "src", "a.ts")]);
  const exists = (p: string) => Promise.resolve(existing.has(p));

  test("an existing path is returned as is", async () => {
    assert.strictEqual(await nearestExistingPath(path.join(root, "src", "a.ts"), exists), path.join(root, "src", "a.ts"));
  });

  test("a deleted file resolves to its folder", async () => {
    assert.strictEqual(await nearestExistingPath(path.join(root, "src", "gone.ts"), exists), path.join(root, "src"));
  });

  test("a deleted file in a deleted folder resolves to the nearest folder that still exists", async () => {
    assert.strictEqual(await nearestExistingPath(path.join(root, "src", "legacy", "old", "gone.ts"), exists), path.join(root, "src"));
  });

  test("nothing existing up to the root gives undefined", async () => {
    assert.strictEqual(await nearestExistingPath(path.join(root, "x.ts"), () => Promise.resolve(false)), undefined);
  });
});
