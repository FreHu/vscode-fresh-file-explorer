import * as assert from "assert";
import { resolveCommandSelection } from "../../commands/commandSelection";

// This decides what destructive commands (delete, discard) act on. The rule
// that matters is that the three sources are strictly ordered and NEVER
// merged: a merge would let a stale selection in an unfocused view silently
// join the item the user actually right-clicked.

interface Item { id: string }
const a: Item = { id: "a" };
const b: Item = { id: "b" };
const c: Item = { id: "c" };

suite("resolveCommandSelection", () => {
  test("an explicit multi-selection wins", () => {
    assert.deepStrictEqual(resolveCommandSelection(a, [b, c]), [b, c]);
  });

  test("falls back to the right-clicked item when the selection is empty", () => {
    assert.deepStrictEqual(resolveCommandSelection(a, []), [a]);
  });

  test("falls back to the tree selection when neither arg is supplied (keybinding path)", () => {
    assert.deepStrictEqual(resolveCommandSelection(undefined, undefined, [b, c]), [b, c]);
  });

  test("yields nothing when every source is empty", () => {
    assert.deepStrictEqual(resolveCommandSelection(undefined, undefined, []), []);
    assert.deepStrictEqual(resolveCommandSelection(undefined, undefined, undefined), []);
  });

  // The load-bearing property. If these ever concatenate, a destructive
  // command acts on items the user cannot see selected.
  test("never merges sources — selectedItems does not absorb item", () => {
    const out = resolveCommandSelection(a, [b]);
    assert.deepStrictEqual(out, [b]);
    assert.ok(!out.includes(a), "the right-clicked item must not join an explicit selection");
  });

  test("never merges sources — item does not absorb the tree selection", () => {
    const out = resolveCommandSelection(a, undefined, [b, c]);
    assert.deepStrictEqual(out, [a]);
    assert.strictEqual(out.length, 1, "tree selection must not join the right-clicked item");
  });

  test("never merges sources — selectedItems does not absorb the tree selection", () => {
    const out = resolveCommandSelection(undefined, [a], [b, c]);
    assert.deepStrictEqual(out, [a]);
  });

  test("copies the tree selection so callers cannot mutate the view's array", () => {
    const treeSelection: readonly Item[] = [a, b];
    const out = resolveCommandSelection(undefined, undefined, treeSelection);
    out.push(c);
    assert.strictEqual(treeSelection.length, 2, "the view's selection array must not be mutated");
  });
});
