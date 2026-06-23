import * as assert from "assert";
import { filterMatchesByPattern, buildPathspecs, matchFileLines } from "../../diff-search/diffSearchParser";
import { DiffMatch } from "../../diff-search/diffSearchParser";
import { selectMatchesByChangeType } from "../../diff-search/diffSearchResultProvider";
import { DiffSearchFileItem, DiffSearchCommitItem, DiffSearchRepoItem } from "../../diff-search/diffSearchTreeItems";
import { asAbsolutePath } from "../../pathTypes";
import { asCommitHash } from "../../types";

function makeMatch(lineContent: string): DiffMatch {
  return {
    filePath: asAbsolutePath("/repo/file.ts"),
    lineNumber: 1,
    lineContent,
    changeType: "added",
  };
}

function makeTyped(changeType: "added" | "removed"): DiffMatch {
  return { filePath: asAbsolutePath("/repo/file.ts"), lineNumber: 1, lineContent: "x", changeType };
}

suite("gitDiffSearch", () => {
  suite("filterMatchesByPattern", () => {
    const matches = [
      makeMatch("const foo = 1;"),
      makeMatch("const Bar = 2;"),
      makeMatch("let baz = foo + Bar;"),
    ];

    test("plain text match - case-sensitive", () => {
      const result = filterMatchesByPattern(matches, "foo", null, false);
      assert.strictEqual(result.length, 2);
      assert.ok(result.every(m => m.lineContent.includes("foo")));
    });

    test("plain text match - case-insensitive", () => {
      const result = filterMatchesByPattern(matches, "bar", null, true);
      assert.strictEqual(result.length, 2);
    });

    test("plain text match - case-sensitive excludes different case", () => {
      const result = filterMatchesByPattern(matches, "bar", null, false);
      assert.strictEqual(result.length, 0);
    });

    test("regex match", () => {
      const regex = /const \w+ = \d+/;
      const result = filterMatchesByPattern(matches, "const \\w+ = \\d+", regex, false);
      assert.strictEqual(result.length, 2);
    });

    test("regex match - case-insensitive flag on regex", () => {
      const regex = /bar/i;
      const result = filterMatchesByPattern(matches, "bar", regex, true);
      assert.strictEqual(result.length, 2);
    });

    test("no matches returns empty array", () => {
      const result = filterMatchesByPattern(matches, "notfound", null, false);
      assert.deepStrictEqual(result, []);
    });

    test("empty matches array returns empty array", () => {
      const result = filterMatchesByPattern([], "foo", null, false);
      assert.deepStrictEqual(result, []);
    });

    test("pattern matching all lines", () => {
      const result = filterMatchesByPattern(matches, "=", null, false);
      assert.strictEqual(result.length, 3);
    });
  });

  suite("buildPathspecs", () => {
    test("both empty returns empty array", () => {
      assert.deepStrictEqual(buildPathspecs("", ""), []);
    });

    test("include only - single pattern", () => {
      assert.deepStrictEqual(buildPathspecs("*.ts", ""), ["*.ts"]);
    });

    test("include only - multiple patterns", () => {
      assert.deepStrictEqual(buildPathspecs("*.ts,src/**", ""), ["*.ts", "src/**"]);
    });

    test("exclude only - prepends dot and uses :(exclude) magic", () => {
      assert.deepStrictEqual(buildPathspecs("", "*.test.ts"), [".", ":(exclude)*.test.ts"]);
    });

    test("exclude only - multiple excludes", () => {
      assert.deepStrictEqual(buildPathspecs("", "*.test.ts,dist/**"), [
        ".",
        ":(exclude)*.test.ts",
        ":(exclude)dist/**",
      ]);
    });

    test("include and exclude combined", () => {
      assert.deepStrictEqual(buildPathspecs("src/**", "*.test.ts"), [
        "src/**",
        ":(exclude)*.test.ts",
      ]);
    });

    test("trims whitespace around patterns", () => {
      assert.deepStrictEqual(buildPathspecs(" *.ts , src/** ", " *.test.ts "), [
        "*.ts",
        "src/**",
        ":(exclude)*.test.ts",
      ]);
    });

    test("filters empty entries from comma-separated list", () => {
      assert.deepStrictEqual(buildPathspecs("*.ts,,src/**", ""), ["*.ts", "src/**"]);
    });
  });

  suite("matchFileLines", () => {
    const FILE = asAbsolutePath("/repo/src/utils.ts");
    const LINES = [
      "const foo = 1;",
      "const Bar = 2;",
      "// TODO: remove this",
      "export default foo;",
    ];

    test("plain text match returns matching lines with 1-based line numbers", () => {
      const result = matchFileLines(LINES, FILE, "foo", false, false);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].lineNumber, 1);
      assert.strictEqual(result[0].lineContent, "const foo = 1;");
      assert.strictEqual(result[1].lineNumber, 4);
      assert.strictEqual(result[1].lineContent, "export default foo;");
    });

    test("plain text match is case-sensitive by default", () => {
      const result = matchFileLines(LINES, FILE, "bar", false, false);
      assert.strictEqual(result.length, 0);
    });

    test("plain text match is case-insensitive when requested", () => {
      const result = matchFileLines(LINES, FILE, "bar", false, true);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].lineContent, "const Bar = 2;");
    });

    test("regex match honours the pattern", () => {
      const result = matchFileLines(LINES, FILE, "const \\w+ = \\d+", true, false);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].lineNumber, 1);
      assert.strictEqual(result[1].lineNumber, 2);
    });

    test("regex match with case-insensitive flag", () => {
      const result = matchFileLines(LINES, FILE, "todo", true, true);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].lineContent, "// TODO: remove this");
    });

    test("all result matches carry correct metadata", () => {
      const [m] = matchFileLines(LINES, FILE, "foo", false, false);
      assert.strictEqual(m.filePath, FILE);
      assert.strictEqual(m.changeType, "added");
      assert.strictEqual(m.isStaged, false);
      assert.strictEqual(m.fileAdded, true);
    });

    test("no matches on empty file", () => {
      assert.deepStrictEqual(matchFileLines([], FILE, "foo", false, false), []);
    });

    test("no matches when pattern absent from all lines", () => {
      assert.deepStrictEqual(matchFileLines(LINES, FILE, "notpresent", false, false), []);
    });
  });

  suite("selectMatchesByChangeType (results-side filter)", () => {
    const mixed = [makeTyped("added"), makeTyped("removed"), makeTyped("added")];

    test('"all" passes the array through unchanged (same reference)', () => {
      assert.strictEqual(selectMatchesByChangeType(mixed, "all"), mixed);
    });

    test('"added" keeps only added matches', () => {
      const r = selectMatchesByChangeType(mixed, "added");
      assert.strictEqual(r.length, 2);
      assert.ok(r.every(m => m.changeType === "added"));
    });

    test('"removed" keeps only removed matches', () => {
      const r = selectMatchesByChangeType(mixed, "removed");
      assert.strictEqual(r.length, 1);
      assert.ok(r.every(m => m.changeType === "removed"));
    });

    test("a filter with no hits yields an empty array", () => {
      assert.deepStrictEqual(selectMatchesByChangeType([makeTyped("added")], "removed"), []);
    });
  });

  suite("stable tree item ids (reveal/expansion depend on these)", () => {
    const FILE = asAbsolutePath("/repo/src/a.ts");
    const C1 = asCommitHash("1111111111111111111111111111111111111111");
    const C2 = asCommitHash("2222222222222222222222222222222222222222");

    test("ids are deterministic, not random — same inputs give the same id", () => {
      const a = new DiffSearchFileItem(FILE, 3, C1);
      const b = new DiffSearchFileItem(FILE, 99, C1); // matchCount differs, id must not
      assert.strictEqual(a.id, b.id);
    });

    test("same file under different commits gets distinct ids (the original duplicate worry)", () => {
      const a = new DiffSearchFileItem(FILE, 1, C1);
      const b = new DiffSearchFileItem(FILE, 1, C2);
      assert.notStrictEqual(a.id, b.id);
    });

    test("commit and repo ids match the namespaced form getParent reconstructs", () => {
      assert.strictEqual(new DiffSearchCommitItem(C1, "msg", new Date(0), 1, 1).id, `commit::${C1}`);
      assert.strictEqual(new DiffSearchRepoItem("my-repo", 5).id, "repo::my-repo");
    });

    test("a repo id is reproducible from just its name (so getParent's stub matches)", () => {
      assert.strictEqual(new DiffSearchRepoItem("my-repo", 1).id, new DiffSearchRepoItem("my-repo", 99).id);
    });
  });
});
