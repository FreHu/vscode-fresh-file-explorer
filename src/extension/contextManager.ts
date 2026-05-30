import * as vscode from "vscode";
import { ContextKeys } from "./contextKeyConstants";

/**
 * Centralized manager for all VS Code context key values set via
 * `vscode.commands.executeCommand("setContext", ...)`.
 *
 * Using typed methods here ensures every call site uses the correct key name
 * and value type, and all context keys are discoverable in one place. Key
 * strings live in `contextKeyConstants.ts` (vscode-free) so a drift test can
 * verify every `when`-clause reference resolves to a real key.
 */
export class ContextManager {
  /** Whether the Fresh File Explorer tree is currently loading data from Git. */
  static setLoading(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.LOADING, value);
  }

  /**
   * Whether the "open changes" mode is active (open diff on click rather than
   * opening the file).
   */
  static setOpenChangesMode(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.OPEN_CHANGES_MODE, value);
  }

  /**
   * The file path of the currently selected item in the Fresh File Explorer.
   * Used so other extensions (e.g. GitLens) can act on the selected file.
   */
  static setSelectedFile(fsPath: string): void {
    vscode.commands.executeCommand("setContext", ContextKeys.SELECTED_FILE, fsPath);
  }

  /** Whether any author/commit filters are currently active. */
  static setHasFilters(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.HAS_FILTERS, value);
  }

  /**
   * Whether the internal file clipboard holds something. Drives the "Paste"
   * menu item; `isCut` distinguishes a cut (move) from a copy.
   */
  static setClipboard(hasClipboard: boolean, isCut: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.HAS_CLIPBOARD, hasClipboard);
    vscode.commands.executeCommand("setContext", ContextKeys.CLIPBOARD_IS_CUT, isCut);
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
    vscode.commands.executeCommand("setContext", ContextKeys.DIFF_SEARCH_HAS_RESULTS, value);
  }

  /** Whether at least one branch-compare entry is active — drives the Branch Compare view welcome message. */
  static setBranchCompareHasActiveComparison(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.BRANCH_COMPARE_HAS_ACTIVE_COMPARISON, value);
  }

  /** Whether the blame heatmap is active for the current editor. */
  static setBlameHeatmapActive(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.BLAME_HEATMAP_ACTIVE, value);
  }

  /** Whether a saved baseline ref exists for the current editor. */
  static setBlameHeatmapHasBaseRef(value: boolean): void {
    vscode.commands.executeCommand("setContext", ContextKeys.BLAME_HEATMAP_HAS_BASE_REF, value);
  }

  /** 1-based editor line numbers that currently have deletions. */
  static setBlameHeatmapDeletionLines(lines: number[]): void {
    vscode.commands.executeCommand("setContext", ContextKeys.BLAME_HEATMAP_DELETION_LINES, lines);
  }
}
