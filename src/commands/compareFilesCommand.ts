import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { log } from "../extension/logger";

interface FilePair {
  original: vscode.Uri;
  modified: vscode.Uri;
}

/**
 * Virtual document provider that serves file content for the multi-diff editor.
 * The real file path is encoded in the URI query parameter. Both sides of a
 * comparison pair share the same URI path (so VS Code shows "M" not "R"),
 * but differ in query so the content provider can serve different files.
 */
export class CompareContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "fresh-compare";

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const realPath = uri.query;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(realPath));
    return new TextDecoder().decode(bytes);
  }
}

export function generatePairs(uris: vscode.Uri[], mode: "allPermutations" | "firstVsRest"): FilePair[] {
  if (mode === "firstVsRest") {
    const [first, ...rest] = uris;
    return rest.map(uri => ({ original: first, modified: uri }));
  }
  const pairs: FilePair[] = [];
  for (let i = 0; i < uris.length; i++) {
    for (let j = i + 1; j < uris.length; j++) {
      pairs.push({ original: uris[i], modified: uris[j] });
    }
  }
  return pairs;
}

async function openMultiDiff(pairs: FilePair[], titleText: string, uris: vscode.Uri[]): Promise<void> {
  const resources = pairs.map(({ original, modified }) => {
    const label = `${path.basename(original.fsPath)} ↔ ${path.basename(modified.fsPath)}`;
    return {
      originalUri: vscode.Uri.from({ scheme: CompareContentProvider.scheme, path: label, query: original.fsPath }),
      modifiedUri: vscode.Uri.from({ scheme: CompareContentProvider.scheme, path: label, query: modified.fsPath }),
    };
  });

  const multiDiffSourceUri = vscode.Uri.from({
    scheme: "fresh-compare",
    path: uris.map(u => path.basename(u.fsPath)).join("+"),
  });

  await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri,
    title: titleText,
    resources,
  });
}

export async function handleCompareSelected(
  item: FreshFileItem,
  selectedItems?: FreshFileItem[],
  treeViews?: vscode.TreeView<FreshFilesTreeItem>[],
): Promise<void> {
  let items: FreshFileItem[];
  if (selectedItems && selectedItems.length >= 2) {
    items = selectedItems;
  } else if (item) {
    items = [item];
  } else {
    // Keybinding path — fall back to the focused tree view's current selection
    items = [];
    for (const tv of treeViews ?? []) {
      const sel = tv.selection.filter((i): i is FreshFileItem => i instanceof FreshFileItem);
      if (sel.length > 0) { items = sel; break; }
    }
  }
  const fileItems = items.filter(i => i.resourceUri && !i.isDirectory);

  if (fileItems.length < 2) {
    vscode.window.showInformationMessage("Select at least 2 files to compare.");
    return;
  }

  const uris = fileItems.map(i => i.resourceUri);

  if (uris.length === 2) {
    const title = `${path.basename(uris[0].fsPath)} ↔ ${path.basename(uris[1].fsPath)}`;
    log(`Compare selected: opening diff for ${title}`);
    await vscode.commands.executeCommand("vscode.diff", uris[0], uris[1], title);
    return;
  }

  let mode: "allPermutations" | "firstVsRest" = "allPermutations";
  let baseUri: vscode.Uri = uris[0];

  if (uris.length > 3) {
    const permCount = (uris.length * (uris.length - 1)) / 2;

    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(git-compare) One file vs all others",
          description: `${uris.length - 1} comparisons — choose base file next`,
          value: "firstVsRest" as const,
        },
        {
          label: "$(list-flat) All permutations",
          description: `${permCount} comparisons`,
          value: "allPermutations" as const,
        },
      ],
      { placeHolder: `How do you want to compare ${uris.length} files?` },
    );

    if (!choice) return;
    mode = choice.value;

    if (mode === "firstVsRest") {
      const baseChoice = await vscode.window.showQuickPick(
        uris.map(u => ({
          label: path.basename(u.fsPath),
          description: vscode.workspace.asRelativePath(u),
          uri: u,
        })),
        { placeHolder: "Which file should be compared against all others?" },
      );

      if (!baseChoice) return;
      baseUri = baseChoice.uri;
    }
  }

  // For firstVsRest, reorder so baseUri is first
  const orderedUris = mode === "firstVsRest"
    ? [baseUri, ...uris.filter(u => u.fsPath !== baseUri.fsPath)]
    : uris;

  const pairs = generatePairs(orderedUris, mode);

  const title =
    mode === "firstVsRest"
      ? `${path.basename(baseUri.fsPath)} vs ${orderedUris.length - 1} files`
      : `Compare ${uris.length} files (${pairs.length} pairs)`;

  log(`Compare selected: opening multi-diff editor — ${title}`);
  await openMultiDiff(pairs, title, orderedUris);
}
