import * as assert from "assert";
import { compileFilesExclude, expandBraces, splitGlobAware } from "../../fresh-files/filesExcludeMatcher";

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

  // Cases mirror VS Code's glob.test.ts "exclude exceptions" suite.
  suite("exclude exceptions (`!` keys)", () => {
    function excluded(expression: Record<string, unknown>, paths: string[]): Record<string, boolean> {
      const isExcluded = compileFilesExclude(expression);
      return Object.fromEntries(paths.map(p => [p, isExcluded(p)]));
    }

    test("exceptions carve paths and their children out of excludes", () => {
      assert.deepStrictEqual(
        excluded({ "node_modules/*": true, "!node_modules/susa": true }, ["node_modules/a", "node_modules/susa", "node_modules/susa/index.js", "src/a.js"]),
        { "node_modules/a": true, "node_modules/susa": false, "node_modules/susa/index.js": false, "src/a.js": false });
      assert.deepStrictEqual(excluded({ "*.js": true, "!gulpfile.js": true }, ["a.js", "gulpfile.js"]), { "a.js": true, "gulpfile.js": false });
      assert.deepStrictEqual(
        excluded({ ".*": true, "!.editorconfig": true, "!.gitignore": true }, [".env", ".editorconfig", ".gitignore"]),
        { ".env": true, ".editorconfig": false, ".gitignore": false });
      assert.deepStrictEqual(
        excluded({ "**/.vscode": true, "**/.vscode/*": true, "!**/.vscode/launch.json": true }, ["a/.vscode/settings.json", "a/.vscode/launch.json"]),
        { "a/.vscode/settings.json": true, "a/.vscode/launch.json": false });
    });

    test("an exception under a bare excluded folder re-includes its files (the release-notes case)", () => {
      assert.deepStrictEqual(
        excluded({ node_modules: true, "!node_modules/@types": true }, ["node_modules/react/index.js", "node_modules/@types/node/index.d.ts"]),
        { "node_modules/react/index.js": true, "node_modules/@types/node/index.d.ts": false });
    });

    test("exceptions on their own exclude nothing", () => {
      assert.deepStrictEqual(excluded({ "!*.js": true, "!*.ts": true }, ["a.js", "a.ts", "a.md"]), { "a.js": false, "a.ts": false, "a.md": false });
    });

    test("exceptions win over excludes beneath them, regardless of key order", () => {
      assert.deepStrictEqual(
        excluded({ "node_modules/*": true, "!node_modules/@types": true, "node_modules/@types/*": true }, ["node_modules/a", "node_modules/@types/node"]),
        { "node_modules/a": true, "node_modules/@types/node": false });
    });

    test("disabled, escaped, empty and absolute exception keys", () => {
      assert.deepStrictEqual(excluded({ "*.js": true, "!gulpfile.js": false }, ["gulpfile.js"]), { "gulpfile.js": true });
      assert.deepStrictEqual(excluded({ "{!}notes.txt": true }, ["!notes.txt", "notes.txt"]), { "!notes.txt": true, "notes.txt": false });
      assert.deepStrictEqual(
        excluded({ "*.js": true, "!": true, "!/workspace/a.js": true, "!C:/workspace/a.js": true }, ["a.js"]),
        { "a.js": true });
      assert.deepStrictEqual(excluded({ src: true, "!src/keep/": true, "!src/also/**": true }, ["src/keep/a", "src/also/b", "src/c"]),
        { "src/keep/a": false, "src/also/b": false, "src/c": true });
    });

    test("exceptions don't re-include version-control folders unless one names them", () => {
      assert.deepStrictEqual(
        excluded({ "**/.git": true, third_party: true, "!third_party/lib": true }, ["third_party/lib/a.js", "third_party/lib/.git/config"]),
        { "third_party/lib/a.js": false, "third_party/lib/.git/config": true });
      assert.deepStrictEqual(
        excluded({ "**/.git": true, "!.git/hooks": true }, [".git/hooks/pre-commit", ".git/config"]),
        { ".git/hooks/pre-commit": false, ".git/config": true });
      assert.deepStrictEqual(
        excluded({ "**/.hg": true, "**/.svn": true, "!{.git,.hg}/hooks": true }, [".hg/hooks/x", ".svn/hooks/x"]),
        { ".hg/hooks/x": false, ".svn/hooks/x": true });
    });
  });

  suite("expandBraces", () => {
    test("expands each group into its alternatives", () => {
      assert.deepStrictEqual(expandBraces("{a,b}/c"), ["a/c", "b/c"]);
      assert.deepStrictEqual(expandBraces("{a,b}/{c,d}"), ["a/c", "a/d", "b/c", "b/d"]);
      assert.deepStrictEqual(expandBraces("plain"), ["plain"]);
    });
  });
});
