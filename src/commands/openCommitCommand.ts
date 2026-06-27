import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log, showError, showInfo } from "../extension/logger";
import { gitUri } from "../git/gitOperations";
import { getCommitChanges, getCommitParent, getCommitSubject } from "../git/gitCommitQueries";
import { asAbsolutePath } from "../pathTypes";
import { findRepoForFile } from "../utils/pathUtils";
import { normalizePath } from "../utils";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";
import { shortSha } from "../utils/formatUtils";

/**
 * Open a commit's changes (parent ↔ commit) in VS Code's multi-diff editor.
 * `revealTargetFsPath` scrolls to that file's diff when given.
 */
async function openCommitMultiDiff(repoRoot: string, commitHash: string, revealTargetFsPath?: string): Promise<void> {
  log(`Open commit: ${commitHash}`);
  try {
    const parentHash = await getCommitParent(repoRoot, commitHash);
    const shortHash = shortSha(commitHash);
    const title = `${shortHash} - ${await getCommitSubject(repoRoot, commitHash)}`;

    const changes = await getCommitChanges(repoRoot, commitHash);
    if (changes.length === 0) {
      showInfo(`No changes found in commit ${shortHash}.`);
      return;
    }

    const baseRef = parentHash ?? commitHash;
    const revealTarget = revealTargetFsPath ? normalizePath(revealTargetFsPath) : undefined;
    let reveal: { modifiedUri: vscode.Uri } | undefined;

    const resources = changes.map(change => {
      const fileUri = vscode.Uri.file(path.join(repoRoot, change.filePath));
      // A → add (no base side); D → delete (no commit side); R/C → base is the source path.
      const originalUri = change.status === "A"
        ? undefined
        : gitUri(vscode.Uri.file(path.join(repoRoot, change.originalFilePath ?? change.filePath)), baseRef);
      const modifiedUri = change.status === "D" ? undefined : gitUri(fileUri, commitHash);
      if (modifiedUri && revealTarget && normalizePath(path.join(repoRoot, change.filePath)) === revealTarget) {
        reveal = { modifiedUri };
      }
      return { originalUri, modifiedUri };
    });

    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${repoRoot}/${parentHash ?? "root"}..${commitHash}`,
    });
    log(`Opening multi-diff editor for commit ${shortHash} with ${resources.length} files`);
    await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", { multiDiffSourceUri, title, resources, reveal });
  } catch (error: any) {
    showError(`Failed to open commit: ${error.message}`, `Failed to open commit ${commitHash}: ${error.message}`);
  }
}

/** Open a commit's changes given its hash + repo root. */
export async function openCommitByHash(commitHash: string, repoRoot: string): Promise<void> {
  await openCommitMultiDiff(repoRoot, commitHash);
}

/** Open a commit's changes from a file row, revealing that file's diff. */
export async function handleOpenCommit(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (!item?.commitHash) {
    log("Open commit: no commit hash available", "warn");
    return;
  }
  const filePath = asAbsolutePath(normalizePath(item.resourceUri.fsPath));
  const folder = findWorkspaceFolderForPath(filePath, freshFileProvider.workspaceFolders);
  if (!folder) {
    log(`Open commit: could not find workspace folder for ${filePath}`, "warn");
    return;
  }
  const repoLocation = findRepoForFile(folder, normalizePath(path.relative(folder.path, filePath)));
  if (!repoLocation) {
    log(`Open commit: could not find repo for ${filePath}`, "warn");
    return;
  }
  await openCommitMultiDiff(repoLocation.repoFullPath, item.commitHash, item.resourceUri.fsPath);
}

/**
 * Open-commit for a commit *header* row in the grouped-by-commit view. The
 * header has no real file: the hash is in its synthetic URI path and the repo
 * it's nested under is `groupRepoScope`.
 */
export async function handleOpenCommitGroup(item: FreshFileItem | undefined): Promise<void> {
  const commitHash = item?.resourceUri.path.replace(/^\//, "");
  if (!commitHash || !item?.groupRepoScope) {
    log("Open commit (header): missing commit hash or repo scope on the item", "warn");
    return;
  }
  await openCommitByHash(commitHash, item.groupRepoScope);
}

/** One uncommitted file to diff HEAD ↔ working tree. `status` is normalized (A/M/D/R/T/U). */
export interface PendingDiffEntry {
  absolutePath: string;
  repoFullPath: string;
  /** Repo-relative current path. */
  pathInRepo: string;
  /** Repo-relative pre-rename path, for renames. */
  renameSource?: string;
  status: string;
}

/**
 * Open a multi-diff editor showing HEAD ↔ working tree for uncommitted files.
 * Shared by the Branch Compare pending bucket and the Fresh Files "(Pending)"
 * group — both pass normalized statuses so the add/delete/rename sides match.
 */
export async function openPendingChangesMultiDiff(
  entries: PendingDiffEntry[],
  opts: { title: string; sourceKey: string },
): Promise<void> {
  if (entries.length === 0) {
    showInfo("No pending changes.");
    return;
  }
  // original = file at HEAD (renames track the pre-rename path); modified =
  // working tree. New files (A/U) have no HEAD side; deletions have no working side.
  const resources = entries.map(e => {
    const wtUri = vscode.Uri.file(e.absolutePath);
    const headRelPath = e.renameSource ?? e.pathInRepo;
    const headUri = gitUri(vscode.Uri.file(path.join(e.repoFullPath, headRelPath)), "HEAD");
    const noOriginal = e.status === "A" || e.status === "U";
    const noModified = e.status === "D";
    return {
      originalUri: noOriginal ? undefined : headUri,
      modifiedUri: noModified ? undefined : wtUri,
    };
  });

  // Stable per-scope source URI so reopening reuses the editor (no scheme
  // resolver needed — passing `resources` makes the editor use them directly).
  const multiDiffSourceUri = vscode.Uri.from({
    scheme: "fresh-file-explorer-changes",
    path: `/pending/${encodeURIComponent(opts.sourceKey)}`,
  });
  log(`Opening ${entries.length} pending change(s) in a multi-diff editor: ${opts.title}`);
  await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri,
    title: opts.title,
    resources,
  });
}

/** Normalize a `git status` XY porcelain code to a single status letter. */
function normalizeXyStatus(xy: string | undefined): string {
  if (!xy) { return "M"; }
  if (xy === "??") { return "U"; }
  if (xy.includes("D")) { return "D"; }
  if (xy.includes("R")) { return "R"; }
  if (xy.includes("A")) { return "A"; }
  if (xy.includes("T")) { return "T"; }
  return "M";
}

/**
 * Multi-diff (HEAD ↔ working) of a Fresh Files "(Pending)" bucket — scoped to
 * the one repo the bucket is nested under (`groupRepoScope`). Each file's repo
 * and repo-relative path is resolved to build the HEAD side.
 */
export async function handleOpenPendingGroup(
  item: FreshFileItem | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  // The Pending bucket is nested per repo, so scope to that repo's pending files.
  const repoScope = item?.groupRepoScope;
  const scopePrefix = repoScope ? (repoScope.endsWith("/") ? repoScope : repoScope + "/") : undefined;
  const entries: PendingDiffEntry[] = [];
  for (const [absPath, metadata] of freshFileProvider.freshFiles) {
    if (!metadata.isPending) { continue; }
    if (scopePrefix && !(absPath === repoScope || (absPath as string).startsWith(scopePrefix))) { continue; }
    const folder = findWorkspaceFolderForPath(absPath, freshFileProvider.workspaceFolders);
    if (!folder) { continue; }
    const rel = normalizePath(path.relative(folder.path, absPath));
    const repoLocation = findRepoForFile(folder, rel);
    if (!repoLocation) { continue; }
    entries.push({
      absolutePath: absPath,
      repoFullPath: repoLocation.repoFullPath,
      pathInRepo: repoLocation.filePathInRepo,
      renameSource: metadata.renameSource,
      status: normalizeXyStatus(metadata.status),
    });
  }
  await openPendingChangesMultiDiff(entries, { title: "Pending changes", sourceKey: "freshfiles-pending" });
}
