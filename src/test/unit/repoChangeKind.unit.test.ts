import * as assert from "assert";
import { suite, test } from "mocha";
import { branchFromHeadFile, classifyRepoChange, WatchedRepoDirs } from "../../git/repoChangeKind";

const worktree: WatchedRepoDirs = {
  root: "/agents/shop-coupons",
  gitDir: "/agents/shop/.git/worktrees/shop-coupons",
  commonDir: "/agents/shop/.git",
  branch: "feature/coupons",
};
const main: WatchedRepoDirs = {
  root: "/agents/shop",
  gitDir: "/agents/shop/.git",
  commonDir: "/agents/shop/.git",
  branch: "main",
};
const classify = (path: string, repo = worktree) => classifyRepoChange(path, repo, false);

suite("classifyRepoChange — linked worktree", () => {
  test("its HEAD, its branch ref and packed-refs move HEAD", () => {
    assert.strictEqual(classify("/agents/shop/.git/worktrees/shop-coupons/HEAD"), "head");
    assert.strictEqual(classify("/agents/shop/.git/refs/heads/feature/coupons"), "head");
    assert.strictEqual(classify("/agents/shop/.git/packed-refs"), "head");
  });

  test("its index and working-tree files are pending changes", () => {
    assert.strictEqual(classify("/agents/shop/.git/worktrees/shop-coupons/index"), "pending");
    assert.strictEqual(classify("/agents/shop-coupons/src/cart/cart.ts"), "pending");
  });

  test("another branch's ref, another worktree's git dir and logs are ignored", () => {
    assert.strictEqual(classify("/agents/shop/.git/refs/heads/main"), "ignore");
    assert.strictEqual(classify("/agents/shop/.git/worktrees/shop-search/HEAD"), "ignore");
    assert.strictEqual(classify("/agents/shop/.git/worktrees/shop-coupons/logs/HEAD"), "ignore");
    assert.strictEqual(classify("/agents/shop/.git/index"), "ignore");
  });

  test("its .git file and paths outside it are ignored", () => {
    assert.strictEqual(classify("/agents/shop-coupons/.git"), "ignore");
    assert.strictEqual(classify("/agents/shop-coupons-old/a.ts"), "ignore");
  });

  test("a detached HEAD has no branch ref to follow", () => {
    assert.strictEqual(classify("/agents/shop/.git/refs/heads/feature/coupons", { ...worktree, branch: undefined }), "ignore");
  });
});

suite("classifyRepoChange — main checkout", () => {
  test("HEAD, branch ref, index", () => {
    assert.strictEqual(classify("/agents/shop/.git/HEAD", main), "head");
    assert.strictEqual(classify("/agents/shop/.git/refs/heads/main", main), "head");
    assert.strictEqual(classify("/agents/shop/.git/index", main), "pending");
  });

  test("the rest of .git is ignored, including worktrees under it", () => {
    assert.strictEqual(classify("/agents/shop/.git/logs/HEAD", main), "ignore");
    assert.strictEqual(classify("/agents/shop/.git/worktrees/shop-coupons/index", main), "ignore");
    assert.strictEqual(classify("/agents/shop/.git/refs/heads/feature/coupons", main), "ignore");
  });

  test("working-tree files are pending", () => {
    assert.strictEqual(classify("/agents/shop/src/search.ts", main), "pending");
  });

  test("case-insensitive file systems match regardless of case", () => {
    assert.strictEqual(classifyRepoChange("D:/Agents/Shop/.git/HEAD", { ...main, root: "d:/agents/shop", gitDir: "d:/agents/shop/.git", commonDir: "d:/agents/shop/.git" }, true), "head");
  });
});

suite("branchFromHeadFile", () => {
  test("a symbolic ref names the branch, slashes included", () => {
    assert.strictEqual(branchFromHeadFile("ref: refs/heads/feature/coupons\n"), "feature/coupons");
  });

  test("a detached HEAD has no branch", () => {
    assert.strictEqual(branchFromHeadFile("3f2a9c1e0b7d4a6f8e2c5b1a9d0e3f7c6b4a2d18\n"), undefined);
  });
});
