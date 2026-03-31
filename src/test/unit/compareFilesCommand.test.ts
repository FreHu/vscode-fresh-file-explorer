import * as assert from "assert";
import * as vscode from "vscode";
import { generatePairs } from "../../commands/compareFilesCommand";

suite("compareFilesCommand", () => {
  function uri(name: string) {
    return vscode.Uri.file(`/test/${name}`);
  }

  suite("generatePairs", () => {
    test("allPermutations with 3 files produces 3 pairs", () => {
      const uris = [uri("a.ts"), uri("b.ts"), uri("c.ts")];
      const pairs = generatePairs(uris, "allPermutations");
      assert.strictEqual(pairs.length, 3);
      assert.strictEqual(pairs[0].original.fsPath, uris[0].fsPath);
      assert.strictEqual(pairs[0].modified.fsPath, uris[1].fsPath);
      assert.strictEqual(pairs[1].original.fsPath, uris[0].fsPath);
      assert.strictEqual(pairs[1].modified.fsPath, uris[2].fsPath);
      assert.strictEqual(pairs[2].original.fsPath, uris[1].fsPath);
      assert.strictEqual(pairs[2].modified.fsPath, uris[2].fsPath);
    });

    test("allPermutations with 4 files produces 6 pairs", () => {
      const uris = [uri("a.ts"), uri("b.ts"), uri("c.ts"), uri("d.ts")];
      const pairs = generatePairs(uris, "allPermutations");
      assert.strictEqual(pairs.length, 6);
    });

    test("firstVsRest with 4 files produces 3 pairs", () => {
      const uris = [uri("a.ts"), uri("b.ts"), uri("c.ts"), uri("d.ts")];
      const pairs = generatePairs(uris, "firstVsRest");
      assert.strictEqual(pairs.length, 3);
      for (const pair of pairs) {
        assert.strictEqual(pair.original.fsPath, uris[0].fsPath);
      }
      assert.strictEqual(pairs[0].modified.fsPath, uris[1].fsPath);
      assert.strictEqual(pairs[1].modified.fsPath, uris[2].fsPath);
      assert.strictEqual(pairs[2].modified.fsPath, uris[3].fsPath);
    });

    test("firstVsRest with 2 files produces 1 pair", () => {
      const uris = [uri("a.ts"), uri("b.ts")];
      const pairs = generatePairs(uris, "firstVsRest");
      assert.strictEqual(pairs.length, 1);
      assert.strictEqual(pairs[0].original.fsPath, uris[0].fsPath);
      assert.strictEqual(pairs[0].modified.fsPath, uris[1].fsPath);
    });

    test("allPermutations with 2 files produces 1 pair", () => {
      const uris = [uri("a.ts"), uri("b.ts")];
      const pairs = generatePairs(uris, "allPermutations");
      assert.strictEqual(pairs.length, 1);
    });
  });
});
