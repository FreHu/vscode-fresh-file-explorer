import * as vscode from "vscode";
import * as path from "path";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import { optimizeIncludePatterns } from "../utils/patternUtils";
import { toRelativePaths } from "../utils/pathUtils";
import { showPathFormatQuickPick } from "../utils/quickPick";
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
 * Parses file paths from a VS Code search editor's text content.
 *
 * Search editor format:
 *   # Search: query
 *   # Flags: ...
 *   # Including: ...
 *   # ContextLines: N
 *
 *   N results - M files
 *
 *   path/to/file.ts:
 *     10:   some code
 *     20:   more code
 *
 * File path lines start at column 0 and end with `:`.
 * Result lines are indented. Header lines start with `#`.
 */
export function parseFilePathsFromSearchEditor(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const filePaths = new Set<string>();

  for (const line of lines) {
    // Skip empty lines, header lines, indented result lines, and summary lines
    if (
      line.length === 0 ||
      line.startsWith("#") ||
      line.startsWith(" ") ||
      line.startsWith("\t") ||
      /^\d+ results? -/.test(line)
    ) {
      continue;
    }

    // File path lines end with ':'
    // On Windows, drive letters like C: should not be confused with the trailing colon
    if (line.endsWith(":")) {
      const filePath = line.slice(0, -1);
      if (filePath.length > 0) {
        filePaths.add(filePath);
      }
    }
  }

  return Array.from(filePaths);
}

function convertRelativePathsToUris(
  relativePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): vscode.Uri[] {
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return [];
  }

  return relativePaths.map(path => {
    // In multi-root workspaces, paths may be prefixed with workspace folder name
    // e.g., "folder1/src/file.ts" or just "src/file.ts"
    for (const folder of workspaceFolders) {
      // Check if path starts with this workspace folder's name
      const prefix = folder.name + '/';
      if (path.startsWith(prefix)) {
        // Strip workspace name prefix and resolve
        const relativePath = path.substring(prefix.length);
        return vscode.Uri.joinPath(folder.uri, relativePath);
      }
    }
    
    // No workspace prefix found, use first workspace folder (single-root or ambiguous)
    return vscode.Uri.joinPath(workspaceFolders[0].uri, path);
  });
}

/** * Copies file paths from the current search editor's results to the clipboard.
 */
export async function handleCopyPathsFromSearchResults(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.uri.scheme !== "search-editor") {
    vscode.window.showWarningMessage("This command must be run from a Search Editor");
    return;
  }

  const text = editor.document.getText();
  const filePaths = parseFilePathsFromSearchEditor(text);

  if (filePaths.length === 0) {
    vscode.window.showWarningMessage(
      "No file paths found in the search results. Run the search first.",
    );
    return;
  }

  // Ask user which format they want
  const format = await showPathFormatQuickPick();

  if (!format) {
    return;
  }

  let pathsToCopy: string[];

  if (format === "absolute") {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const uris = convertRelativePathsToUris(filePaths, workspaceFolders);
    pathsToCopy = uris.map(uri => uri.fsPath.replace(/\\/g, "/"));
  } else if (format === "filename") {
    pathsToCopy = filePaths.map(f => path.basename(f));
  } else {
    pathsToCopy = filePaths;
  }

  const clipboardText = pathsToCopy.join("\n");
  await vscode.env.clipboard.writeText(clipboardText);

  log(`Copied ${pathsToCopy.length} file path(s) to clipboard`);
  vscode.window.showInformationMessage(
    `Copied ${pathsToCopy.length} file path(s) to clipboard`,
  );
}

/** * Opens all files from the current search editor's results.
 */
export async function handleOpenAllFoundFiles(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.uri.scheme !== "search-editor") {
    vscode.window.showWarningMessage("This command must be run from a Search Editor");
    return;
  }

  const text = editor.document.getText();
  const filePaths = parseFilePathsFromSearchEditor(text);

  if (filePaths.length === 0) {
    vscode.window.showWarningMessage(
      "No file paths found in the search results. Run the search first.",
    );
    return;
  }

  // Confirm if opening many files
  const MAX_FILES_WITHOUT_CONFIRMATION = 15;
  if (filePaths.length > MAX_FILES_WITHOUT_CONFIRMATION) {
    const action = await vscode.window.showWarningMessage(
      `${filePaths.length} is a lot of files. You sure about this?`,
      { modal: true },
      "Open All",
      "Cancel",
    );

    if (action !== "Open All") {
      return;
    }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const uris = convertRelativePathsToUris(filePaths, workspaceFolders);

  log(`Opening ${uris.length} file(s) from search results`);

  let openedCount = 0;
  let failedCount = 0;

  for (const uri of uris) {
    try {
      // Open files in background to not overwhelm the editor
      await vscode.commands.executeCommand("vscode.open", uri, { background: true });
      openedCount++;
    } catch (error) {
      log(`Failed to open file: ${uri.fsPath} - ${error}`, "warn");
      failedCount++;
    }
  }

  if (failedCount > 0) {
    const message = `Opened ${openedCount} file(s)${failedCount > 0 ? ` (${failedCount} failed)` : ""}`;
    vscode.window.showWarningMessage(message);
  }
}

/**
 * Opens a new search scoped to the files present in the current search editor's results.
 * This is a "second-order" search: search within search results.
 */
export async function handlesearchInFoundFiles(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.uri.scheme !== "search-editor") {
    vscode.window.showWarningMessage("This command must be run from a Search Editor");
    return;
  }

  const text = editor.document.getText();
  const filePaths = parseFilePathsFromSearchEditor(text);

  if (filePaths.length === 0) {
    vscode.window.showWarningMessage(
      "No file paths found in the search results.",
    );
    return;
  }

  log(`Second-order search: Found ${filePaths.length} file(s) in search results`);

  // Paths from the search editor are already workspace-relative,
  // so we can use them directly as include patterns.
  const { batches, oversizedFiles } = batchFilesForSearch(filePaths);

  if (batches.length === 0) {
    vscode.window.showErrorMessage("Unable to create search patterns for the given files");
    return;
  }

  if (batches.length === 1) {
    const pattern = optimizeIncludePatterns(batches[0]);
    log(`Second-order search: ${filePaths.length} file(s), pattern length: ${pattern.length}`);
    await openSearchView(pattern);
  } else {
    log(`Second-order search: Batching ${filePaths.length} file(s) into ${batches.length} search editors`);
    for (let i = 0; i < batches.length; i++) {
      const pattern = optimizeIncludePatterns(batches[i]);
      await vscode.commands.executeCommand("search.action.openNewEditor", {
        query: "",
        filesToInclude: pattern,
        triggerSearch: false,
        showIncludesExcludes: true,
      });
      log(`Second-order search batch ${i + 1}/${batches.length}: ${batches[i].length} file(s), pattern length: ${pattern.length}`);
    }

    const totalFiles = batches.reduce((sum, batch) => sum + batch.length, 0);
    let message = `Opened ${batches.length} search tabs to search ${totalFiles} files`;
    if (oversizedFiles.length > 0) {
      message += ` (${oversizedFiles.length} file(s) with very long paths may not be included)`;
    }
    vscode.window.showInformationMessage(message);
  }
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

  const relativePatterns = toRelativePaths(filePaths, workspaceFolders);
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
