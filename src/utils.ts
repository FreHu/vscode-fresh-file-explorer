import * as vscode from "vscode";

/** Helper to normalize path separators to forward slashes */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Opens a diff editor, but if the same diff is already open in any tab, focuses that tab instead of creating a duplicate.
 * This prevents the annoying behavior where clicking to view a diff that's already open creates a second tab.
 */
export async function openDiff(
  leftUri: vscode.Uri,
  rightUri: vscode.Uri,
  title: string,
  options?: {
    preserveFocus?: boolean;
    preview?: boolean;
  }
): Promise<void> {
  const { preserveFocus = false, preview = false } = options ?? {};

  // VS Code has no built-in dedup for diff editors, but we mirror the user's
  // `workbench.editor.revealIfOpen` preference so this helper doesn't override
  // a deliberate "always open a new tab" choice.
  const revealIfOpen = vscode.workspace
    .getConfiguration("workbench.editor")
    .get<boolean>("revealIfOpen", false);

  if (!revealIfOpen) {
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
      preserveFocus,
      preview,
    });
    return;
  }

  const leftUriString = leftUri.toString();
  const rightUriString = rightUri.toString();

  // Check all tab groups for an existing diff editor with the same URIs
  for (let i = 0; i < vscode.window.tabGroups.all.length; i++) {
    const tabGroup = vscode.window.tabGroups.all[i];

    for (let j = 0; j < tabGroup.tabs.length; j++) {
      const tab = tabGroup.tabs[j];

      // Check if this is a diff editor with the same left/right URIs
      const input = tab.input;

      if (!input) {
        continue;
      }

      const hasOriginal = typeof input === 'object' && input !== null && 'original' in input;
      const hasModified = typeof input === 'object' && input !== null && 'modified' in input;

      if (hasOriginal && hasModified) {
        const orig = (input as any).original;
        const mod = (input as any).modified;

        // The original and modified ARE the Uri objects themselves, not wrapped in {uri: ...}
        const isOrigUri = orig && typeof orig === 'object' && 'scheme' in orig;
        const isModUri = mod && typeof mod === 'object' && 'scheme' in mod;

        if (isOrigUri && isModUri) {
          const originalUri = orig as vscode.Uri;
          const modifiedUri = mod as vscode.Uri;

          const origUriStr = originalUri.toString();
          const modUriStr = modifiedUri.toString();

          if (origUriStr === leftUriString && modUriStr === rightUriString) {
            // Found the same diff editor!
            // If the diff is already the active tab in the active tab group, don't do anything
            if (tab.isActive && tabGroup.isActive) {
              return;
            }

            // Diff exists but is not currently active - activate it
            // We ignore preserveFocus here because we're just switching to an existing tab, not opening a new one            
            // Re-open the diff targeting the specific view column with preview mode preserved
            // VS Code will focus the existing one instead of creating a duplicate
            await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
              viewColumn: tabGroup.viewColumn,
              preserveFocus: false,
              preview: preview,
            });

            return;
          }
        }
      }
    }
  }

  // Diff not found, open it normally
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
    preserveFocus,
    preview,
  });
}
