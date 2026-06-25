import * as assert from "assert";
import { compileFilesExclude, splitGlobAware } from "../../fresh-files/filesExcludeMatcher";

suite("filesExcludeMatcher", () => {
  suite("compileFilesExclude — the issue #3 case", () => {
    test("bare folder glob hides the folder and everything under it (ancestor rule)", () => {
      const isExcluded = compileFilesExclude({ backend: true, web: true });
      // The folder entry itself
      assert.strictEqual(isExcluded("backend"), true);
      assert.strictEqual(isExcluded("web"), true);
      // Descendants — hidden via ancestor match, mirroring Explorer subtree pruning
      assert.strictEqual(isExcluded("backend/src/app.js"), true);
      assert.strictEqual(isExcluded("web/index.html"), true);
      // Unrelated root files stay visible
      assert.strictEqual(isExcluded("README.md"), false);
      assert.strictEqual(isExcluded("shared/util.ts"), false);
    });

    test("tolerates backslash-separated (Windows) relative paths", () => {
      const isExcluded = compileFilesExclude({ backend: true });
      assert.strictEqual(isExcluded("backend\\src\\app.js"), true);
    });
  });

  suite("root-anchoring (matches VS Code, not basename)", () => {
    test("bare pattern is root-anchored — does NOT match nested same-named dir", () => {
      const isExcluded = compileFilesExclude({ backend: true });
      assert.strictEqual(isExcluded("packages/backend/app.js"), false);
    });

    test("*.log matches only root-level logs, not nested", () => {
      const isExcluded = compileFilesExclude({ "*.log": true });
      assert.strictEqual(isExcluded("debug.log"), true);
      assert.strictEqual(isExcluded("sub/debug.log"), false);
    });

    test("**/ prefix matches at any depth", () => {
      const isExcluded = compileFilesExclude({ "**/node_modules": true });
      assert.strictEqual(isExcluded("node_modules"), true);
      assert.strictEqual(isExcluded("node_modules/x/index.js"), true);
      assert.strictEqual(isExcluded("packages/a/node_modules/y.js"), true);
    });

    test("**/*.ext matches the extension at any depth", () => {
      const isExcluded = compileFilesExclude({ "**/*.log": true });
      assert.strictEqual(isExcluded("debug.log"), true);
      assert.strictEqual(isExcluded("a/b/debug.log"), true);
      assert.strictEqual(isExcluded("a/b/debug.txt"), false);
    });
  });

  suite("glob features", () => {
    test("single * does not cross a path separator", () => {
      const isExcluded = compileFilesExclude({ "a/*.ts": true });
      assert.strictEqual(isExcluded("a/file.ts"), true);
      assert.strictEqual(isExcluded("a/b/file.ts"), false);
    });

    test("? matches a single non-separator char", () => {
      const isExcluded = compileFilesExclude({ "file?.txt": true });
      assert.strictEqual(isExcluded("file1.txt"), true);
      assert.strictEqual(isExcluded("file.txt"), false);
    });

    test("brace alternation", () => {
      const isExcluded = compileFilesExclude({ "**/*.{js,ts}": true });
      assert.strictEqual(isExcluded("a/x.js"), true);
      assert.strictEqual(isExcluded("a/x.ts"), true);
      assert.strictEqual(isExcluded("a/x.css"), false);
    });

    test("character class", () => {
      const isExcluded = compileFilesExclude({ "file[0-9].txt": true });
      assert.strictEqual(isExcluded("file3.txt"), true);
      assert.strictEqual(isExcluded("filex.txt"), false);
    });

    test("trailing /** and / normalize to the bare folder", () => {
      assert.strictEqual(compileFilesExclude({ "dist/**": true })("dist/bundle.js"), true);
      assert.strictEqual(compileFilesExclude({ "dist/**": true })("dist"), true);
      assert.strictEqual(compileFilesExclude({ "dist/": true })("dist/bundle.js"), true);
    });
  });

  suite("expression value semantics", () => {
    test("entries set to false are not honored", () => {
      const isExcluded = compileFilesExclude({ backend: false });
      assert.strictEqual(isExcluded("backend/app.js"), false);
    });

    test("sibling/when-clause (object) entries are skipped", () => {
      const isExcluded = compileFilesExclude({ "**/*.js": { when: "$(basename).ts" } });
      assert.strictEqual(isExcluded("a/x.js"), false);
    });

    test("empty / undefined expression excludes nothing", () => {
      assert.strictEqual(compileFilesExclude({})("anything"), false);
      assert.strictEqual(compileFilesExclude(undefined)("anything"), false);
    });

    test("a malformed glob does not break sibling globs", () => {
      const isExcluded = compileFilesExclude({ "[": true, dist: true });
      assert.strictEqual(isExcluded("dist/a.js"), true);
    });
  });

  suite("splitGlobAware", () => {
    test("splits on separator but not inside braces", () => {
      assert.deepStrictEqual(splitGlobAware("a/{b,c}/d", "/"), ["a", "{b,c}", "d"]);
    });

    test("splits on separator but not inside brackets", () => {
      assert.deepStrictEqual(splitGlobAware("a/[b/c]/d", "/"), ["a", "[b/c]", "d"]);
    });
  });
});
