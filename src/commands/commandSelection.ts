/**
 * Which tree items a command acts on.
 *
 * Deliberately free of `vscode` imports so the precedence rules below can be
 * unit-tested in the fast, host-free tier. The generic is unconstrained for the
 * same reason — callers pass `TreeItem` subtypes, but nothing here inspects
 * them, so the constraint bought type-checking noise and a `vscode` dependency
 * and nothing else.
 */

/**
 * Resolve which tree items a command should act on, in priority order:
 *   1. an explicit multi-selection (`selectedItems`, when non-empty),
 *   2. the single right-clicked `item`,
 *   3. the tree view's current selection (the keybinding path, where VS Code
 *      passes neither `item` nor `selectedItems` — callers pass an already
 *      type-filtered `treeSelection`).
 *
 * The sources are strictly ordered and never merged. Merging would let a
 * destructive command act on items the user cannot see selected — a stale
 * selection in an unfocused view silently joining the right-clicked target.
 */
export function resolveCommandSelection<T>(
  item: T | undefined,
  selectedItems: T[] | undefined,
  treeSelection?: readonly T[],
): T[] {
  if (selectedItems && selectedItems.length > 0) { return selectedItems; }
  if (item) { return [item]; }
  if (treeSelection && treeSelection.length > 0) { return [...treeSelection]; }
  return [];
}
