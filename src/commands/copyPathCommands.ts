import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { toRelativePaths } from "../utils/pathUtils";
import { normalizePath } from "../utils";
import { showPathFormatQuickPick } from "../utils/quickPick";
import { showInfo, showWarning } from "../extension/logger";
import { execGitWithArgs } from "../git/gitOperations";
import { ConfigService } from "../config/configService";

function getItems(item: FreshFileItem, selectedItems: FreshFileItem[] | undefined): FreshFileItem[] {
  return selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
}

export async function handleCopyAbsolutePath(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
): Promise<void> {
  const allItems = getItems(item, selectedItems).filter(i => i?.resourceUri);
  if (allItems.length === 0) {
    return;
  }
  // Normalize backslashes to forward slashes on Windows.
  const paths = allItems.map(i => normalizePath(i.resourceUri.fsPath));
  await vscode.env.clipboard.writeText(paths.join("\n"));
}

export async function handleCopyRelativePath(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
): Promise<void> {
  const allItems = getItems(item, selectedItems).filter(i => i?.resourceUri);
  if (allItems.length === 0) {
    return;
  }
  const absolutePaths = allItems.map(i => normalizePath(i.resourceUri.fsPath));
  const paths = toRelativePaths(absolutePaths, vscode.workspace.workspaceFolders ?? []);
  if (paths.length > 0) {
    await vscode.env.clipboard.writeText(paths.join("\n"));
  }
}

export async function handleCopyFilename(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
): Promise<void> {
  const allItems = getItems(item, selectedItems).filter(i => i?.resourceUri);
  if (allItems.length === 0) {
    return;
  }
  const names = allItems.map(i => path.basename(i.resourceUri.fsPath));
  await vscode.env.clipboard.writeText(names.join("\n"));
}

export type TreeNode = { children: Map<string, TreeNode>; isFile: boolean; absolutePath: string };

export function buildFileTree(absolutePaths: string[], folderPath: string): TreeNode {
  const root: TreeNode = { children: new Map(), isFile: false, absolutePath: folderPath };
  for (const absPath of absolutePaths) {
    const relativePath = absPath.substring(folderPath.length + 1);
    const parts = relativePath.split("/");
    let node = root;
    let currentPath = folderPath;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath + "/" + part;
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          children: new Map(),
          isFile: isLeaf,
          absolutePath: currentPath,
        });
      }
      node = node.children.get(part)!;
    }
  }
  return root;
}

export function renderFileTree(
  node: TreeNode,
  getLabel: (absolutePath: string, isFile: boolean) => string,
  indent: number = 0,
): string {
  const lines: string[] = [];
  const entries = [...node.children.entries()].sort((a, b) => {
    // Directories before files, then alphabetical within each group
    if (a[1].isFile !== b[1].isFile) {
      return a[1].isFile ? 1 : -1;
    }
    return a[0].localeCompare(b[0]);
  });
  for (const [, child] of entries) {
    const label = getLabel(child.absolutePath, child.isFile);
    if (child.isFile) {
      lines.push("  ".repeat(indent) + "- " + label);
    } else {
      lines.push("  ".repeat(indent) + "- " + label + "/");
      const subtree = renderFileTree(child, getLabel, indent + 1);
      if (subtree) {
        lines.push(subtree);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Used when triggered from the FFE tree (FreshFileItem). Lists only files
 * currently visible in the FFE view (i.e. within the active time window /
 * filters), which is the natural meaning of "this subtree" inside the FFE.
 */
function listSubtreeFromFreshFiles(
  folderPath: string,
  freshFileProvider: FreshFileProvider,
): string[] {
  return freshFileProvider
    .getVisibleFilePaths()
    .map(f => normalizePath(f))
    .filter(f => f.startsWith(folderPath + "/"))
    .sort();
}

/**
 * Used when triggered from the regular file explorer (vscode.Uri). Walks the
 * subtree via `git ls-files` so the listing respects .gitignore. Returns an
 * empty list if the folder is outside any repo (caller surfaces a warning).
 */
async function listSubtreeFromGit(folderUri: vscode.Uri): Promise<string[] | "no-repo"> {
  let repoRoot: string;
  try {
    const result = await execGitWithArgs(
      ["rev-parse", "--show-toplevel"],
      folderUri.fsPath,
      { timeout: 5000 },
    );
    repoRoot = normalizePath(result.trim());
  } catch {
    return "no-repo";
  }

  const relativeFolder = normalizePath(path.relative(repoRoot, folderUri.fsPath));
  // -z gives null-delimited raw bytes — sidesteps git's path quoting/octal escaping.
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  if (relativeFolder) {
    args.push("--", relativeFolder);
  }

  const raw = await execGitWithArgs(args, repoRoot, { timeout: ConfigService.getGitTimeoutMs() });
  return raw
    .split("\0")
    .filter(rel => rel.length > 0)
    .map(rel => normalizePath(path.join(repoRoot, rel)))
    .sort();
}

export async function handleCopySubtreeStructure(
  arg: FreshFileItem | vscode.Uri,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  const fromExplorer = arg instanceof vscode.Uri;
  const folderUri = fromExplorer ? arg : arg?.resourceUri;
  if (!folderUri || folderUri.scheme !== "file") {
    return;
  }
  if (!fromExplorer && !arg.isDirectory) {
    return;
  }

  const folderPath = normalizePath(folderUri.fsPath);

  let filesInSubtree: string[];
  if (fromExplorer) {
    let result: string[] | "no-repo";
    try {
      result = await listSubtreeFromGit(folderUri);
    } catch (err) {
      showWarning(`git ls-files failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (result === "no-repo") {
      showWarning("Folder is not inside a Git repository.");
      return;
    }
    filesInSubtree = result;
  } else {
    filesInSubtree = listSubtreeFromFreshFiles(folderPath, freshFileProvider);
  }

  if (filesInSubtree.length === 0) {
    showInfo("No files found in this folder");
    return;
  }

  const choice = await showPathFormatQuickPick();
  if (!choice) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const getLabel = (absPath: string, _isFile: boolean): string => {
    if (choice === "absolute") {
      return absPath;
    } else if (choice === "relative") {
      return toRelativePaths([absPath], workspaceFolders)[0] ?? absPath;
    } else {
      return path.basename(absPath);
    }
  };

  const tree = buildFileTree(filesInSubtree, folderPath);
  const text = renderFileTree(tree, getLabel);
  await vscode.env.clipboard.writeText(text);
}
