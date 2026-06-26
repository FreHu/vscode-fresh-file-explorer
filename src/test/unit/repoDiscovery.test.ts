import * as assert from "assert";
import { suite, test } from "mocha";
import { classifyDiscoveryEntry, type DiscoveryAction } from "../../git/gitOperations";

const classify = (over: Partial<Parameters<typeof classifyDiscoveryEntry>[0]>): DiscoveryAction =>
  classifyDiscoveryEntry({
    isDirectory: true,
    name: "some-dir",
    hasGitEntry: false,
    gitRecognizesRepo: false,
    ...over,
  });

suite("repo discovery — classifyDiscoveryEntry", () => {
  test("files are skipped", () => {
    assert.strictEqual(classify({ isDirectory: false }), "skip");
  });

  test("dotdirs are skipped (don't recurse into .git, .vscode, etc.)", () => {
    assert.strictEqual(classify({ name: ".git" }), "skip");
    assert.strictEqual(classify({ name: ".vscode" }), "skip");
  });

  test("node_modules is skipped — never a repo, enormous subtree", () => {
    assert.strictEqual(classify({ name: "node_modules" }), "skip");
  });

  test("a valid repo root is added, not recursed", () => {
    assert.strictEqual(classify({ hasGitEntry: true, gitRecognizesRepo: true }), "add");
  });

  test("ordinary directory with no .git is recursed into", () => {
    assert.strictEqual(classify({ hasGitEntry: false }), "recurse");
  });

  test("a .git entry git refuses to recognize is skipped, NOT recursed (moved worktree)", () => {
    // The regression: a worktree whose gitdir pointer went stale after the working tree was moved.
    // It must not fall through to recursing its whole subtree.
    assert.strictEqual(classify({ hasGitEntry: true, gitRecognizesRepo: false }), "skip-broken");
  });

  test("gitRecognizesRepo is ignored when there is no .git entry", () => {
    // Caller passes false to avoid spawning git; the recurse decision must not depend on it.
    assert.strictEqual(classify({ hasGitEntry: false, gitRecognizesRepo: true }), "recurse");
  });
});
