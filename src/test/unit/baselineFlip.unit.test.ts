import * as assert from "assert";
import { flippedBaseRef } from "../../heatmap/baselineFlip";

suite("flippedBaseRef", () => {
  const base = { from: "feature", to: "main", mode: "branch", baseRef: "main" };

  test("switching to the baseline branch flips the baseline to the branch you left", () => {
    assert.strictEqual(flippedBaseRef(base), "feature");
  });

  test("no flip outside Baseline mode or without a baseline", () => {
    assert.strictEqual(flippedBaseRef({ ...base, mode: "absolute" }), undefined);
    assert.strictEqual(flippedBaseRef({ ...base, mode: undefined }), undefined);
    assert.strictEqual(flippedBaseRef({ ...base, baseRef: undefined }), undefined);
  });

  test("no flip when switching to any other branch", () => {
    assert.strictEqual(flippedBaseRef({ ...base, to: "release" }), undefined);
  });

  test("no flip on unknown or unchanged branches (first sighting, detached HEAD, same branch)", () => {
    assert.strictEqual(flippedBaseRef({ ...base, from: undefined }), undefined);
    assert.strictEqual(flippedBaseRef({ ...base, to: undefined }), undefined);
    assert.strictEqual(flippedBaseRef({ ...base, from: "main", to: "main" }), undefined);
  });
});
