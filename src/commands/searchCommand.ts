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
 * Opens the search view with the given file paths
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
  const result = buildOptimizedSearchPattern(relativePatterns);

  if (!result) {
    vscode.window.showErrorMessage("File paths are too long to create a search pattern");
    return;
  }

  if (result.truncated) {
    vscode.window.showWarningMessage(
      `Search pattern limited to ${result.includedCount} of ${relativePatterns.length} file(s)`,
    );
  }

  log(`Quick pick search: ${relativePatterns.length} file(s), pattern length: ${result.pattern.length}`);

  // Open the search view
  await openSearchView(result.pattern);
}
