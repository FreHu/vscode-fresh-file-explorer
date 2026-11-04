import * as assert from "assert";
import { plural } from "../../utils/plural";

suite("plural", () => {
  test("singular only for exactly one", () => {
    assert.strictEqual(plural(1, "file"), "1 file");
    assert.strictEqual(plural(0, "file"), "0 files");
    assert.strictEqual(plural(2, "file"), "2 files");
  });

  test("irregular plural form", () => {
    assert.strictEqual(plural(1, "match", "matches"), "1 match");
    assert.strictEqual(plural(3, "match", "matches"), "3 matches");
  });
});
