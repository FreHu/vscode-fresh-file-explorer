import * as vscode from "vscode";

/**
 * Centralized manager for all VS Code context key values set via
 * `vscode.commands.executeCommand("setContext", ...)`.
 *
 * Using typed methods here ensures every call site uses the correct key name
 * and value type, and all context keys are discoverable in one place.
 */
export class ContextManager {
  /** Whether the Fresh File Explorer tree is currently loading data from Git. */
  static setLoading(value: boolean): void {
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", value);
  }

  /**
   * Whether the "open changes" mode is active (open diff on click rather than
   * opening the file).
   */
  static setOpenChangesMode(value: boolean): void {
    vscode.commands.executeCommand("setContext", "freshFileExplorer.openChangesMode", value);
  }

  /**
   * The file path of the currently selected item in the Fresh File Explorer.
   * Used so other extensions (e.g. GitLens) can act on the selected file.
   */
  static setSelectedFile(fsPath: string): void {
    vscode.commands.executeCommand("setContext", "freshFileExplorer.selectedFile", fsPath);
  }

  /** Whether any author/commit filters are currently active. */
  static setHasFilters(value: boolean): void {
    vscode.commands.executeCommand("setContext", "freshFileExplorer.hasFilters", value);
  }

  /**
   * Whether the selected item in the Fresh File Explorer is a directory.
   * Mirrors the built-in `explorerResourceIsFolder` context key so commands
   * that check that key work correctly in this view.
   */
  static setExplorerResourceIsFolder(value: boolean): void {
    vscode.commands.executeCommand("setContext", "explorerResourceIsFolder", value);
  }

  /** Whether the diff-search results tree has any results to show. */
  static setDiffSearchHasResults(value: boolean): void {
    vscode.commands.executeCommand("setContext", "diffSearchResults.hasResults", value);
  }

  /** Whether at least one branch-compare entry is active — drives the Branch Compare view welcome message. */
  static setBranchCompareHasActiveComparison(value: boolean): void {
    vscode.commands.executeCommand("setContext", "freshFileExplorer.branchCompare.hasActiveComparison", value);
  }
}
