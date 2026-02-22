import * as assert from "assert";
import { buildLArg } from "../../commands/gitLogLCommand";

const REL = "src/utils/helpers.ts";
const FILE = "helpers.ts";

suite("buildLArg", () => {
  suite("line range mode", () => {
    test("lArg is startLine,endLine:relativePath", () => {
      const { lArg } = buildLArg({ kind: "lineRange", startLine: 10, endLine: 20, relativePath: REL, fileName: FILE });
      assert.strictEqual(lArg, "10,20:src/utils/helpers.ts");
    });

    test("label contains both line numbers", () => {
      const { label } = buildLArg({ kind: "lineRange", startLine: 10, endLine: 20, relativePath: REL, fileName: FILE });
      assert.ok(label.includes("10"), `label should include startLine, got: ${label}`);
      assert.ok(label.includes("20"), `label should include endLine, got: ${label}`);
    });

    test("label contains the file name", () => {
      const { label } = buildLArg({ kind: "lineRange", startLine: 1, endLine: 5, relativePath: REL, fileName: FILE });
      assert.ok(label.includes(FILE));
    });

    test("single-line selection (start === end) still uses line range format", () => {
      const { lArg } = buildLArg({ kind: "lineRange", startLine: 7, endLine: 7, relativePath: REL, fileName: FILE });
      assert.strictEqual(lArg, "7,7:src/utils/helpers.ts");
    });
  });

  suite("funcName mode", () => {
    test("lArg is :funcName:relativePath", () => {
      const { lArg } = buildLArg({ kind: "funcName", funcName: "handleClick", relativePath: REL, fileName: FILE });
      assert.strictEqual(lArg, ":handleClick:src/utils/helpers.ts");
    });

    test("label contains the function name", () => {
      const { label } = buildLArg({ kind: "funcName", funcName: "handleClick", relativePath: REL, fileName: FILE });
      assert.ok(label.includes("handleClick"));
    });

    test("label contains the file name", () => {
      const { label } = buildLArg({ kind: "funcName", funcName: "foo", relativePath: REL, fileName: FILE });
      assert.ok(label.includes(FILE));
    });

    test("special regex characters in funcName are escaped in lArg", () => {
      const { lArg } = buildLArg({ kind: "funcName", funcName: "my.func+name", relativePath: REL, fileName: FILE });
      assert.ok(lArg.includes("my\\.func\\+name"), `Expected escaped funcName, got: ${lArg}`);
    });

    test("forward slashes in relativePath are preserved", () => {
      const { lArg } = buildLArg({ kind: "funcName", funcName: "fn", relativePath: "a/b/c.ts", fileName: "c.ts" });
      assert.ok(lArg.endsWith(":a/b/c.ts"), `Expected forward-slash path, got: ${lArg}`);
    });
  });
});
