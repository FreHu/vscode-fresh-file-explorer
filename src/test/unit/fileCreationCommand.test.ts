import * as assert from "assert";
import * as path from "path";
import { resolveInputToPaths } from "../../commands/fileCreationCommand";

const ROOT = path.join("C:", "workspace", "project");
const TARGET = path.join(ROOT, "src", "components");

suite("resolveInputToPaths", () => {
  suite("single file", () => {
    test("bare filename resolves under targetDir", () => {
      const result = resolveInputToPaths("Button.tsx", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [path.join(TARGET, "Button.tsx")]);
    });

    test("filename with forward-slash subdir resolves relative to targetDir", () => {
      const result = resolveInputToPaths("utils/helpers.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [path.join(TARGET, "utils", "helpers.ts")]);
    });
  });

  suite("multiple files", () => {
    test("bare names each resolve separately under targetDir", () => {
      const result = resolveInputToPaths("a.ts,b.ts,c.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "a.ts"),
        path.join(TARGET, "b.ts"),
        path.join(TARGET, "c.ts"),
      ]);
    });

    test("bare names inherit subdirectory from first item", () => {
      // "utils/a.ts,b.ts,c.ts" → all three go into utils/
      const result = resolveInputToPaths("utils/a.ts,b.ts,c.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "utils", "a.ts"),
        path.join(TARGET, "utils", "b.ts"),
        path.join(TARGET, "utils", "c.ts"),
      ]);
    });

    test("items with their own separators override inherited directory", () => {
      // "utils/a.ts,lib/b.ts" → each uses its explicit dir
      const result = resolveInputToPaths("utils/a.ts,lib/b.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "utils", "a.ts"),
        path.join(TARGET, "lib", "b.ts"),
      ]);
    });

    test("mixed: some items with separators, some bare (inherit first)", () => {
      // "utils/a.ts,b.ts,lib/c.ts"
      // b.ts inherits "utils" from first item; lib/c.ts uses its own path
      const result = resolveInputToPaths("utils/a.ts,b.ts,lib/c.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "utils", "a.ts"),
        path.join(TARGET, "utils", "b.ts"),
        path.join(TARGET, "lib", "c.ts"),
      ]);
    });
  });

  suite("whitespace handling", () => {
    test("trims whitespace around commas", () => {
      const result = resolveInputToPaths(" a.ts , b.ts ", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "a.ts"),
        path.join(TARGET, "b.ts"),
      ]);
    });

    test("filters out blank entries between commas", () => {
      const result = resolveInputToPaths("a.ts,,b.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "paths");
      if (result.kind !== "paths") { return; }
      assert.deepStrictEqual(result.paths, [
        path.join(TARGET, "a.ts"),
        path.join(TARGET, "b.ts"),
      ]);
    });
  });

  suite("error cases", () => {
    test("empty string returns error", () => {
      const result = resolveInputToPaths("", TARGET, ROOT);
      assert.strictEqual(result.kind, "error");
    });

    test("all-whitespace string returns error", () => {
      const result = resolveInputToPaths("   ", TARGET, ROOT);
      assert.strictEqual(result.kind, "error");
    });

    test("path traversal in only item is blocked", () => {
      const result = resolveInputToPaths("../../../etc/passwd", TARGET, ROOT);
      assert.strictEqual(result.kind, "error");
      if (result.kind !== "error") { return; }
      assert.strictEqual(result.isTraversalAttempt, true);
    });

    test("path traversal in second item is blocked", () => {
      const result = resolveInputToPaths("safe.ts,../../../etc/passwd", TARGET, ROOT);
      assert.strictEqual(result.kind, "error");
      if (result.kind !== "error") { return; }
      assert.strictEqual(result.isTraversalAttempt, true);
    });

    test("path that escapes the workspace root is blocked", () => {
      // TARGET is ROOT/src/components; going up 3 levels escapes ROOT
      const result = resolveInputToPaths("../../../outside.ts", TARGET, ROOT);
      assert.strictEqual(result.kind, "error");
      if (result.kind !== "error") { return; }
      assert.strictEqual(result.isTraversalAttempt, true);
    });
  });
});
