import * as vscode from "vscode";
import { FreshFileProvider } from "./freshFileProvider";
import { ConfigService } from "./config/configService";
import { asAbsolutePath } from "./pathTypes";

/**
 * Provides file decorations (text color) for the heatmap feature.
 * Colors files by recency - recent files are bright (cyan/blue), older files are faded (gray).
 * 
 * Uses 8 discrete color buckets distributed exponentially across the current time window,
 * giving finer granularity to recent files.
 * 
 * Skips pending files to avoid conflicts with Git extension's built-in decorations.
 * Files outside the time window (too old) get the most faded color (age8).
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
    if (metadata.isPending) {
      return undefined;
    }

    // Calculate age in milliseconds
    const now = Date.now();
    const fileDate = metadata.date.getTime();
    const ageMs = now - fileDate;

    // Get the current time window in days
    const currentTimeWindow = this.freshFileProvider.currentTimeWindow;
    if (currentTimeWindow.type === "pending") {
      // In pending-only mode, no heatmap (all files would be pending which we skip)
      return undefined;
    }

    const timeWindowMs = currentTimeWindow.days * 24 * 60 * 60 * 1000;

    // Calculate age fraction (0 = now, 1 = at the edge of time window)
    let ageFraction = ageMs / timeWindowMs;
    
    // Clamp to [0, 1] range
    ageFraction = Math.max(0, Math.min(1, ageFraction));

    // Apply exponential scaling to give finer granularity to recent files
    // Using exponent 0.6: this spreads out recent files across more buckets
    // For a 30-day window, bucket boundaries are roughly: 0, 1, 3, 6, 10, 15, 21, 28 days
    const scaledFraction = Math.pow(ageFraction, 0.6);

    // Map to bucket 0-7 (age1 through age8)
    const bucket = Math.min(7, Math.floor(scaledFraction * 8));

    // Return decoration with appropriate color
    const colorId = `freshFileExplorer.heatmap.age${bucket + 1}`;
    return new vscode.FileDecoration(
      undefined, // badge
      undefined, // tooltip (could add age info here if desired)
      new vscode.ThemeColor(colorId)
    );
  }

  /**
   * Provide decoration for directories based on the most recent file within,
   * or for files outside the time window.
   */
  private provideOutsideWindowDecoration(uri: vscode.Uri, normalizedPath: string): vscode.FileDecoration | undefined {
    // First, check if this is a directory with files in our time window
    const mostRecentDate = this.freshFileProvider.getMostRecentDateInDirectory(normalizedPath);
    
    if (mostRecentDate) {
      // This is a directory with files - calculate its color based on most recent file
      const now = Date.now();
      const ageMs = now - mostRecentDate.getTime();

      const currentTimeWindow = this.freshFileProvider.currentTimeWindow;
      if (currentTimeWindow.type === "pending") {
        return undefined;
      }

      const timeWindowMs = currentTimeWindow.days * 24 * 60 * 60 * 1000;
      let ageFraction = ageMs / timeWindowMs;
      ageFraction = Math.max(0, Math.min(1, ageFraction));
      const scaledFraction = Math.pow(ageFraction, 0.6);
      const bucket = Math.min(7, Math.floor(scaledFraction * 8));

      const colorId = `freshFileExplorer.heatmap.age${bucket + 1}`;
      return new vscode.FileDecoration(
        undefined,
        undefined,
        new vscode.ThemeColor(colorId)
      );
    }

    // Not a directory with recent files - check if it's a file in our workspace folders
    // If so, color it with the oldest/most faded color (age8) since it's outside time window
    if (this.isFileInWorkspace(uri)) {
      return new vscode.FileDecoration(
        undefined,
        undefined,
        new vscode.ThemeColor('freshFileExplorer.heatmap.age8')
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

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
