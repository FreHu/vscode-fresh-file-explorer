import * as vscode from "vscode";
import * as path from "path";

import { BranchCompareProvider } from "./branchCompareProvider";
import { BaselineService } from "../baseline/baselineService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import {
  BranchCompareFileItem,
  BranchCompareFolderItem,
  RepoSectionItem,
} from "./branchCompareTreeItems";
import { ChangedFile, collectFilesIn } from "./branchCompareData";
import { HEAD_SOURCE, SavedComparisonsService } from "./savedComparisonsService";
import { DiffMode } from "./branchCompareConstants";
import {
  execGitWithArgs,
  fileExistsAtRef,
  getAvailableBranches,
  getMergeBase,
  gitUri,
} from "../git/gitOperations";
import { openDiff, normalizePath } from "../utils";
import { findRepoForAbsolutePath, toRelativePaths } from "../utils/pathUtils";
import { log, showError, showInfo } from "../extension/logger";
import { AbsolutePath } from "../pathTypes";
import { ConfigService } from "../config/configService";
import { confirmBulkAction } from "../utils/confirmations";
import { showPathFormatQuickPick } from "../utils/quickPick";
import { buildFileTree, renderFileTree } from "../commands/copyPathCommands";

/**
 * Open the click-target for a branch-compare file item:
 *  - Modified / Added / Renamed / Type-changed → diff editor (baseline ↔ working tree)
 *  - Deleted → read-only view of the baseline content (no current file to diff against)
 *  - Untracked → just open the file (nothing on the baseline side)
 */
export async function handleBranchCompareOpen(item: BranchCompareFileItem | undefined): Promise<void> {
  if (!item) { return; }
  await openOneAsDiff(item.file, item.sourceRef, item.targetRef, { preserveFocus: false }, item.diffMode);
}

interface OpenDiffOptions {
  preserveFocus?: boolean;
  viewColumn?: vscode.ViewColumn;
}

/**
 * Open a single changed file as a diff (or appropriate fallback for
 * deleted / untracked / added cases). Shared by the click handler and the
 * "Open All Changes" bulk action — `preserveFocus` lets the bulk path keep
 * focus on the tree.
 *
 * `sourceRef` is the "newer" side of the comparison. `"HEAD"` is the sentinel
 * that means "the working tree" — so the diff includes uncommitted changes
 * and we open a `file://` URI. Any other ref (a branch, tag, or SHA) is
 * loaded read-only via a `git:` URI so the diff truly reflects that ref's
 * content even when the user isn't currently checked out on it.
 */
async function openOneAsDiff(
  file: ChangedFile,
  sourceRef: string,
  baseRef: string,
  options: OpenDiffOptions = {},
  diffMode: DiffMode = "merge",
): Promise<void> {
  const preserveFocus = options.preserveFocus ?? false;
  const viewColumn = options.viewColumn;

  if (!baseRef) {
    showError("Branch compare: no baseline configured for this file.", true);
    return;
  }

  // Untracked → just open the file. There's no baseline-side counterpart.
  // Untracked files only exist in working-tree-overlay mode (source === HEAD).
  if (file.status === "U") {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file.absolutePath), {
      preserveFocus,
      viewColumn,
    });
    return;
  }

  // The diff base must match how the tree computed this comparison's file set (full/merge-base)
  // Merge-base is re-derived from the comparison's actual source — not HEAD.
  // They diverge when the comparison is against a branch the user isn't on
  // (e.g. `feat-x vs origin/main` while checked out on `main`).
  let baseSha: string;
  if (diffMode === "full") {
    baseSha = baseRef;
  } else {
    try {
      baseSha = await getMergeBase(file.repoFullPath, sourceRef, baseRef);
    } catch (err) {
      showInfo(
        `Could not find a common ancestor between ${sourceRef} and ${baseRef}.`,
        `Branch compare open: no common ancestor between ${sourceRef} and ${baseRef} — ${err}`,
      );
      return;
    }
  }

  const workingTreeUri = vscode.Uri.file(file.absolutePath);
  // The right-side URI is the working tree when source === HEAD (includes
  // uncommitted changes), otherwise the source ref's content at that path.
  const sourceIsWorkingTree = sourceRef === HEAD_SOURCE;
  const sourceUri = sourceIsWorkingTree ? workingTreeUri : gitUri(workingTreeUri, sourceRef);
  const sourceLabel = sourceIsWorkingTree ? "working tree" : sourceRef;

  if (file.status === "D") {
    // Deleted file: open the baseline content in a read-only git: URI.
    const baselineUri = gitUri(workingTreeUri, baseSha);
    await vscode.commands.executeCommand(
      "vscode.open",
      baselineUri,
      { preserveFocus, preview: false, viewColumn },
      `${file.pathInRepo} (${baseRef} baseline)`,
    );
    return;
  }

  // For renames, the baseline-side path is the rename source.
  const baselineRelPath = file.renameSource ?? file.pathInRepo;
  const baselineFsUri = vscode.Uri.file(path.join(file.repoFullPath, baselineRelPath));

  if (!(await fileExistsAtRef(file.repoFullPath, baseSha, baselineRelPath))) {
    // File didn't exist at baseline (added) — no diff possible. Just open
    // the source-side content (working tree for HEAD-source, otherwise the
    // ref's snapshot).
    await vscode.commands.executeCommand("vscode.open", sourceUri, { preserveFocus, viewColumn });
    return;
  }

  const baselineUri = gitUri(baselineFsUri, baseSha);
  // "Working tree" side preference governs source-on-left vs source-on-right.
  // Default ("right") matches VS Code's git Open Changes convention.
  const sourceOnLeft = ConfigService.getBranchCompareWorkingTreeSide() === "left";
  const leftUri = sourceOnLeft ? sourceUri : baselineUri;
  const rightUri = sourceOnLeft ? baselineUri : sourceUri;
  const title = sourceOnLeft
    ? `${file.pathInRepo} (${sourceLabel} ↔ ${baseRef} baseline)`
    : `${file.pathInRepo} (${baseRef} baseline ↔ ${sourceLabel})`;
  if (viewColumn !== undefined) {
    // openDiff doesn't carry a viewColumn — use vscode.diff directly.
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
      preserveFocus,
      viewColumn,
    });
  } else {
    await openDiff(leftUri, rightUri, title, { preserveFocus });
  }
}

/**
 * Open the file in the editor (skip the diff). Used by the inline action /
 * context menu when the user wants the file directly.
 */
export async function handleBranchCompareOpenFile(item: BranchCompareFileItem | undefined): Promise<void> {
  if (!item) { return; }
  if (item.file.status === "D") {
    // No working-tree file to open — fall back to the baseline view.
    return handleBranchCompareOpen(item);
  }
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.file.absolutePath));
}

/** Open the diff in a side editor column */
export async function handleBranchCompareOpenToSide(item: BranchCompareFileItem | undefined): Promise<void> {
  if (!item) { return; }
  await openOneAsDiff(item.file, item.sourceRef, item.targetRef, { viewColumn: vscode.ViewColumn.Beside }, item.diffMode);
}

/**
 * Open the read-only baseline-side content of a file (no diff). Useful when
 * the user wants to look at "what did this look like before" without the
 * visual noise of a diff editor. For untracked files there is no baseline
 * version to open — silently fall back to opening the working-tree file.
 */
export async function handleBranchCompareOpenAtBaseline(item: BranchCompareFileItem | undefined): Promise<void> {
  if (!item) { return; }
  const file = item.file;
  if (file.status === "U") {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file.absolutePath));
    return;
  }
  if (!item.targetRef) {
    showError("Branch compare: no baseline configured for this file.", true);
    return;
  }

  // Match the comparison's diff base
  let baseSha: string;
  if (item.diffMode === "full") {
    baseSha = item.targetRef;
  } else {
    try {
      baseSha = await getMergeBase(file.repoFullPath, item.sourceRef, item.targetRef);
    } catch (err) {
      showInfo(
        `Could not find a common ancestor between ${item.sourceRef} and ${item.targetRef}.`,
        `Branch compare open-at-baseline: no common ancestor — ${err}`,
      );
      return;
    }
  }

  // For renames, the baseline-side path is the source path.
  const baselineRelPath = file.renameSource ?? file.pathInRepo;

  if (!(await fileExistsAtRef(file.repoFullPath, baseSha, baselineRelPath))) {
    showInfo(`${file.pathInRepo} did not exist at ${item.targetRef}.`);
    return;
  }

  const baselineFsUri = vscode.Uri.file(path.join(file.repoFullPath, baselineRelPath));
  const baselineUri = gitUri(baselineFsUri, baseSha);
  await vscode.commands.executeCommand(
    "vscode.open",
    baselineUri,
    undefined,
    `${file.pathInRepo} (${item.targetRef} baseline)`,
  );
}

/**
 * Reveal a file from the Branch Compare tree in the Fresh Files tree.
 * Cross-view navigation — useful when a file showed up in Branch Compare
 * (because it's part of the branch's diff) and the user wants to see what
 * else is around it from the time-window perspective.
 *
 * When the file isn't currently in the Fresh Files view (filtered out,
 * outside the active time window, etc.), surface a hint so the user knows
 * why the reveal silently no-op'd.
 */
export async function handleBranchCompareRevealInFreshFiles(
  item: BranchCompareFileItem | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (!item) { return; }
  const uri = vscode.Uri.file(item.file.absolutePath);
  const ok = await freshFileProvider.revealFileByUri(uri, true);
  if (!ok) {
    showInfo(
      `${path.basename(item.file.absolutePath)} is filtered out or outside the time window.`,
    );
  }
}

/**
 * Toggle the `active` flag on the comparison the section represents. Hides
 * the section from the tree (active=false) without deleting the underlying
 * saved comparison — the user can re-activate it from the settings panel.
 */
export async function handleBranchCompareToggleActive(
  arg: RepoSectionItem | undefined,
  savedComparisons: import("./savedComparisonsService").SavedComparisonsService,
): Promise<void> {
  if (!(arg instanceof RepoSectionItem)) { return; }
  if (!arg.comparisonId) { return; }
  const cmp = savedComparisons.getById(arg.comparisonId);
  if (!cmp) { return; }
  savedComparisons.update(cmp.id, { active: !cmp.active });
}

/**
 * Swap `source` ↔ `target` on the comparison the section represents. The
 * `update()` call drops `isHeatmapBaseline` automatically if HEAD ends up on
 * the target side — heatmap requires source === HEAD.
 */
export async function handleBranchCompareSwapSides(
  arg: RepoSectionItem | undefined,
  savedComparisons: SavedComparisonsService,
): Promise<void> {
  if (!(arg instanceof RepoSectionItem)) { return; }
  if (!arg.comparisonId) { return; }
  const cmp = savedComparisons.getById(arg.comparisonId);
  if (!cmp) { return; }
  savedComparisons.update(cmp.id, { source: cmp.target, target: cmp.source });
}

/** Re-fetch the diff for a single section (cheaper than full-tree refresh). */
export async function handleBranchCompareRefreshRepo(
  arg: RepoSectionItem | undefined,
  provider: BranchCompareProvider,
): Promise<void> {
  if (!(arg instanceof RepoSectionItem)) { return; }
  if (!arg.comparisonId) { return; }
  await provider.refreshComparison(arg.comparisonId, true);
}

/**
 * Restore a deleted file (or files) to the baseline version. Runs
 * `git restore --source=<mergeBase> -- <path>` per file so the working tree
 * gains the baseline content as an unstaged change.
 *
 * Scoped to **deleted** files (status `D`) only in v1 — restore on a modified
 * file would silently discard work, and on an added file would delete the new
 * file. Both deserve their own dedicated commands rather than living under
 * the same "Restore" affordance.
 *
 * Groups by repo so the merge-base is computed once per repo, not per file.
 */
export async function handleBranchCompareRestoreFromBaseline(
  arg: BranchCompareFileItem | undefined,
  selectedItems: BranchCompareFileItem[] | undefined,
  provider: BranchCompareProvider,
  baselineService: BaselineService,
): Promise<void> {
  const items: BranchCompareFileItem[] = (selectedItems && selectedItems.length > 0)
    ? selectedItems
    : (arg ? [arg] : []);
  const deleted = items.filter(i => i instanceof BranchCompareFileItem && i.file.status === "D");
  if (deleted.length === 0) { return; }

  // Confirm because this writes to the working tree. Match the wording style of
  // the existing destructive prompts (`handleDeleteFile`, `handleResurrect`).
  const message = deleted.length === 1
    ? `Restore "${deleted[0].file.pathInRepo}" from ${deleted[0].targetRef}?`
    : `Restore ${deleted.length} files from baseline?`;
  const confirmed = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail: "Files will be written into the working tree as unstaged changes." },
    "Restore",
  );
  if (confirmed !== "Restore") { return; }

  // Group by repo so we resolve the merge-base only once per repo.
  const byRepo = new Map<string, BranchCompareFileItem[]>();
  for (const item of deleted) {
    const repo = item.file.repoFullPath;
    const list = byRepo.get(repo) ?? [];
    list.push(item);
    byRepo.set(repo, list);
  }

  const refreshTargets = new Set<string>();
  let successCount = 0;
  const errors: string[] = [];

  for (const [repoFullPath, repoItems] of byRepo.entries()) {
    const baseRef = repoItems[0].targetRef;
    const sourceRef = repoItems[0].sourceRef;
    let mergeBaseSha: string;
    try {
      mergeBaseSha = await baselineService.getMergeBase(repoFullPath, baseRef, sourceRef);
    } catch (err) {
      log(`branchCompare: merge-base resolution failed for ${repoFullPath} ${sourceRef}..${baseRef} — ${err}`, "warn");
      errors.push(`${path.basename(repoFullPath)} (no common ancestor with ${baseRef})`);
      continue;
    }

    for (const item of repoItems) {
      const relPath = item.file.renameSource ?? item.file.pathInRepo;
      try {
        await execGitWithArgs(
          ["restore", "--source=" + mergeBaseSha, "--", relPath],
          repoFullPath,
          { timeout: ConfigService.getGitTimeoutMs() },
        );
        log(`branchCompare: restored ${relPath} from ${baseRef}`);
        successCount++;
        refreshTargets.add(repoFullPath);
      } catch (err) {
        log(`branchCompare: restore failed for ${relPath} — ${err}`, "warn");
        errors.push(`${item.file.pathInRepo}`);
      }
    }
  }

  // Refresh affected repos so the tree updates and the file disappears
  // (status flips from D to clean once the working tree has it back).
  for (const repo of refreshTargets) {
    void provider.refreshComparisonsForRepo(repo);
  }

  if (successCount > 0 && errors.length === 0) {
    showInfo(`Restored ${successCount} file(s) from baseline.`);
  } else if (errors.length > 0) {
    showError(`Failed to restore: ${errors.join(", ")}`, true);
  }
}

// ── Copy Subtree Structure ──────────────────────────────────────────────────

/**
 * Markdown-list rendering of every changed file in a folder subtree. Same
 * output shape as the Fresh Files version of this command — folders before
 * files, alphabetical within each group, two-space indentation per level.
 */
export async function handleBranchCompareCopySubtreeStructure(
  arg: BranchCompareFolderItem | RepoSectionItem | undefined,
  provider: BranchCompareProvider,
): Promise<void> {
  let files: ChangedFile[] = [];
  let rootAbsPath = "";
  if (arg instanceof BranchCompareFolderItem) {
    files = collectFilesIn(arg.node);
    rootAbsPath = path.join(arg.repoFullPath, arg.node.pathInRepo);
  } else if (arg instanceof RepoSectionItem) {
    if (!arg.comparisonId) { return; }
    const cmp = provider.getComparison(arg.comparisonId);
    if (!cmp || !cmp.tree) { return; }
    files = collectFilesIn(cmp.tree);
    rootAbsPath = arg.repoFullPath;
  } else {
    return;
  }
  if (files.length === 0) {
    showInfo("No changes in this subtree.");
    return;
  }

  const choice = await showPathFormatQuickPick();
  if (!choice) { return; }

  const absolutePaths = files.map(f => f.absolutePath);
  const folderPath = normalizePath(rootAbsPath);
  const tree = buildFileTree(absolutePaths, folderPath);
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const getLabel = (absPath: string): string => {
    if (choice === "absolute") { return absPath; }
    if (choice === "relative") { return toRelativePaths([absPath], workspaceFolders)[0] ?? absPath; }
    return path.basename(absPath);
  };
  const text = renderFileTree(tree, getLabel);
  await vscode.env.clipboard.writeText(text);
  showInfo(`Copied subtree structure (${files.length} file(s)).`);
}

/**
 * Set or change the baseline ref for one repo (or for every repo when invoked
 * from the view title with no specific repo target).
 *
 * Picker UX: lists branches sorted by recent committer date, mirroring the
 * blame heatmap's branch picker.
 */
export async function handleSetBaseline(
  arg: RepoSectionItem | undefined,
  baselineService: BaselineService,
  freshFileProvider: FreshFileProvider,
  savedComparisons: SavedComparisonsService,
): Promise<void> {
  let repoFullPath: AbsolutePath | undefined;
  let comparisonId: string | undefined;
  if (arg instanceof RepoSectionItem) {
    repoFullPath = arg.repoFullPath;
    comparisonId = arg.comparisonId;
  } else {
    repoFullPath = await pickRepoForBaseline(freshFileProvider);
    if (!repoFullPath) { return; }
  }

  let branches;
  try {
    branches = await getAvailableBranches(repoFullPath);
  } catch (err) {
    showError(
      "Branch compare: failed to list branches.",
      `Branch compare: getAvailableBranches failed — ${err}`,
    );
    return;
  }
  if (branches.length === 0) {
    showInfo("Branch compare: no branches found in this repo.");
    return;
  }

  // When invoked from a section, "current" is that section's own target ref.
  // Without a section (palette / title-bar) we fall back to the repo's
  // heatmap-baseline ref — the legacy meaning of the command.
  const sectionTarget = comparisonId
    ? savedComparisons.getById(comparisonId)?.target
    : undefined;
  const current = sectionTarget ?? baselineService.getBaseRef(repoFullPath);

  const picked = await vscode.window.showQuickPick(
    branches.map(b => ({
      label: b.name,
      description: b.relativeDate,
      detail: current === b.name ? "current baseline" : undefined,
    })),
    {
      placeHolder: current
        ? `Pick a baseline (current: ${current})`
        : "Pick a baseline branch / tag",
      title: "Branch Compare: Set Baseline",
    },
  );
  if (!picked) { return; }

  if (comparisonId) {
    // Section context: change THIS section's target. Routing through
    // baselineService.setBaseRef would *create a new comparison* (its real
    // job is the heatmap-baseline flow), not update the clicked section.
    savedComparisons.update(comparisonId, { target: picked.label });
    log(`branchCompare: section ${comparisonId} target set to ${picked.label}`);
  } else {
    baselineService.setBaseRef(repoFullPath, picked.label);
    log(`branchCompare: baseline for ${repoFullPath} set to ${picked.label}`);
  }
}

/** Clear the saved baseline for the targeted repo. */
export async function handleClearBaseline(
  arg: RepoSectionItem | undefined,
  baselineService: BaselineService,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  let repoFullPath: AbsolutePath | undefined;
  if (arg instanceof RepoSectionItem) {
    repoFullPath = arg.repoFullPath;
  } else {
    repoFullPath = await pickRepoForBaseline(freshFileProvider, /*onlyWithBaseline*/ true, baselineService);
    if (!repoFullPath) { return; }
  }
  baselineService.clearBaseRef(repoFullPath);
  log(`branchCompare: baseline cleared for ${repoFullPath}`);
}

/** Manual refresh — re-runs the diff for every section. */
export async function handleBranchCompareRefresh(provider: BranchCompareProvider): Promise<void> {
  await provider.refreshAll();
}

/**
 * Open every changed file in the targeted scope (repo section or folder
 * subtree) in a single multi-diff editor. Above {@link OPEN_ALL_CONFIRM_THRESHOLD}
 * files the user gets a modal confirmation — same UX as `handleOpenAllFoundFiles`.
 *
 * A multi-diff editor (not N tabs) means zero flicker and one editor to close.
 * Diffs lazy-load as you scroll, so large scopes stay cheap.
 */
export async function handleBranchCompareOpenAll(
  arg: RepoSectionItem | BranchCompareFolderItem | undefined,
  provider: BranchCompareProvider,
): Promise<void> {
  let files: ChangedFile[] = [];
  let sourceRef = "";
  let baseRef = "";
  let diffMode: DiffMode = "merge";
  let repoFullPath = "" as AbsolutePath;
  let scopeLabel = "";
  let scopeKey = "";

  if (arg instanceof RepoSectionItem) {
    if (!arg.comparisonId) { return; }
    const cmp = provider.getComparison(arg.comparisonId);
    if (!cmp || !cmp.files) { return; }
    files = cmp.files;
    sourceRef = cmp.source;
    baseRef = cmp.target;
    diffMode = cmp.diffMode;
    repoFullPath = cmp.repoFullPath;
    scopeLabel = arg.repoName;
    scopeKey = arg.comparisonId;
  } else if (arg instanceof BranchCompareFolderItem) {
    const cmp = provider.getComparison(arg.comparisonId);
    if (!cmp || !cmp.tree) { return; }
    files = collectFilesIn(arg.node);
    sourceRef = cmp.source;
    baseRef = cmp.target;
    diffMode = cmp.diffMode;
    repoFullPath = cmp.repoFullPath;
    scopeLabel = arg.node.pathInRepo || arg.node.name || cmp.repoName;
    scopeKey = `${arg.comparisonId}:${arg.node.pathInRepo}`;
  } else {
    return;
  }

  if (files.length === 0) {
    showInfo(`No changes in ${scopeLabel}.`);
    return;
  }

  if (!await confirmBulkAction({ count: files.length, actionLabel: "Open All" })) { return; }

  // One base for the whole scope (the diff was computed against it — see
  // refreshComparison): `full` → the target ref directly, `merge` → merge-base.
  let baseSha: string;
  if (diffMode === "full") {
    baseSha = baseRef;
  } else {
    try {
      baseSha = await getMergeBase(repoFullPath, sourceRef, baseRef);
    } catch (err) {
      showInfo(
        `Could not find a common ancestor between ${sourceRef} and ${baseRef}.`,
        `Branch compare open-all: no common ancestor — ${err}`,
      );
      return;
    }
  }

  const sourceIsWorkingTree = sourceRef === HEAD_SOURCE;
  // Build (original ↔ modified) URI pairs. A `undefined` side renders as a pure
  // add/delete. original = baseline (renames track the source path); modified =
  // working tree for HEAD-source, else the source ref's snapshot.
  const resources = files.map(file => {
    const wtUri = vscode.Uri.file(file.absolutePath);
    const baselineRelPath = file.renameSource ?? file.pathInRepo;
    const baselineUri = gitUri(vscode.Uri.file(path.join(file.repoFullPath, baselineRelPath)), baseSha);
    const sourceUri = sourceIsWorkingTree ? wtUri : gitUri(wtUri, sourceRef);
    const noOriginal = file.status === "A" || file.status === "U"; // added → no baseline side
    const noModified = file.status === "D";                        // deleted → no source side
    return {
      originalUri: noOriginal ? undefined : baselineUri,
      modifiedUri: noModified ? undefined : sourceUri,
    };
  });

  // Stable per-scope source URI so reopening reuses the editor instead of
  // stacking. The scheme has no resolver — that's fine: passing `resources`
  // makes the multi-diff editor use them directly (no resolution needed).
  const multiDiffSourceUri = vscode.Uri.from({
    scheme: "fresh-file-explorer-changes",
    path: `/${encodeURIComponent(scopeKey)}`,
  });
  const sourceLabel = sourceIsWorkingTree ? "working tree" : sourceRef;
  const title = `${scopeLabel} (${sourceLabel} ↔ ${baseRef}${diffMode === "full" ? ", full" : ""})`;

  log(`branchCompare: opening ${files.length} change(s) in a multi-diff editor for ${scopeLabel}`);
  await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
    multiDiffSourceUri,
    title,
    resources,
  });
}

/**
 * Quick-pick a repo from the workspace. Used when the user invokes set/clear
 * baseline without right-clicking on a section (e.g. from the Command Palette
 * or the view title button when no row is selected).
 */
async function pickRepoForBaseline(
  freshFileProvider: FreshFileProvider,
  onlyWithBaseline = false,
  baselineService?: BaselineService,
): Promise<AbsolutePath | undefined> {
  const candidates: { repoFullPath: AbsolutePath; label: string; description?: string }[] = [];
  for (const folder of freshFileProvider.workspaceFolders) {
    for (const repoRel of folder.gitRepos) {
      const repoFullPath = repoRel === ""
        ? folder.path
        : (path.join(folder.path, repoRel) as AbsolutePath);
      if (onlyWithBaseline && !baselineService?.getBaseRef(repoFullPath)) { continue; }
      const label = repoRel === "" ? folder.name : path.basename(repoFullPath);
      const desc = baselineService?.getBaseRef(repoFullPath);
      candidates.push({
        repoFullPath,
        label,
        description: desc ? `vs ${desc}` : undefined,
      });
    }
  }
  if (candidates.length === 0) {
    showInfo(onlyWithBaseline ? "No repos with a saved baseline." : "No git repositories found in the workspace.");
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0].repoFullPath;
  }
  const picked = await vscode.window.showQuickPick(candidates, {
    placeHolder: "Select a repository",
    title: "Branch Compare",
  });
  return picked?.repoFullPath;
}

/**
 * If the given absolute path is inside a repo with a saved baseline, return
 * that baseline ref. Used by editor open hooks to auto-apply the blame
 * baseline heatmap when launching a file from the branch-compare view.
 */
export function getBaselineRefForPath(
  baselineService: BaselineService,
  freshFileProvider: FreshFileProvider,
  absolutePath: string,
): string | undefined {
  const result = findRepoForAbsolutePath(freshFileProvider.workspaceFolders, absolutePath);
  if (!result) { return undefined; }
  return baselineService.getBaseRef(result.repoFullPath);
}
