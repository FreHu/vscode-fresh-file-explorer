import * as assert from "assert";
import { suite, test } from "mocha";
import { repoKindIcon, repoKindLabel, repoKindOf } from "../../git/repoKind";

suite("repoKind", () => {
  test("plain repo by default", () => {
    assert.strictEqual(repoKindOf({}), "repo");
    assert.strictEqual(repoKindOf({ isWorktree: false, isSubmodule: false }), "repo");
  });

  test("worktree and submodule flags map to their kinds", () => {
    assert.strictEqual(repoKindOf({ isWorktree: true }), "worktree");
    assert.strictEqual(repoKindOf({ isSubmodule: true }), "submodule");
  });

  test("submodule wins if both flags are set", () => {
    assert.strictEqual(repoKindOf({ isWorktree: true, isSubmodule: true }), "submodule");
  });

  test("icons mirror the Source Control view", () => {
    assert.strictEqual(repoKindIcon("repo"), "repo");
    assert.strictEqual(repoKindIcon("worktree"), "worktree");
    assert.strictEqual(repoKindIcon("submodule"), "archive");
  });

  test("only non-plain kinds get a tooltip label", () => {
    assert.strictEqual(repoKindLabel("repo"), undefined);
    assert.strictEqual(repoKindLabel("worktree"), "Linked worktree");
    assert.strictEqual(repoKindLabel("submodule"), "Submodule");
  });
});
