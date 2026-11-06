import * as assert from "assert";
import { toDiffStatus } from "../../git/diffStatus";

suite("toDiffStatus", () => {
  test("known letters, with or without a similarity score", () => {
    assert.deepStrictEqual(["A", "D", "M", "T", "R100", "C075"].map(toDiffStatus), ["A", "D", "M", "T", "R", "C"]);
  });

  test("letters outside DiffStatus open as a modification instead of being dropped", () => {
    assert.deepStrictEqual(["U", "X", "B"].map(toDiffStatus), ["M", "M", "M"]);
  });
});
