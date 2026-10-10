import * as assert from "assert";

import {
  computeDesiredFollows,
  pickNearestBase,
  reconcileFollows,
  followKey,
  RepoHeadState,
  DesiredFollow,
} from "../../branch-compare/autoFollow";
import { SavedComparison, HEAD_SOURCE } from "../../branch-compare/savedComparisonsService";
import { asNormalizedRepoPath, NormalizedRepoPath } from "../../pathTypes";
import { DEFAULT_GROUPING_MODE } from "../../fresh-files/groupingMode";
import { DEFAULT_DIFF_MODE } from "../../branch-compare/branchCompareConstants";

const repo = (p: string) => asNormalizedRepoPath(p);

function state(p: string, head: string | undefined, base: string | undefined): RepoHeadState {
  return { repoFullPath: repo(p), headBranch: head, baseBranch: base };
}

function autoCmp(p: string, target: string, id: string, label = "x"): SavedComparison {
  return {
    id,
    repoFullPath: repo(p) as unknown as NormalizedRepoPath,
    source: HEAD_SOURCE,
    target,
    label,
    active: true,
    groupingMode: DEFAULT_GROUPING_MODE,
    diffMode: DEFAULT_DIFF_MODE,
    auto: true,
  };
}

const NONE: ReadonlySet<string> = new Set();

suite("autoFollow.computeDesiredFollows", () => {
  test("follows a diverged branch", () => {
    const got = computeDesiredFollows([state("/wt/agent1", "agent/foo", "main")], NONE);
    assert.deepStrictEqual(got, [
      { repoFullPath: repo("/wt/agent1"), target: "main", headBranch: "agent/foo" } as DesiredFollow,
    ]);
  });

  test("skips repo sitting on its base branch", () => {
    assert.deepStrictEqual(computeDesiredFollows([state("/r", "main", "main")], NONE), []);
  });

  test("skips when HEAD equals base in remote form (origin/main)", () => {
    assert.deepStrictEqual(computeDesiredFollows([state("/r", "main", "origin/main")], NONE), []);
  });

  test("skips detached HEAD (no branch) and missing base", () => {
    assert.deepStrictEqual(computeDesiredFollows([state("/r", undefined, "main")], NONE), []);
    assert.deepStrictEqual(computeDesiredFollows([state("/r", "agent/x", undefined)], NONE), []);
  });

  test("respects the dismissed set", () => {
    const dismissed = new Set([followKey("/wt/agent1", "agent/foo")]);
    assert.deepStrictEqual(computeDesiredFollows([state("/wt/agent1", "agent/foo", "main")], dismissed), []);
    // A different branch in the same repo is NOT dismissed.
    const got = computeDesiredFollows([state("/wt/agent1", "agent/bar", "main")], dismissed);
    assert.strictEqual(got.length, 1);
  });

  test("targets the remote base ref verbatim", () => {
    const got = computeDesiredFollows([state("/r", "feature/x", "origin/main")], NONE);
    assert.strictEqual(got[0].target, "origin/main");
  });
});

suite("autoFollow.pickNearestBase", () => {
  const d = (ref: string, ahead: number, behind: number) => ({ ref, ahead, behind });

  test("stacked on a branch with its own commits → that branch", () => {
    // main ← parent (2 commits) ← HEAD (1 commit)
    const got = pickNearestBase([d("main", 0, 3), d("parent", 0, 1), d("child", 0, 0)], "child", "main");
    assert.strictEqual(got, "parent");
  });

  test("fresh branch off a branch with commits (HEAD == parent tip) → that branch", () => {
    assert.strictEqual(pickNearestBase([d("main", 0, 2), d("parent", 0, 0), d("child", 0, 0)], "child", "main"), "parent");
  });

  test("parent moved on after branching → still found via merge-base distance", () => {
    assert.strictEqual(pickNearestBase([d("main", 0, 3), d("parent", 2, 1)], "child", "main"), "parent");
  });

  test("tie between non-default branches → default", () => {
    assert.strictEqual(pickNearestBase([d("main", 0, 3), d("a", 0, 0), d("b", 0, 0)], "child", "main"), "main");
  });

  test("default among the nearest → default", () => {
    assert.strictEqual(pickNearestBase([d("main", 0, 0), d("test3333", 0, 0)], "test3334", "main"), "main");
  });

  test("ignores branches stacked on top of HEAD", () => {
    assert.strictEqual(pickNearestBase([d("main", 0, 2), d("grandchild", 3, 0)], "child", "main"), "main");
  });

  test("remote default: local twin at the same commit counts as default", () => {
    assert.strictEqual(pickNearestBase([d("origin/main", 0, 2), d("main", 0, 2)], "x", "origin/main"), "origin/main");
    assert.strictEqual(pickNearestBase([d("main", 0, 2)], "x", "origin/main"), "origin/main");
  });

  test("no candidates → default", () => {
    assert.strictEqual(pickNearestBase([d("x", 0, 0)], "x", "main"), "main");
  });
});

suite("autoFollow.reconcileFollows", () => {
  test("adds brand-new follows, keeps nothing", () => {
    const desired: DesiredFollow[] = [{ repoFullPath: repo("/a"), target: "main", headBranch: "x" }];
    const { toAdd, toRemoveIds, kept } = reconcileFollows(desired, []);
    assert.strictEqual(toAdd.length, 1);
    assert.strictEqual(kept.length, 0);
    assert.strictEqual(toRemoveIds.length, 0);
  });

  test("keeps an unchanged follow (id preserved, no churn)", () => {
    const existing = [autoCmp("/a", "main", "cmp-1")];
    const desired: DesiredFollow[] = [{ repoFullPath: repo("/a"), target: "main", headBranch: "x" }];
    const { toAdd, toRemoveIds, kept } = reconcileFollows(desired, existing);
    assert.strictEqual(toAdd.length, 0);
    assert.strictEqual(toRemoveIds.length, 0);
    assert.deepStrictEqual(kept.map(k => k.id), ["cmp-1"]);
  });

  test("removes a follow whose repo is no longer desired", () => {
    const existing = [autoCmp("/a", "main", "cmp-1")];
    const { toAdd, toRemoveIds, kept } = reconcileFollows([], existing);
    assert.deepStrictEqual(toRemoveIds, ["cmp-1"]);
    assert.strictEqual(toAdd.length, 0);
    assert.strictEqual(kept.length, 0);
  });

  test("base change is a remove + add", () => {
    const existing = [autoCmp("/a", "main", "cmp-1")];
    const desired: DesiredFollow[] = [{ repoFullPath: repo("/a"), target: "develop", headBranch: "x" }];
    const { toAdd, toRemoveIds, kept } = reconcileFollows(desired, existing);
    assert.deepStrictEqual(toRemoveIds, ["cmp-1"]);
    assert.strictEqual(toAdd.length, 1);
    assert.strictEqual(toAdd[0].target, "develop");
    assert.strictEqual(kept.length, 0);
  });

  test("HEAD branch change with same base is a remove + add", () => {
    const existing = [autoCmp("/a", "main", "cmp-1", "test3333")];
    const desired: DesiredFollow[] = [{ repoFullPath: repo("/a"), target: "main", headBranch: "test3334" }];
    const { toAdd, toRemoveIds, kept } = reconcileFollows(desired, existing);
    assert.deepStrictEqual(toRemoveIds, ["cmp-1"]);
    assert.deepStrictEqual(toAdd.map(a => a.headBranch), ["test3334"]);
    assert.strictEqual(kept.length, 0);
  });

  test("mixed: keep one, add one, remove one", () => {
    const existing = [autoCmp("/a", "main", "keep"), autoCmp("/gone", "main", "drop")];
    const desired: DesiredFollow[] = [
      { repoFullPath: repo("/a"), target: "main", headBranch: "x" },
      { repoFullPath: repo("/b"), target: "main", headBranch: "y" },
    ];
    const { toAdd, toRemoveIds, kept } = reconcileFollows(desired, existing);
    assert.deepStrictEqual(kept.map(k => k.id), ["keep"]);
    assert.deepStrictEqual(toRemoveIds, ["drop"]);
    assert.deepStrictEqual(toAdd.map(a => a.repoFullPath), [repo("/b")]);
  });
});
