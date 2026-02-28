import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { toRelativePaths } from "../utils/pathUtils";
import { normalizePath } from "../utils";
import { showPathFormatQuickPick } from "../utils/quickPick";

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

type TreeNode = { children: Map<string, TreeNode>; isFile: boolean; absolutePath: string };

function buildFileTree(absolutePaths: string[], folderPath: string): TreeNode {
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

function renderFileTree(
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

export async function handleCopySubtreeStructure(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (!item?.resourceUri || !item.isDirectory) {
    return;
  }

  const folderPath = normalizePath(item.resourceUri.fsPath);
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  const filesInSubtree = freshFileProvider
    .getVisibleFilePaths()
    .map(f => normalizePath(f))
    .filter(f => f.startsWith(folderPath + "/"))
    .sort();

  if (filesInSubtree.length === 0) {
    vscode.window.showInformationMessage("No files found in this folder");
    return;
  }

  const choice = await showPathFormatQuickPick();

  if (!choice) {
    return;
  }

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
