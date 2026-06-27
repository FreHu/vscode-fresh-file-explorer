import * as vscode from "vscode";

/**
 * True when the given editor is one side of an open diff tab.
 *
 * Diff editors already convey what changed visually — overlaying our blame
 * heatmap on top duplicates the signal and clutters the gutter. We detect this
 * by walking `vscode.window.tabGroups` and checking whether any tab in the
 * editor's view column is a `TabInputTextDiff` whose `original` or `modified`
 * URI matches the editor's document URI.
 *
 * Duck-typed instead of `instanceof vscode.TabInputTextDiff` so it stays
 * resilient if VS Code reshapes the type.
 */
export function isEditorInDiff(editor: vscode.TextEditor): boolean {
  // VS Code reports `undefined` viewColumn for diff sides — the column belongs
  // to the diff tab, not the individual TextEditor side. So if we know the
  // editor's column, restrict the scan to that group; otherwise (undefined →
  // probably a diff side) scan every group's active tab and match any diff
  // input that contains this URI.
  //
  // Only the active tab in a group renders its TextEditor(s) into
  // `visibleTextEditors`, so checking the active tab is sufficient — and
  // necessary: scanning every tab would falsely match a regular tab of the
  // same file that happens to coexist with a diff tab in the same column.
  const uriString = editor.document.uri.toString();
  const targetCol = editor.viewColumn;
  for (const group of vscode.window.tabGroups.all) {
    if (targetCol !== undefined && group.viewColumn !== targetCol) { continue; }
    const activeTab = group.activeTab;
    if (!activeTab) { continue; }
    const input = activeTab.input;
    if (!input || typeof input !== "object") { continue; }
    if ("original" in input && "modified" in input) {
      const orig = (input as { original: vscode.Uri }).original;
      const mod = (input as { modified: vscode.Uri }).modified;
      if (orig.toString() === uriString || mod.toString() === uriString) {
        return true;
      }
    }
  }
  return false;
}
