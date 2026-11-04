import * as assert from "assert";
import { baseBranchRef } from "../../git/baseBranchRef";

suite("baseBranchRef", () => {
  test("a remote base (what getBranchBase returns) includes its remote", () => {
    assert.strictEqual(baseBranchRef({ name: "main", remote: "origin" }), "origin/main");
  });

  test("a remote base already named with its remote isn't prefixed twice", () => {
    assert.strictEqual(baseBranchRef({ name: "origin/main", remote: "origin" }), "origin/main");
  });

  test("a local base compares against its upstream, else itself", () => {
    assert.strictEqual(baseBranchRef({ name: "main", upstream: { remote: "origin", name: "main" } }), "origin/main");
    assert.strictEqual(baseBranchRef({ name: "develop" }), "develop");
  });

  test("no name, no ref", () => {
    assert.strictEqual(baseBranchRef({ remote: "origin" }), undefined);
  });
});
