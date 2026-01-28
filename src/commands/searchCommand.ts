import * as vscode from "vscode";
import { FreshFileProvider } from "../freshFileProvider";
import { ConfigService } from "../config/configService";
import { log } from "../utils/logger";
import { optimizeIncludePatterns } from "../utils/patternUtils";

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
 * Opens the search view with include pattern pre-filled with all files
 * currently visible in the Fresh File Explorer view.
 */
export function registerSearchInFreshFilesCommand(
  context: vscode.ExtensionContext,
  provider: FreshFileProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("freshFileExplorer.searchInFreshFiles", async () => {
      const filePaths = provider.getVisibleFilePaths();

      if (filePaths.length === 0) {
        vscode.window.showWarningMessage("No files available to search in Fresh File Explorer");
        log("Search command: No files available");
        return;
      }

      // Convert absolute paths to workspace-relative paths for the include pattern
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open");
        return;
      }

      // Build glob pattern for the include field
      // For multi-workspace setups, we need to handle paths correctly
      const relativePatterns: string[] = [];

      for (const absPath of filePaths) {
        // Find which workspace folder this file belongs to
        for (const folder of workspaceFolders) {
          const folderPath = folder.uri.fsPath.replace(/\\/g, "/");
          if (absPath.startsWith(folderPath)) {
            const relativePath = absPath.substring(folderPath.length + 1);
            relativePatterns.push(relativePath);
            break;
          }
        }
      }

      // Optimize pattern using nested brace expansion
      let includePattern = optimizeIncludePatterns(relativePatterns);
      let truncated = false;
      const maxLength = getMaxIncludePatternLength();

      // Check if the optimized pattern is still too long
      if (includePattern.length > maxLength) {
        truncated = true;
        
        // Fall back to including as many individual files as possible
        const includedPaths: string[] = [];
        let currentLength = 2; // Account for { and }

        for (const path of relativePatterns) {
          const additionalLength = path.length + (includedPaths.length > 0 ? 1 : 0);

          if (currentLength + additionalLength > maxLength) {
            break;
          }

          includedPaths.push(path);
          currentLength += additionalLength;
        }

        if (includedPaths.length === 0) {
          vscode.window.showErrorMessage("File paths are too long to create a search pattern");
          return;
        }

        includePattern = includedPaths.length === 1 ? includedPaths[0] : `{${includedPaths.join(",")}}`;
        
        log(
          `Search command: Pattern too long after optimization, including only ${includedPaths.length} of ${relativePatterns.length} files`,
        );
      }

      log(
        `Search command: Optimized ${relativePatterns.length} file(s), final pattern length: ${includePattern.length}`,
      );

      if (truncated) {
        vscode.window.showWarningMessage(
          `Search pattern limited to ${includePattern.split(",").length} file(s) to avoid command-line length errors.`,
        );
      }

      // Open the search view with the include pattern pre-filled
      await vscode.commands.executeCommand("workbench.action.findInFiles", {
        query: "",
        filesToInclude: includePattern,
        triggerSearch: false, // Don't trigger search immediately, let user type query
      });
    }),
  );
}
