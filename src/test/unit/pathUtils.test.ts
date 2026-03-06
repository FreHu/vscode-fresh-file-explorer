import * as assert from "assert";
import { findRepoForFile, findRepoForAbsolutePath } from "../../utils/pathUtils";
import { WorkspaceFolderInfo } from "../../types";
import { asAbsolutePath } from "../../pathTypes";

function makeFolder(fsPath: string, gitRepos: string[]): WorkspaceFolderInfo {
  return { path: asAbsolutePath(fsPath), name: "workspace", gitRepos };
}

suite("pathUtils", () => {
  suite("findRepoForFile", () => {
    suite("single root repo (repo === '')", () => {
      const folder = makeFolder("/repo", [""]);

      test("returns the root repo for a top-level file", () => {
        const result = findRepoForFile(folder, "src/foo.ts");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "");
        assert.strictEqual(result.filePathInRepo, "src/foo.ts");
      });

      test("returns the root repo for a nested file", () => {
        const result = findRepoForFile(folder, "a/b/c.ts");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "");
        assert.strictEqual(result.filePathInRepo, "a/b/c.ts");
      });
    });

    suite("single subdirectory repo", () => {
      const folder = makeFolder("/ws", ["packages/lib"]);

      test("returns the subdir repo for a file inside it", () => {
        const result = findRepoForFile(folder, "packages/lib/src/index.ts");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "packages/lib");
        assert.strictEqual(result.filePathInRepo, "src/index.ts");
      });

      test("returns undefined for a file outside the subdir repo", () => {
        const result = findRepoForFile(folder, "other/file.ts");
        assert.strictEqual(result, undefined);
      });

      test("returns undefined for the repo directory itself (not a file inside it)", () => {
        // "packages/lib" doesn't start with "packages/lib/"
        const result = findRepoForFile(folder, "packages/lib");
        assert.strictEqual(result, undefined);
      });
    });

    suite("root repo plus submodule repos (submodule wins over root)", () => {
      const folder = makeFolder("/ws", [
        "",
        "Carthage/Checkouts/Nimble",
        "Carthage/Checkouts/Quick",
      ]);

      test("file in a submodule is attributed to the submodule, not the root", () => {
        const result = findRepoForFile(folder, "Carthage/Checkouts/Nimble/Sources/foo.swift");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Nimble");
        assert.strictEqual(result.filePathInRepo, "Sources/foo.swift");
      });

      test("file in another submodule is attributed correctly", () => {
        const result = findRepoForFile(folder, "Carthage/Checkouts/Quick/Tests/bar.swift");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Quick");
        assert.strictEqual(result.filePathInRepo, "Tests/bar.swift");
      });

      test("file in the root repo (outside all submodules) uses the root", () => {
        const result = findRepoForFile(folder, "Sources/main.swift");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "");
        assert.strictEqual(result.filePathInRepo, "Sources/main.swift");
      });
    });

    suite("nested submodules — deepest match wins", () => {
      // Quick has its own copy of Nimble as a nested submodule
      const folder = makeFolder("/ws", [
        "",
        "Carthage/Checkouts/Nimble",
        "Carthage/Checkouts/Quick",
        "Carthage/Checkouts/Quick/Externals/Nimble",
      ]);

      test("file in nested Nimble uses the nested repo, not the top-level one", () => {
        const result = findRepoForFile(
          folder,
          "Carthage/Checkouts/Quick/Externals/Nimble/Sources/foo.swift",
        );
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Quick/Externals/Nimble");
        assert.strictEqual(result.filePathInRepo, "Sources/foo.swift");
      });

      test("file in top-level Nimble still uses the top-level repo", () => {
        const result = findRepoForFile(
          folder,
          "Carthage/Checkouts/Nimble/Sources/bar.swift",
        );
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Nimble");
        assert.strictEqual(result.filePathInRepo, "Sources/bar.swift");
      });

      test("file in Quick (but not its submodule) uses Quick", () => {
        const result = findRepoForFile(
          folder,
          "Carthage/Checkouts/Quick/Tests/QuickSpec.swift",
        );
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Quick");
        assert.strictEqual(result.filePathInRepo, "Tests/QuickSpec.swift");
      });

      test("the discard-regression case: xcconfigs file with spaces in path", () => {
        const f = makeFolder("/ws", [
          "",
          "Carthage/Checkouts/xcconfigs",
        ]);
        const result = findRepoForFile(f, "Carthage/Checkouts/xcconfigs/Mac OS X/Mac-StaticLibrary.xcconfig");
        assert.ok(result);
        assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/xcconfigs");
        assert.strictEqual(result.filePathInRepo, "Mac OS X/Mac-StaticLibrary.xcconfig");
      });
    });

    suite("no matching repo", () => {
      test("returns undefined when folder has no repos at all", () => {
        const folder = makeFolder("/ws", []);
        assert.strictEqual(findRepoForFile(folder, "some/file.ts"), undefined);
      });
    });
  });

  suite("findRepoForAbsolutePath", () => {
    const folders: WorkspaceFolderInfo[] = [
      makeFolder("/ws", [
        "",
        "Carthage/Checkouts/Nimble",
        "Carthage/Checkouts/Quick/Externals/Nimble",
      ]),
    ];

    test("resolves an absolute path to the deepest matching repo", () => {
      const result = findRepoForAbsolutePath(
        folders,
        "/ws/Carthage/Checkouts/Quick/Externals/Nimble/Sources/foo.swift",
      );
      assert.ok(result);
      assert.strictEqual(result.repoRelativePath, "Carthage/Checkouts/Quick/Externals/Nimble");
      assert.strictEqual(result.filePathInRepo, "Sources/foo.swift");
    });

    test("returns undefined for a path not under any workspace folder", () => {
      const result = findRepoForAbsolutePath(folders, "/other/project/file.ts");
      assert.strictEqual(result, undefined);
    });
  });
});
