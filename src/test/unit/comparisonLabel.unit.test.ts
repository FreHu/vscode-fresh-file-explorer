import * as assert from "assert";
import { defaultComparisonLabel } from "../../branch-compare/comparisonLabel";
import { parseHeadOffset } from "../../git/refSyntax";

suite("comparisonLabel", () => {
  test("parseHeadOffset reads HEAD~N and bare HEAD~", () => {
    assert.strictEqual(parseHeadOffset("HEAD~10"), 10);
    assert.strictEqual(parseHeadOffset("HEAD~"), 1);
    assert.strictEqual(parseHeadOffset(" HEAD~3 "), 3);
  });

  test("parseHeadOffset ignores other refs", () => {
    for (const ref of ["HEAD", "main", "HEAD^", "HEAD~2^", "origin/HEAD~2", "head~2", ""]) {
      assert.strictEqual(parseHeadOffset(ref), undefined, ref);
    }
  });

  test("HEAD vs HEAD~N is named after the commit count", () => {
    assert.strictEqual(defaultComparisonLabel("repo", "HEAD", "HEAD~10"), "repo · last 10 commits");
    assert.strictEqual(defaultComparisonLabel("repo", "HEAD", "HEAD~1"), "repo · last 1 commit");
  });

  test("other comparisons keep the source..target name", () => {
    assert.strictEqual(defaultComparisonLabel("repo", "HEAD", "main"), "repo · HEAD..main");
    assert.strictEqual(defaultComparisonLabel("repo", "feature", "HEAD~2"), "repo · feature..HEAD~2");
    assert.strictEqual(defaultComparisonLabel("repo", "HEAD", ""), "repo · HEAD..?");
  });
});
