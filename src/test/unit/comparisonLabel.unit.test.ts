import * as assert from "assert";
import { defaultComparisonLabel, emptyComparisonMessage } from "../../branch-compare/comparisonLabel";
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

  suite("emptyComparisonMessage", () => {
    test("same commit: no swap hint, since swapping shows nothing either", () => {
      const m = emptyComparisonMessage("HEAD", "main", 0);
      assert.strictEqual(m.label, "No commits beyond main yet");
      assert.ok(!m.tooltip?.includes("Swap"));
    });

    test("target ahead: says by how much, and only then suggests swapping", () => {
      assert.deepStrictEqual(emptyComparisonMessage("HEAD", "main", 3), {
        label: "Nothing new vs main · main is 3 commits ahead",
        tooltip: "Swap source and target to see what main adds.",
      });
      assert.strictEqual(emptyComparisonMessage("HEAD", "main", 1).label, "Nothing new vs main · main is 1 commit ahead");
    });

    test("unknown count: plain message, no claim either way", () => {
      assert.deepStrictEqual(emptyComparisonMessage("HEAD", "main", undefined), { label: "Nothing new vs main" });
    });
  });
});
