import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem, FreshFilesTreeItem } from "./freshFileTreeItems";
import { WorkspaceFolderInfo, FileMetadata } from "../types";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { GroupingMode } from "./groupingMode";
import { findWorkspaceFolderForPath, findRepoForFile } from "../utils/pathUtils";
import { normalizePath } from "../utils";
import { log } from "../extension/logger";

export interface ParentLookupContext {
  workspaceFolders: WorkspaceFolderInfo[];
  groupingMode: GroupingMode;
  openChangesMode: boolean;
  /** Cached repo root items from the last render — reveal/getParent must hand VS Code the registered instances. */
  repoItemCache: ReadonlyMap<string, FreshFileItem>;
  countFilesInDirectory(dirPath: string): number;
}

/** `TreeDataProvider.getParent` logic — resolves a file/directory item's parent node. */
export function findParentItem(element: FreshFilesTreeItem, ctx: ParentLookupContext): FreshFilesTreeItem | undefined {
  if (!(element instanceof FreshFileItem)) {
    return undefined;
  }

  // Repo root nodes are root-level items — they have no parent in our tree.
  if (element.id?.startsWith("repo:")) {
    return undefined;
  }

  const folder = findWorkspaceFolderForPath(asAbsolutePath(element.resourceUri.fsPath), ctx.workspaceFolders);
  if (!folder) {
    return undefined;
  }

  // Compute the path relative to the workspace folder (normalized, forward slashes).
  const relativeToFolder = normalizePath(path.relative(folder.path, element.resourceUri.fsPath));

  // Find the most-specific repo that contains this item.
  const repoLocation = findRepoForFile(folder, relativeToFolder);
  if (!repoLocation) {
    return undefined;
  }

  // filePathInRepo is the path from the repo root to this item (normalized).
  const filePathInRepo = repoLocation.filePathInRepo;
  const lastSlash = filePathInRepo.lastIndexOf("/");

  // In flat list mode all files are direct children of the repo root — no directory nodes exist.
  if (ctx.groupingMode === "Flat List" || lastSlash === -1) {
    const repoFsPath = vscode.Uri.file(repoLocation.repoFullPath).fsPath;
    return ctx.repoItemCache.get(`repo:${repoFsPath}`);
  }

  // This item is nested inside a subdirectory — return the immediate parent directory.
  const parentPathInRepo = filePathInRepo.substring(0, lastSlash);
  const parentFullPath = path.join(repoLocation.repoFullPath, parentPathInRepo);
  const parentUri = vscode.Uri.file(parentFullPath);
  return FreshFileItem.forDirectory(
    parentUri,
    ctx.openChangesMode,
    ctx.countFilesInDirectory(parentUri.fsPath),
    false,
  );
}

export interface RevealContext {
  treeView: vscode.TreeView<FreshFilesTreeItem> | undefined;
  dataLoaded: boolean;
  freshFiles: ReadonlyMap<AbsolutePath, FileMetadata>;
  openChangesMode: boolean;
}

/**
 * Reveal a specific file URI in the Fresh Files tree.
 *
 * Skips when the view isn't visible *and* the caller isn't asking for
 * focus — auto-reveal shouldn't pop the view open uninvited. Explicit
 * user invocations (focus=true) always reveal.
 *
 * Returns true if the reveal succeeded; false when the file isn't
 * currently in the tree (filtered out, outside time window, deleted, etc.)
 */
export async function revealFileInTree(uri: vscode.Uri, focus: boolean, ctx: RevealContext): Promise<boolean> {
  if (!ctx.treeView || !ctx.dataLoaded) { return false; }
  if (!focus && !ctx.treeView.visible) { return false; }
  if (uri.scheme !== "file") { return false; }

  const normalizedPath = asAbsolutePath(normalizePath(uri.fsPath));
  const metadata = ctx.freshFiles.get(normalizedPath);
  if (!metadata || metadata.isDeleted) { return false; }

  const item = FreshFileItem.forFile(
    uri,
    ctx.openChangesMode,
    false,
    metadata.commitHash,
    metadata.isPending ?? false,
    metadata.status,
    metadata.renameSource,
  );
  try {
    await ctx.treeView.reveal(item, { select: true, focus, expand: true });
    return true;
  } catch (e) {
    log(`revealFileInTree: could not reveal ${uri.fsPath}: ${e}`, "warn");
    return false;
  }
}
