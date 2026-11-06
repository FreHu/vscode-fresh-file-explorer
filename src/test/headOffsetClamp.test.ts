import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { clampHeadOffsetRef, getMergeBase } from "../git/gitCommitQueries";
import { fetchCommittedDiff } from "../branch-compare/branchCompareData";
import { createTempRepo, TempGitRepo } from "./helpers/tempGitRepo";

const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** `HEAD~N` in a repo with N or fewer commits means "all of history". */
suite("HEAD~N past the root commit", () => {
  let repo: TempGitRepo;
  let tmpDir: string;

  suiteSetup(() => {
    repo = createTempRepo("ffe-headoffset-");
    tmpDir = repo.dir;
    const git = repo.git;
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(tmpDir, `f${n}.txt`), String(n));
      git("add", ".");
      git("commit", "-q", "-m", `c${n}`);
    }
  });

  suiteTeardown(() => repo.dispose());

  test("HEAD~N beyond the root clamps to the empty tree", async () => {
    assert.deepStrictEqual(await clampHeadOffsetRef(tmpDir, "HEAD~10"), { ref: EMPTY_TREE_SHA1, availableCommits: 3 });
    assert.deepStrictEqual(await clampHeadOffsetRef(tmpDir, "HEAD~3"), { ref: EMPTY_TREE_SHA1, availableCommits: 3 });
  });

  test("a HEAD~N that resolves, and other refs, are left alone", async () => {
    assert.deepStrictEqual(await clampHeadOffsetRef(tmpDir, "HEAD~2"), { ref: "HEAD~2" });
    assert.deepStrictEqual(await clampHeadOffsetRef(tmpDir, "no-such-branch"), { ref: "no-such-branch" });
  });

  test("merge-base and diff against a clamped ref cover every commit", async () => {
    const base = await getMergeBase(tmpDir, "HEAD", "HEAD~10");
    assert.strictEqual(base, EMPTY_TREE_SHA1);
    const files = (await fetchCommittedDiff(tmpDir, base, "HEAD")).map(f => `${f.status} ${f.pathInRepo}`);
    assert.deepStrictEqual(files.sort(), ["A f1.txt", "A f2.txt", "A f3.txt"]);
  });
});
