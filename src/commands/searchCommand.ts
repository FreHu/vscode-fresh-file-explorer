import * as vscode from "vscode";
import { FreshFileProvider } from "../freshFileProvider";
import { ConfigService } from "../config/configService";
import { log } from "../utils/logger";
import { optimizeIncludePatterns } from "../utils/patternUtils";
import { AbsolutePath } from "../pathTypes";

/**
 * Gets the maximum safe length for the include pattern to avoid ENAMETOOLONG errors.
 * 
 * The actual command-line limit breakdown:
 * 1. Your include pattern (e.g., "{src/a.ts,lib/b.ts}") is expanded by VS Code
 * 2. Each file path is split by spreadGlobComponents() into progressive paths:
 *    "src/components/Button.tsx" becomes: -g src -g src/components -g src/components/Button.tsx
 * 3. This creates ~3x the arguments (each prefixed with "-g ")
 * 4. All passed to: cp.spawn(ripgrep, args) which hits OS command-line limits:
 *    - Windows: 8,191 characters total
 *    - macOS: 256KB-1MB
 *    - Linux: 2MB
 * 
 * With a 3x expansion factor + overhead, a 4,000 char pattern → ~13,000 char command line.
 * Default of 4,000 keeps us safely under Windows limits while maximizing file count.
 */
function getMaxIncludePatternLength(): number {
  return ConfigService.getSearchPatternMaxLength();
}

/**
 * Converts absolute file paths to workspace-relative paths
 */
export function convertToRelativePaths(
  absolutePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): string[];

/**
 * Converts absolute file paths to workspace-relative paths with workspace names
 */
export function convertToRelativePaths(
  absolutePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  includeWorkspaceName: true,
): Array<{ relativePath: string; workspaceName: string }>;

export function convertToRelativePaths(
  absolutePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  includeWorkspaceName?: boolean,
): string[] | Array<{ relativePath: string; workspaceName: string }> {
  if (includeWorkspaceName) {
    const results: Array<{ relativePath: string; workspaceName: string }> = [];
    
    for (const absPath of absolutePaths) {
      let relativePath = absPath;
      let workspaceName = "";
      
      for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath.replace(/\\/g, "/");
        if (absPath.startsWith(folderPath)) {
          relativePath = absPath.substring(folderPath.length + 1);
          workspaceName = folder.name;
          break;
        }
      }
      
      results.push({ relativePath, workspaceName });
    }
    
    return results;
  } else {
    const relativePatterns: string[] = [];

    for (const absPath of absolutePaths) {
      for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath.replace(/\\/g, "/");
        if (absPath.startsWith(folderPath)) {
          const relativePath = absPath.substring(folderPath.length + 1);
          relativePatterns.push(relativePath);
          break;
        }
      }
    }

    return relativePatterns;
  }
}

/**
 * Builds an optimized search pattern from relative paths, with truncation if needed
 * @returns The optimized pattern, or null if paths are too long
 * @deprecated Use batchFilesForSearch instead for better handling of long patterns
 */
export function buildOptimizedSearchPattern(
  relativePaths: string[],
): { pattern: string; truncated: boolean; includedCount: number } | null {
  const maxLength = getMaxIncludePatternLength();

  // Optimize pattern using nested brace expansion
  let includePattern = optimizeIncludePatterns(relativePaths);
  let truncated = false;
  let includedCount = relativePaths.length;

  // Check if the optimized pattern is still too long
  if (includePattern.length > maxLength) {
    truncated = true;

    // Fall back to including as many individual files as possible
    const includedPaths: string[] = [];
    let currentLength = 2; // Account for { and }

    for (const path of relativePaths) {
      const additionalLength = path.length + (includedPaths.length > 0 ? 1 : 0);

      if (currentLength + additionalLength > maxLength) {
        break;
      }

      includedPaths.push(path);
      currentLength += additionalLength;
    }

    if (includedPaths.length === 0) {
      return null;
    }

    includePattern = includedPaths.length === 1 ? includedPaths[0] : `{${includedPaths.join(",")}}`;
    includedCount = includedPaths.length;

    log(
      `Search: Pattern too long after optimization, including only ${includedCount} of ${relativePaths.length} files`,
    );
  }

  log(
    `Search: Optimized ${relativePaths.length} file(s), final pattern length: ${includePattern.length}`,
  );

  return { pattern: includePattern, truncated, includedCount };
}

/**
 * Splits file paths into batches where each batch's optimized pattern fits within the limit.
 * Uses a greedy algorithm to maximize files per batch.
 * 
 * @param relativePaths - Array of workspace-relative file paths
 * @param maxLength - Maximum pattern length per batch (defaults to config value)
 * @returns Object containing batches and array of problematic files that exceed the limit (extremely unlikely)
 */
export function batchFilesForSearch(
  relativePaths: string[],
  maxLength?: number
): { batches: string[][]; oversizedFiles: string[] } {
  const limit = maxLength ?? getMaxIncludePatternLength();
  
  if (relativePaths.length === 0) {
    return { batches: [], oversizedFiles: [] };
  }
  
  // Try to fit all files in one batch first
  const singlePattern = optimizeIncludePatterns(relativePaths);
  if (singlePattern.length <= limit) {
    return { batches: [relativePaths], oversizedFiles: [] };
  }
  
  // Need to batch - use greedy algorithm
  const batches: string[][] = [];
  const oversizedFiles: string[] = [];
  let currentBatch: string[] = [];
  
  for (const path of relativePaths) {
    // Try adding this path to the current batch
    const testBatch = [...currentBatch, path];
    const testPattern = optimizeIncludePatterns(testBatch);
    
    if (testPattern.length <= limit) {
      // Fits in current batch
      currentBatch.push(path);
    } else {
      // Doesn't fit - finalize current batch and start new one
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [path];
      
      // Check if even a single file exceeds the limit
      const singleFilePattern = optimizeIncludePatterns([path]);
      if (singleFilePattern.length > limit) {
        // Really cursed repo or the user is a QA tester (hi there, you get an achievement).
        oversizedFiles.push(path);
        log(`Warning: Single file path exceeds limit: ${path} (${singleFilePattern.length} chars)`);
      }
    }
  }
  
  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return { batches, oversizedFiles };
}

/**
 * Opens VS Code's search (either in view or editor based on config) with the given pattern
 */
export async function openSearchView(includePattern: string): Promise<void> {
  const openInEditor = ConfigService.getOpenSearchInEditor();
  
  if (openInEditor) {
    // Open in search editor tab
    await vscode.commands.executeCommand("search.action.openNewEditor", {
      query: "",
      filesToInclude: includePattern,
      triggerSearch: false,
      showIncludesExcludes: true,
    });
  } else {
    // Open in search viewlet
    await vscode.commands.executeCommand("workbench.action.findInFiles", {
      query: "",
      filesToInclude: includePattern,
      triggerSearch: false,
      showIncludesExcludes: true,
    });
  }
}

/**
 * Opens the search view with include pattern pre-filled with all files
 * currently visible in the Fresh File Explorer view.
 */
export async function handleSearchInFreshFiles(
  provider: FreshFileProvider,
): Promise<void> {
  const filePaths = provider.getVisibleFilePaths();
  const workspaceFolders = vscode.workspace.workspaceFolders;
  await openSearchWithFiles(filePaths, workspaceFolders);
}


/**
 * Opens the search view with the given file paths.
 * Automatically batches into multiple search editors if needed to avoid command line length limits.
 */
export async function openSearchWithFiles(
  filePaths: AbsolutePath[],
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): Promise<void> {
  if (filePaths.length === 0) {
    vscode.window.showWarningMessage("No files to search");
    return;
  }

  if (!workspaceFolders) {
    vscode.window.showWarningMessage("No workspace folder open");
    return;
  }

  const relativePatterns = convertToRelativePaths(filePaths, workspaceFolders);
  const { batches, oversizedFiles } = batchFilesForSearch(relativePatterns);

  if (batches.length === 0) {
    vscode.window.showErrorMessage("Unable to create search patterns for the given files");
    return;
  }

  if (batches.length === 1) {
    // Single batch - respect user's preference for search view vs editor
    const pattern = optimizeIncludePatterns(batches[0]);
    log(`Search: ${relativePatterns.length} file(s), pattern length: ${pattern.length}`);
    await openSearchView(pattern);
    
    // Warn about oversized files if any
    if (oversizedFiles.length > 0) {
      const fileList = oversizedFiles.slice(0, 3).join("\n");
      const moreText = oversizedFiles.length > 3 ? `\n...and ${oversizedFiles.length - 3} more` : "";
      vscode.window.showWarningMessage(
        `${oversizedFiles.length} file(s) may not be searchable due to very long paths:\n${fileList}${moreText}`
      );
    }
  } else {
    // Multiple batches required - always use search editors (multiple search views not possible)
    log(`Search: Batching ${relativePatterns.length} file(s) into ${batches.length} search editors`);
    
    for (let i = 0; i < batches.length; i++) {
      const pattern = optimizeIncludePatterns(batches[i]);
      const batchNumber = i + 1;
      
      // Always open in editor when batching
      await vscode.commands.executeCommand("search.action.openNewEditor", {
        query: "",
        filesToInclude: pattern,
        triggerSearch: false,
        showIncludesExcludes: true,
      });
      
      log(`Search batch ${batchNumber}/${batches.length}: ${batches[i].length} file(s), pattern length: ${pattern.length}`);
    }
    
    // Inform the user about the batching and any problematic files
    const totalFiles = batches.reduce((sum, batch) => sum + batch.length, 0);
    let message = `Opened ${batches.length} search tabs to search ${totalFiles} files (pattern too long for single search)`;
    
    if (oversizedFiles.length > 0) {
      message += `\n\nNote: ${oversizedFiles.length} file(s) with very long paths may fail to search. Consider shortening your workspace path or folder structure.`;
    }
    
    vscode.window.showInformationMessage(message);
  }
}
