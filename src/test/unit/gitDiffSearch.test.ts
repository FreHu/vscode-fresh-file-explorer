import * as assert from "assert";
import { filterMatchesByPattern, buildPathspecs, matchFileLines } from "../../git/gitDiffSearch";
import { DiffMatch } from "../../git/gitDiffSearch";
import { asAbsolutePath } from "../../pathTypes";

function makeMatch(lineContent: string): DiffMatch {
  return {
    filePath: asAbsolutePath("/repo/file.ts"),
    lineNumber: 1,
    lineContent,
    changeType: "added",
  };
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
});
