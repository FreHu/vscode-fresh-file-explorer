import * as assert from "assert";
import { suite, test } from "mocha";
import { diffWorktrees, worktreePathFromGitdirFile } from "../../git/worktreeDiff";

suite("worktree watcher — gitdir file", () => {
  test("strips the trailing /.git", () => {
    assert.strictEqual(worktreePathFromGitdirFile("D:/agents/shop-hotfix/.git\n"), "D:/agents/shop-hotfix");
  });

  test("a .git-prefixed folder name is not cut short", () => {
    assert.strictEqual(worktreePathFromGitdirFile("C:/src/.github-tools/wt/.git\n"), "C:/src/.github-tools/wt");
  });

  test("tolerates CRLF and backslashes", () => {
    assert.strictEqual(worktreePathFromGitdirFile("D:\\agents\\wt\\.git\r\n"), "D:/agents/wt");
  });

  test("anything else is not a worktree path", () => {
    assert.strictEqual(worktreePathFromGitdirFile(""), undefined);
    assert.strictEqual(worktreePathFromGitdirFile("D:/agents/wt"), undefined);
  });
});

suite("worktree watcher — diffWorktrees", () => {
  const base = { workspaceRoots: ["d:/agents"], caseInsensitive: false };

  test("a new worktree inside the workspace is added", () => {
    const diff = diffWorktrees({ ...base, listed: ["d:/agents/a", "d:/agents/b"], known: ["d:/agents/a"] });
    assert.deepStrictEqual(diff, { added: ["d:/agents/b"], removed: [] });
  });

  test("a new worktree outside the workspace is ignored", () => {
    const diff = diffWorktrees({ ...base, listed: ["d:/elsewhere/b"], known: [] });
    assert.deepStrictEqual(diff, { added: [], removed: [] });
  });

  test("a sibling folder sharing the root's prefix is outside", () => {
    const diff = diffWorktrees({ ...base, listed: ["d:/agents-old/b"], known: [] });
    assert.deepStrictEqual(diff.added, []);
  });

  test("a known worktree no longer listed is removed", () => {
    const diff = diffWorktrees({ ...base, listed: [], known: ["d:/agents/a"] });
    assert.deepStrictEqual(diff, { added: [], removed: ["d:/agents/a"] });
  });

  test("drive-letter case differs between git and VS Code on Windows", () => {
    const diff = diffWorktrees({ workspaceRoots: ["d:/agents"], caseInsensitive: true, listed: ["D:/agents/a"], known: ["d:/agents/a"] });
    assert.deepStrictEqual(diff, { added: [], removed: [] });
  });

  test("case matters on case-sensitive file systems", () => {
    const diff = diffWorktrees({ ...base, listed: ["d:/agents/A"], known: ["d:/agents/a"] });
    assert.deepStrictEqual(diff, { added: ["d:/agents/A"], removed: ["d:/agents/a"] });
  });
});
