import * as vscode from "vscode";

/** Helper to normalize path separators to forward slashes */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Build a human-readable label for a number of days
 */
export function formatDaysLabel(days: number): string {
  const dayLabels: Record<number, string> = {
    [-1]: "Pending changes",
    1: "1 day",
    7: "1 week",
    14: "2 weeks",
    30: "1 month",
    60: "2 months",
    90: "3 months",
    180: "6 months",
    365: "1 year",
  };

  if (dayLabels.hasOwnProperty(days)) {
    return dayLabels[days];
  }

  return `${days} days`;
}

export function setDifference<T>(all: Iterable<T>, exclude: Set<T>): Set<T> {
  return new Set(Array.from(all).filter(x => !exclude.has(x)));
}

export function dotsDots(str: string, length = 80): string {
  return str.length > length ? str.substring(0, length - 3) + "..." : str;
}

/**
 * Opens a file, but if it's already open in any visible editor, focuses that editor instead of creating a duplicate tab.
 * This prevents the annoying behavior where clicking a file that's already open in another pane creates a second tab.
 */
export async function openFileWithoutDuplicating(
  uri: vscode.Uri,
  options?: {
    preserveFocus?: boolean;
    preview?: boolean;
    viewColumn?: vscode.ViewColumn;
  }
): Promise<void> {
  const { preserveFocus = false, preview = false, viewColumn } = options ?? {};

  // Check if the file is already open in any visible editor
  const existingEditor = vscode.window.visibleTextEditors.find(
    editor => editor.document.uri.toString() === uri.toString()
  );

  if (existingEditor) {
    // File is already open - check if it's the active editor
    const isActiveEditor = vscode.window.activeTextEditor === existingEditor;

    if (isActiveEditor) {
      // Already the active editor, do nothing to avoid unnecessary refocus
      return;
    }

    // File exists but is not active - activate it (ignore preserveFocus since we're just switching to an existing tab)
    await vscode.window.showTextDocument(existingEditor.document, {
      viewColumn: existingEditor.viewColumn,
      preserveFocus: false,
      preview,
    });
  } else {
    // File is not open, open it normally
    if (viewColumn !== undefined) {
      await vscode.commands.executeCommand("vscode.open", uri, viewColumn);
    } else {
      await vscode.commands.executeCommand("vscode.open", uri, {
        preserveFocus,
        preview,
      });
    }
  }
}

/**
 * Opens a diff editor, but if the same diff is already open in any tab, focuses that tab instead of creating a duplicate.
 * This prevents the annoying behavior where clicking to view a diff that's already open creates a second tab.
 */
export async function openDiffWithoutDuplicating(
  leftUri: vscode.Uri,
  rightUri: vscode.Uri,
  title: string,
  options?: {
    preserveFocus?: boolean;
    preview?: boolean;
  }
): Promise<void> {
  const { preserveFocus = false, preview = false } = options ?? {};

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
