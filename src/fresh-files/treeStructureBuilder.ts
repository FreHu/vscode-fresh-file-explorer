// File-structure and flat-list tree builders extracted from FreshFileProvider.
//
// These render a repo's children for the "File Structure" and "Flat List"
// grouping modes. They were the bulk of the provider's render path; pulling them
// behind an explicit TreeBuildContext keeps the provider a thin coordinator and
// makes the render logic testable without standing up the whole provider.
//
// files.exclude is evaluated PER NODE relative to the node's owning workspace
// folder (most-specific owner) — the same absolute file can be hidden under one
// root yet shown under another. See filesExcludeFilter.ts / CLAUDE.md.

import * as vscode from "vscode";
import * as path from "path";

import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { FileMetadata, SortOrder, WorkspaceFolderInfo } from "../types";
import { FileIndex } from "./fileIndex";
import { FilterManager } from "./freshFileFilterManager";
import { FilesExcludeFilter, findOwningFolder } from "./filesExcludeFilter";
import { FreshFileItem, SubmoduleEntryItem } from "./freshFileTreeItems";
import { FreshFileItemSorter } from "./freshFileItemSorter";
import { ConfigService } from "../config/configService";
import { NormalizedRepoPath } from "../pathTypes";
import { BranchName } from "../types";
import { RepoInfo } from "./dataCollector";
import { normalizePath } from "../utils";
import { getRelativeDepth } from "../utils/pathUtils";
import {
  formatFileDescription,
  formatFileTooltip,
  formatDirectoryTooltip,
  formatGroupDescription,
} from "../utils/formatUtils";

/**
 * Everything the structural tree builders need from the provider, passed
 * explicitly so the builders hold no reference to the provider itself.
 */
export interface TreeBuildContext {
  freshFiles: Map<AbsolutePath, FileMetadata>;
  fileIndex: FileIndex;
  filterManager: FilterManager;
  filesExcludeFilter: FilesExcludeFilter;
  workspaceFolders: WorkspaceFolderInfo[];
  /** Normalized absolute paths that are submodule repository roots. */
  submoduleRootPaths: Set<AbsolutePath>;
  /** Whether a file passes the active per-repo pathspec/folder scope. */
  passesRepoScope: (filePath: string) => boolean;
  sortOrder: SortOrder;
  openChangesMode: boolean;
}

/** State the repo-root view needs from the provider. */
export interface RepoViewContext {
  resolvedRepos: RepoInfo[];
  freshFiles: Map<AbsolutePath, FileMetadata>;
  filesExcludeFilter: FilesExcludeFilter;
  getFolderScope: (repo: NormalizedRepoPath) => string | undefined;
  getPathspec: (repo: NormalizedRepoPath) => string | undefined;
  repoBranches: Map<NormalizedRepoPath, BranchName>;
  reposLoading: Set<NormalizedRepoPath>;
  reposLoadingHistorical: Set<NormalizedRepoPath>;
  openChangesMode: boolean;
}

/**
 * Build the repository root items (the top-level nodes for each repo). The
 * caller appends them to its result list and registers them in its id→item
 * cache (reveal needs the exact instances VS Code already saw).
 */
export function buildRepoRootItems(contextValue: string, ctx: RepoViewContext): FreshFileItem[] {
  // Read once: when off, the per-file exclude check below is skipped entirely.
  const excludeOn = ctx.filesExcludeFilter.enabled;

  // Per-repo file counts in a SINGLE pass over the file map. Each file is attributed to
  // its most-specific owning repo; repo roots don't overlap in practice
  // (sibling worktrees / submodules live in separate paths)
  const reposBySpecificity = [...ctx.resolvedRepos].sort(
    (a, b) => b.normalizedRepoPath.length - a.normalizedRepoPath.length,
  );
  const repoFileCounts = new Map<string, number>();
  for (const filePath of ctx.freshFiles.keys()) {
    const p = filePath as string;
    for (const repo of reposBySpecificity) {
      const rp = repo.normalizedRepoPath as string;
      if (p !== rp && !p.startsWith(rp + "/")) { continue; }
      // Owning repo found — count it unless out of folder scope or hidden by
      // this folder's files.exclude (keeps the count in step with buildTree).
      const scope = ctx.getFolderScope(repo.normalizedRepoPath);
      const inScope = !scope || p === scope || p.startsWith(scope + "/");
      if (inScope && !(excludeOn && ctx.filesExcludeFilter.isExcludedUnder(filePath, repo.folder))) {
        repoFileCounts.set(rp, (repoFileCounts.get(rp) ?? 0) + 1);
      }
      break; // most-specific owner; don't double-count under a parent repo
    }
  }

  const items: FreshFileItem[] = [];
  // Default: group by file structure
  for (const { folder, repoRelPath, repoFullPath, normalizedRepoPath } of ctx.resolvedRepos) {
    const repoName = repoRelPath || folder.name;
    const activeFolderScope = ctx.getFolderScope(normalizedRepoPath);

    const fileCount = repoFileCounts.get(normalizedRepoPath as string) ?? 0;

    const repoUri = vscode.Uri.file(repoFullPath);
    const branchName = ctx.repoBranches.get(normalizedRepoPath);
    const isLoading = ctx.reposLoading.has(normalizedRepoPath);
    const isLoadingHistorical = ctx.reposLoadingHistorical.has(normalizedRepoPath);
    const activePathspec = ctx.getPathspec(normalizedRepoPath);

    // Compute a display-friendly folder scope label
    const folderScopeDisplay = activeFolderScope
      ? normalizePath(path.relative(repoFullPath, activeFolderScope))
      : undefined;

    // Respect auto-expand depth setting for repository roots. We must commit
    // to the expansion preference on the *first* render — VS Code's TreeView
    // locks in collapsibleState by item id, so a "Collapsed during load,
    // Expanded after" sequence leaves the repo permanently collapsed. During
    // loading we expand under the assumption that data is coming.
    const expectFiles = fileCount > 0 || isLoading || isLoadingHistorical;
    const shouldExpand = ConfigService.getAutoExpandDepth() > 0 && expectFiles;

    const repoItem = FreshFileItem.forRepository(
      repoUri,
      ctx.openChangesMode,
      fileCount,
      repoName,
      branchName,
      contextValue,
      shouldExpand,
      isLoading,
      activePathspec,
      folderScopeDisplay,
      isLoadingHistorical,
    );
    items.push(repoItem);
  }
  return items;
}

/** Build the "File Structure" children of a directory node. */
export function buildTree(
  parentPath: string,
  ctx: TreeBuildContext,
): (FreshFileItem | SubmoduleEntryItem)[] {
  const normalizedParent = asAbsolutePath(parentPath);

  const directChildren = ctx.fileIndex.getDirectChildren(normalizedParent);
  if (!directChildren || directChildren.size === 0) { return []; }

  // Build the dir stats cache once (shared across all buildTree calls this render pass).
  const descriptionFormat = ConfigService.getDescriptionFormat();
  // files.exclude is evaluated relative to the workspace folder of THIS node,
  // so excluding `backend` at a root prunes the whole `backend/` subtree here
  // (and stops descent into it) while a backend-rooted node still shows it.
  // Must be the MOST-SPECIFIC owning folder: with overlapping roots, a generic
  // first-match would resolve the backend node to the root and wrongly apply
  // the root's excludes to it. `excludeOn` is read once so that, when the
  // feature is off, every per-file/per-dir check below short-circuits — no work.
  const excludeOn = ctx.filesExcludeFilter.enabled;
  const nodeFolder = excludeOn
    ? findOwningFolder(normalizePath(normalizedParent), ctx.workspaceFolders)
    : undefined;

  const dirStats = ctx.fileIndex.ensureDirStats(
    ctx.freshFiles,
    (m) => ctx.filterManager.passesFilters(m),
    (p) => ctx.passesRepoScope(p) && !(excludeOn && ctx.filesExcludeFilter.isExcludedByOwner(p, ctx.workspaceFolders)),
    descriptionFormat.showLineChanges,
  );
  const autoExpandDepth = ConfigService.getAutoExpandDepth();

  const items: (FreshFileItem | SubmoduleEntryItem)[] = [];

  for (const childPath of directChildren) {
    if (nodeFolder && ctx.filesExcludeFilter.isExcludedUnder(childPath, nodeFolder)) { continue; }
    const isFile = ctx.freshFiles.has(childPath);
    const name = childPath.substring(normalizedParent.length + 1);
    const fullPath = path.join(parentPath, name);
    const uri = vscode.Uri.file(fullPath);

    if (isFile) {
      const metadata = ctx.freshFiles.get(childPath)!;
      if (!ctx.filterManager.passesFilters(metadata)) { continue; }
      if (!ctx.passesRepoScope(childPath)) { continue; }

      // Submodule roots are shown as a custom entry (no file URI) to work around weirdness with duplicates in the tree
      if (ctx.submoduleRootPaths.has(childPath)) {
        items.push(new SubmoduleEntryItem(fullPath, parentPath));
        continue;
      }

      const item = FreshFileItem.forFile(
        uri, ctx.openChangesMode,
        metadata.isDeleted ?? false,
        metadata.commitHash,
        metadata.isPending ?? false,
        metadata.status,
        metadata.renameSource,
      );
      item.description = formatFileDescription(metadata, descriptionFormat);
      item.tooltip = formatFileTooltip(metadata, descriptionFormat);
      items.push(item);
    } else {
      // Directory — stats already respect filters and scopes
      const stats = dirStats.get(childPath);
      if (!stats || stats.count === 0) { continue; }

      const relativeDepth = getRelativeDepth(fullPath, ctx.workspaceFolders);
      const shouldExpand = relativeDepth < autoExpandDepth;
      const item = FreshFileItem.forDirectory(uri, ctx.openChangesMode, stats.count, shouldExpand);

      if (stats.mostRecent) {
        const lineChanges = descriptionFormat.showLineChanges && (stats.linesAdded > 0 || stats.linesDeleted > 0)
          ? { added: stats.linesAdded, deleted: stats.linesDeleted }
          : undefined;
        item.description = formatGroupDescription(stats.count, lineChanges?.added, lineChanges?.deleted);
        item.tooltip = formatDirectoryTooltip(stats.count, stats.mostRecent, lineChanges?.added, lineChanges?.deleted);
      }
      items.push(item);
    }
  }

  FreshFileItemSorter.sort(
    items,
    ctx.sortOrder,
    (item) => {
      if (item instanceof SubmoduleEntryItem) {
        return ctx.freshFiles.get(asAbsolutePath(item.submoduleFsPath))?.date;
      }
      return item.isDirectory
        ? dirStats.get(asAbsolutePath(item.resourceUri.fsPath))?.mostRecent
        : ctx.freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date;
    },
    (item) => {
      if (item instanceof SubmoduleEntryItem) {
        return ctx.freshFiles.get(asAbsolutePath(item.submoduleFsPath))?.author || "";
      }
      return item.isDirectory
        ? ""
        : (ctx.freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || "");
    },
  );

  return items;
}

/** Build the "Flat List" children of a repo node. */
export function buildFlatList(repoFsPath: string, ctx: TreeBuildContext): FreshFileItem[] {
  const normalizedRepoPath = asAbsolutePath(normalizePath(repoFsPath));
  const descriptionFormat = ConfigService.getDescriptionFormat();
  const items: FreshFileItem[] = [];
  // Evaluate files.exclude relative to this node's workspace folder (per-node,
  // most-specific owner — see buildTree for why first-match is wrong here).
  // Undefined when the feature is off → the per-file check below is skipped.
  const nodeFolder = ctx.filesExcludeFilter.enabled
    ? findOwningFolder(normalizePath(normalizedRepoPath), ctx.workspaceFolders)
    : undefined;

  for (const [filePath, metadata] of ctx.freshFiles) {
    if (!filePath.startsWith(normalizedRepoPath + "/") && filePath !== normalizedRepoPath) {
      continue;
    }
    if (!ctx.filterManager.passesFilters(metadata)) { continue; }
    if (!ctx.passesRepoScope(filePath)) { continue; }
    if (nodeFolder && ctx.filesExcludeFilter.isExcludedUnder(filePath, nodeFolder)) { continue; }

    const uri = vscode.Uri.file(filePath);
    const item = FreshFileItem.forFile(
      uri,
      ctx.openChangesMode,
      metadata.isDeleted ?? false,
      metadata.commitHash,
      metadata.isPending ?? false,
      metadata.status,
      metadata.renameSource,
    );
    if (ConfigService.getFlatListLabelStyle() === "filename") {
      item.label = path.basename(filePath);
      const dirRel = normalizePath(path.relative(repoFsPath, path.dirname(filePath)));
      const fileDesc = formatFileDescription(metadata, descriptionFormat);
      item.description = dirRel ? `${dirRel}  ${fileDesc}` : fileDesc;
    } else {
      // "path" (default): repo-relative path as label.
      item.label = normalizePath(path.relative(repoFsPath, filePath));
      item.description = formatFileDescription(metadata, descriptionFormat);
    }
    item.tooltip = formatFileTooltip(metadata, descriptionFormat);
    items.push(item);
  }

  FreshFileItemSorter.sort(
    items,
    ctx.sortOrder,
    (item) => item.resourceUri ? ctx.freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date : undefined,
    (item) => item.resourceUri ? (ctx.freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || "") : "",
  );

  return items;
}
