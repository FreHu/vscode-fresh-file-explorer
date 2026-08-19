import * as assert from "assert";

import {
  computeDesiredFollows,
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

function autoCmp(p: string, target: string, id: string): SavedComparison {
  return {
    id,
    repoFullPath: repo(p) as unknown as NormalizedRepoPath,
    source: HEAD_SOURCE,
    target,
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
