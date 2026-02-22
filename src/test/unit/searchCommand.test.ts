import * as assert from "assert";
import * as vscode from "vscode";
import {
  convertToRelativePaths,
  batchFilesForSearch,
  parseFilePathsFromSearchEditor,
} from "../../commands/searchCommand";
import { asAbsolutePath } from "../../pathTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolder(fsPath: string, name: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.file(fsPath),
    name,
    index: 0,
  };
}

const UNIX_FOLDER = makeFolder("/workspace/myproject", "myproject");

// ---------------------------------------------------------------------------
// convertToRelativePaths
// ---------------------------------------------------------------------------

suite("searchCommand", () => {
  suite("convertToRelativePaths", () => {
    suite("without workspace name", () => {
      test("strips workspace root prefix", () => {
        const abs = [asAbsolutePath("/workspace/myproject/src/foo.ts")];
        const result = convertToRelativePaths(abs, [UNIX_FOLDER]);
        assert.deepStrictEqual(result, ["src/foo.ts"]);
      });

      test("multiple files from same folder", () => {
        const abs = [
          asAbsolutePath("/workspace/myproject/src/a.ts"),
          asAbsolutePath("/workspace/myproject/lib/b.ts"),
        ];
        const result = convertToRelativePaths(abs, [UNIX_FOLDER]);
        assert.deepStrictEqual(result, ["src/a.ts", "lib/b.ts"]);
      });

      test("nested directory path is correctly stripped", () => {
        const folder = makeFolder("/workspace/myproject", "myproject");
        const abs = [asAbsolutePath("/workspace/myproject/a/b/c/deep.ts")];
        const result = convertToRelativePaths(abs, [folder]);
        assert.deepStrictEqual(result, ["a/b/c/deep.ts"]);
      });

      test("file not under any workspace folder is dropped", () => {
        const abs = [asAbsolutePath("/other/project/src/foo.ts")];
        const result = convertToRelativePaths(abs, [UNIX_FOLDER]);
        assert.deepStrictEqual(result, []);
      });

      test("returns empty array for empty input", () => {
        assert.deepStrictEqual(convertToRelativePaths([], [UNIX_FOLDER]), []);
      });
    });

    suite("with workspace name", () => {
      test("returns relativePath and workspaceName", () => {
        const abs = [asAbsolutePath("/workspace/myproject/src/foo.ts")];
        const result = convertToRelativePaths(abs, [UNIX_FOLDER], true);
        assert.deepStrictEqual(result, [{ relativePath: "src/foo.ts", workspaceName: "myproject" }]);
      });

      test("file not under any workspace folder gets empty workspaceName", () => {
        const abs = [asAbsolutePath("/other/project/src/foo.ts")];
        const result = convertToRelativePaths(abs, [UNIX_FOLDER], true);
        assert.deepStrictEqual(result, [{
          relativePath: "/other/project/src/foo.ts",
          workspaceName: "",
        }]);
      });

      test("multi-root workspace picks correct folder per file", () => {
        const folderA = makeFolder("/ws/alpha", "alpha");
        const folderB = makeFolder("/ws/beta",  "beta");
        const abs = [
          asAbsolutePath("/ws/alpha/index.ts"),
          asAbsolutePath("/ws/beta/index.ts"),
        ];
        const result = convertToRelativePaths(abs, [folderA, folderB], true);
        assert.deepStrictEqual(result, [
          { relativePath: "index.ts", workspaceName: "alpha" },
          { relativePath: "index.ts", workspaceName: "beta"  },
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // batchFilesForSearch
  // ---------------------------------------------------------------------------

  suite("batchFilesForSearch", () => {
    test("empty input returns empty batches and oversizedFiles", () => {
      const r = batchFilesForSearch([]);
      assert.deepStrictEqual(r, { batches: [], oversizedFiles: [] });
    });

    test("files fitting in one batch stay together", () => {
      const paths = ["src/a.ts", "src/b.ts", "lib/c.ts"];
      const r = batchFilesForSearch(paths, 10_000);
      assert.strictEqual(r.batches.length, 1);
      assert.deepStrictEqual(r.batches[0], paths);
      assert.deepStrictEqual(r.oversizedFiles, []);
    });

    test("files are split into multiple batches when pattern would exceed limit", () => {
      // limit = 20 chars; three paths of ~12 chars each won't all fit at once
      const paths = ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"];
      const r = batchFilesForSearch(paths, 20);
      assert.ok(r.batches.length > 1, `Expected >1 batches, got ${r.batches.length}`);
      // All files must appear in some batch
      const allBatched = r.batches.flat();
      for (const p of paths) {
        assert.ok(allBatched.includes(p), `Missing ${p} from batches`);
      }
    });

    test("every batch's optimised pattern fits within the limit", () => {
      const { optimizeIncludePatterns } = require("../../utils/patternUtils");
      const paths = Array.from({ length: 20 }, (_, i) => `src/component${i}.ts`);
      const limit = 50;
      const { batches } = batchFilesForSearch(paths, limit);
      for (const batch of batches) {
        const len = optimizeIncludePatterns(batch).length;
        assert.ok(len <= limit, `Batch pattern length ${len} exceeds limit ${limit}`);
      }
    });

    test("single file exceeding limit goes into oversizedFiles", () => {
      const hugeFile = "a".repeat(200) + ".ts";
      const r = batchFilesForSearch([hugeFile], 10);
      assert.ok(r.oversizedFiles.includes(hugeFile));
    });
  });

  // ---------------------------------------------------------------------------
  // parseFilePathsFromSearchEditor
  // ---------------------------------------------------------------------------

  suite("parseFilePathsFromSearchEditor", () => {
    const TYPICAL_SEARCH_OUTPUT = [
      "# Search: foo",
      "# Flags: RegExp: false",
      "# Including: src/**",
      "# ContextLines: 0",
      "",
      "3 results - 2 files",
      "",
      "src/commands/searchCommand.ts:",
      "   10:   const foo = 1;",
      "   20:   const foo = 2;",
      "",
      "src/utils/patternUtils.ts:",
      "   5:    let foo = bar;",
      "",
    ].join("\n");

    test("extracts file paths from a typical search editor output", () => {
      const paths = parseFilePathsFromSearchEditor(TYPICAL_SEARCH_OUTPUT);
      assert.deepStrictEqual(paths, [
        "src/commands/searchCommand.ts",
        "src/utils/patternUtils.ts",
      ]);
    });

    test("skips header lines starting with #", () => {
      const paths = parseFilePathsFromSearchEditor("# Including: src/**\nsrc/foo.ts:\n");
      assert.ok(!paths.includes("# Including: src/**"));
    });

    test("skips indented result lines", () => {
      const paths = parseFilePathsFromSearchEditor("src/foo.ts:\n   10:   code here\n");
      assert.deepStrictEqual(paths, ["src/foo.ts"]);
    });

    test("skips summary lines like '3 results - 2 files'", () => {
      const paths = parseFilePathsFromSearchEditor("3 results - 2 files\nsrc/foo.ts:\n");
      assert.deepStrictEqual(paths, ["src/foo.ts"]);
    });

    test("deduplicates repeated file paths", () => {
      const text = "src/foo.ts:\n   1: a\nsrc/foo.ts:\n   2: b\n";
      const paths = parseFilePathsFromSearchEditor(text);
      assert.deepStrictEqual(paths, ["src/foo.ts"]);
    });

    test("handles Windows CRLF line endings", () => {
      const text = "src/foo.ts:\r\n   10:   bar\r\n";
      const paths = parseFilePathsFromSearchEditor(text);
      assert.deepStrictEqual(paths, ["src/foo.ts"]);
    });

    test("returns empty array for empty string", () => {
      assert.deepStrictEqual(parseFilePathsFromSearchEditor(""), []);
    });

    test("returns empty array when no search has been run (no file lines)", () => {
      const noResults = [
        "# Search: foo",
        "# Flags: RegExp: false",
        "",
        "0 results - 0 files",
      ].join("\n");
      assert.deepStrictEqual(parseFilePathsFromSearchEditor(noResults), []);
    });
  });
});
