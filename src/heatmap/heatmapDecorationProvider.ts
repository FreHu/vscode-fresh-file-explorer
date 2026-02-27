import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { asAbsolutePath } from "../pathTypes";
import { computeHeatmapColorId, OUT_OF_WINDOW_COLOR_ID } from "./heatmapUtils";
import { formatRelativeDateLong } from "../utils/formatUtils";

/**
 * Provides file decorations (text color) for the heatmap feature.
 * Colors files by recency - recent files are bright (cyan/blue), older files are faded (gray).
 * 
 * Uses 7 discrete color buckets (age1–age7) distributed exponentially across the current time
 * window, giving finer granularity to recent files. age8 is reserved for files older than the
 * window so that "oldest tracked file" and "too old to be tracked" are visually distinct.
 */
export class HeatmapDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly freshFileProvider: FreshFileProvider) {}

  /**
   * Provide file decoration for a given URI.
   * Returns color based on file age relative to the current time window.
   */
  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    // Check if heatmap is enabled
    if (!ConfigService.isHeatmapEnabled()) {
      return undefined;
    }

    // Normalize path to match freshFiles keys (forward slashes)
    const normalizedPath = asAbsolutePath(uri.fsPath);

    // Look up the file in freshFiles
    const metadata = this.freshFileProvider.freshFiles.get(normalizedPath);
    if (!metadata) {
      // Not in the fresh files map - could be a directory or file outside the time window
      return this.provideOutsideWindowDecoration(uri, normalizedPath);
    }

    // Skip pending files - let Git extension's decorations show through
    // In pending-only mode, no heatmap (all files would be pending which we skip)
    const currentTimeWindow = this.freshFileProvider.currentTimeWindow;
    if (metadata.isPending || currentTimeWindow.type === "pending") {
      return undefined;
    }

    const colorId = computeHeatmapColorId(metadata.date, currentTimeWindow.days, Date.now());
    return new vscode.FileDecoration(
      undefined, // badge
      `last modified ${formatRelativeDateLong(metadata.date)}`,
      new vscode.ThemeColor(colorId)
    );
  }

  /**
   * Provide decoration for directories based on the most recent file within,
   * or for files outside the time window.
   */
  private provideOutsideWindowDecoration(uri: vscode.Uri, normalizedPath: string): vscode.FileDecoration | undefined {
    // In pending-only mode there are no historical files, so nothing here should be colored.
    // Without this guard every workspace file not in freshFiles would get the age8 fallback color.
    const currentTimeWindow = this.freshFileProvider.currentTimeWindow;
    if (currentTimeWindow.type === "pending") {
      return undefined;
    }

    // First, check if this is a directory with files in our time window
    const mostRecentDate = this.freshFileProvider.getMostRecentDateInDirectory(normalizedPath);
    
    if (mostRecentDate) {
      // This is a directory with files - calculate its color based on most recent file
      const colorId = computeHeatmapColorId(mostRecentDate, currentTimeWindow.days, Date.now());
      return new vscode.FileDecoration(
        undefined,
        undefined,
        new vscode.ThemeColor(colorId)
      );
    }

    // If data hasn't loaded yet, kick off loading and return undefined for now;
    // fireDidChange() will be called once loading completes and decorations will be re-requested.
    if (!this.freshFileProvider.isDataLoaded) {
      return void this.freshFileProvider.ensureDataLoaded();
    }

    // Not a directory with recent files - check if it's a file in our workspace folders
    // If so, color it with the oldest/most faded color (age8) since it's outside time window.
    if (this.isFileInWorkspace(uri)) {
      const windowLabel = currentTimeWindow.type === "historical" ? `${currentTimeWindow.days} days` : "current window";
      return new vscode.FileDecoration(
        undefined,
        `last modified over ${windowLabel} ago`,
        new vscode.ThemeColor(OUT_OF_WINDOW_COLOR_ID)
      );
    }

    return undefined;
  }

  /**
   * Check if a file URI is within one of our workspace folders.
   */
  private isFileInWorkspace(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }

    const filePath = asAbsolutePath(uri.fsPath);
    for (const folder of this.freshFileProvider.workspaceFolders) {
      const folderPath = asAbsolutePath(folder.path);
      if (filePath.startsWith(folderPath + '/') || filePath === folderPath) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Fire event to refresh all decorations.
   * Call this when freshFiles data changes or when heatmap setting is toggled.
   */
  fireDidChange(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
