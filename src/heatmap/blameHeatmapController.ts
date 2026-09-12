import * as vscode from "vscode";

import {
  getCommitSHAsInRange,
  getAvailableBranches,
  getBranchFileDeletedHunks,
  isFileTracked,
  fileExistsAtRef,
  runGitBlamePorcelain,
} from "../git/gitCommitQueries";
import { parseGitBlamePorcelain, parseBranchHunks } from "../git/blameDiffParsers";
import { GitApi, GitRepository } from "../git/gitExecutionListener";
import { findRepoForAbsolutePath } from "../utils/pathUtils";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { HEATMAP_BUCKET_COUNT } from "./heatmapUtils";
import {
  computeBranchWindow,
  computeAbsoluteWindow,
  detectAllNewFile,
  type BucketFn,
} from "./blameHeatmapCompute";
import { DeletionMarkers, DeletionDecoration } from "./deletionMarkers";
import { buildDecorationTypes } from "./heatmapDecorationTypes";
import { isEditorInDiff } from "./editorDiffDetection";
import { HeatmapFileState } from "./heatmapFileState";
import { formatRelativeDateLong } from "../utils/formatUtils";
import { log, showInfo, showError } from "../extension/logger";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { normalizePath } from "../utils";
import { BlameHeatmapStatusBar } from "./blameHeatmapStatusBar";
import { gitUri } from "../git/gitOperations";
import { openDiff } from "../utils";
import { BaselineService } from "../baseline/baselineService";
import { ContextManager } from "../extension/contextManager";

/** Which mode is active for a given editor file. */
export type BlameHeatmapMode = "absolute" | "branch";

/** One file's computed decorations, cached so a reopened tab repaints without recomputing.
 *  Deletion markers live in `DeletionMarkers`, keyed by the same fsPath. */
interface CachedDecorations {
  buckets: vscode.DecorationOptions[][];
  addedBuckets: vscode.DecorationOptions[][];
}

/**
 * Controls the per-editor blame heatmap feature.
 *
 * Decorates each line of a text editor with a colored gutter bar + faint
 * background wash that matches the blame age bucket of that line's last
 * commit, reusing the same `freshFileExplorer.heatmap.age*` colors as the
 * file-level heatmap.  Hovering over a line shows author, summary, and age.
 */
export class BlameHeatmapController implements vscode.Disposable {
  /**
   * One shared `TextEditorDecorationType` per bucket (age1 … age8).
   * Indexed by bucket 0–7. Modified / pre-existing-and-touched lines.
   */
  private decorationTypes: vscode.TextEditorDecorationType[];

  /**
   * Parallel set, same structure, used for **pure additions** in branch mode
   * (added1 … added8). Empty in absolute mode.
   */
  private addedDecorationTypes: vscode.TextEditorDecorationType[];

  /**
   * Active mode + cached decorations per fsPath. Cached decorations survive an
   * editor closing so reopening the tab repaints without recomputing; they are
   * dropped only when the file is forgotten. See HeatmapFileState for why the
   * two are paired.
   */
  private readonly files = new HeatmapFileState<BlameHeatmapMode, CachedDecorations>();

  /** Last mode successfully applied — used for auto-apply on new tabs. Persisted across restarts. */
  private lastUsedMode: BlameHeatmapMode | undefined;

  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly reapplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly statusBar: BlameHeatmapStatusBar;
  /** Branch-mode "deleted lines" gutter markers, per file. */
  private readonly deletions = new DeletionMarkers();
  constructor(
    private readonly freshFileProvider: FreshFileProvider,
    private readonly baselineService: BaselineService,
  ) {
    const built = buildDecorationTypes();
    this.decorationTypes = built.decorationTypes;
    this.addedDecorationTypes = built.addedDecorationTypes;

    this.statusBar = new BlameHeatmapStatusBar({
      getMode: (fsPath) => this.files.getMode(fsPath),
      getSavedRef: (editor) => this.getSavedBaseRefFor(editor),
      getBranchRef: (fsPath) => {
        const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, fsPath);
        return repoResult ? this.baselineService.getBaseRef(repoResult.repoFullPath) : undefined;
      },
    });

    // Restore last-used mode so auto-apply works immediately after a restart.
    // Baseline refs are owned by `baselineService` and read on demand.
    this.lastUsedMode = WorkspaceStateManager.getBlameHeatmapMode();

    // Re-apply cached decorations whenever an editor becomes visible again.
    // Two cases per editor:
    //  1) It's now in a diff — explicitly clear any decorations that may have
    //     leaked through from a prior regular tab. VS Code can hand back the
    //     same `TextEditor` instance when a `file://` URI gets promoted to a
    //     diff side, so the old markers can persist if we don't wipe them.
    //  2) It's a plain editor — reapply from cache (the normal restore-on-show).
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
          if (editor.document.uri.scheme !== "file") { continue; }
          if (isEditorInDiff(editor)) {
            this.clearEditorDecorations(editor);
            continue;
          }
          const cached = this.files.getCache(editor.document.uri.fsPath);
          if (cached) {
            this.applyCache(editor, cached);
          }
        }
      }),
    );

    // Auto-apply the last used mode when a new tab is opened.
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(async editor => {
        this.updateStatusBar(editor);
        this.updateMenuContext(editor);
        this.updateDeletionLinesContext(editor);
        await this.maybeAutoApply(editor);
      }),
    );

    // Re-apply heatmap when document content changes (e.g. after restore or undo).
    // Debounced per file to avoid hammering git on every keystroke.
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        const fsPath = e.document.uri.fsPath;
        if (!this.files.hasMode(fsPath)) return;
        const existing = this.reapplyTimers.get(fsPath);
        if (existing) clearTimeout(existing);
        this.reapplyTimers.set(
          fsPath,
          setTimeout(() => {
            this.reapplyTimers.delete(fsPath);
            const editor = vscode.window.visibleTextEditors.find(
              ed => ed.document.uri.fsPath === fsPath,
            );
            if (!editor) return;
            const mode = this.files.getMode(fsPath);
            if (!mode) return;
            this.deletions.disposeFor(fsPath);
            this.files.invalidateCache(fsPath);
            // Fire-and-forget from a timer: a rejection here has no caller to
            // catch it, so log-and-swallow rather than leak an unhandled rejection.
            void this.applyToEditor(editor, mode).catch(e =>
              log(`blame heatmap reapply failed: ${e instanceof Error ? e.message : String(e)}`, "error"),
            );
          }, 1500),
        );
      }),
    );

    // Rebuild decoration types when the user changes age colors or opacity.
    // Also refresh the menu context so the auto-apply submenu label flips
    // immediately when the setting is toggled from outside the picker.
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration("workbench.colorCustomizations") ||
          e.affectsConfiguration("freshFileExplorer.blameHeatmap.backgroundOpacity")
        ) {
          this.rebuildDecorationTypes();
        }
        if (e.affectsConfiguration("freshFileExplorer.blameHeatmap.autoApply")) {
          this.updateMenuContext(vscode.window.activeTextEditor);
        }
        if (e.affectsConfiguration("freshFileExplorer.statusBar.heatmap")) {
          this.updateStatusBar(vscode.window.activeTextEditor);
        }
      }),
    );

    // Theme switch (light ↔ dark ↔ high-contrast) changes which `defaults.*`
    // variant `pickDefault` resolves — rebuild so the gutter/background hex
    // matches the new theme. (overviewRulerColor uses ThemeColor and updates on its own.)
    this.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.rebuildDecorationTypes()),
    );

    // Reflect any restored saved-ref state in the right-click menu and status bar
    // for the editor that's already active at activation time. Without this, the
    // first right-click after a window reopen would show the wrong menu variant
    // until the user switches tabs.
    this.updateMenuContext(vscode.window.activeTextEditor);
    this.updateStatusBar(vscode.window.activeTextEditor);
    this.updateDeletionLinesContext(vscode.window.activeTextEditor);

    // Auto-apply at startup: `onDidChangeActiveTextEditor` doesn't fire for
    // editors that were already active before activation, so the listener
    // never catches this case. We also have to wait until `freshFileProvider`
    // has finished repo discovery — otherwise `findRepoForAbsolutePath` returns
    // undefined and `applyToEditor` (and the menu/status-bar context resolvers)
    // bail before reading anything useful.
    const tryStartup = () => {
      // Refresh context keys + status bar first so the menu / status bar reflect
      // any saved state even if maybeAutoApply's gates skip the heatmap apply.
      const active = vscode.window.activeTextEditor;
      this.updateMenuContext(active);
      this.updateStatusBar(active);
      this.updateDeletionLinesContext(active);
      void this.maybeAutoApply(active);
    };
    if (this.freshFileProvider.areReposReady) {
      tryStartup();
    } else {
      // Fires every time repos are discovered (initial + after hardRefresh).
      // Idempotent: maybeAutoApply bails if the file is already decorated.
      this.subscriptions.push(this.freshFileProvider.onReposReady(tryStartup));
    }
  }

  /**
   * Run the last-used heatmap on `editor` if all the gates are satisfied.
   * Shared between the editor-change listener and the startup path so they
   * stay in lockstep about when auto-apply is allowed.
   *
   * Gates:
   * - editor exists and is a real file (not output channel, settings, etc.)
   * - not a diff side (the diff itself shows the changes)
   * - user enabled auto-apply
   * - we have a remembered mode
   * - file isn't already decorated
   * - in branch mode: the file's repo has a saved baseRef (no surprise picker)
   */
  private async maybeAutoApply(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== "file") return;
    if (isEditorInDiff(editor)) return;
    if (!ConfigService.getBlameHeatmapAutoApply()) return;
    if (this.lastUsedMode === undefined) return;

    const fsPath = editor.document.uri.fsPath;
    if (this.files.hasMode(fsPath)) return;

    if (this.lastUsedMode === "branch") {
      const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, fsPath);
      if (!repoResult) return;
      if (!this.baselineService.getBaseRef(repoResult.repoFullPath)) return;
    }

    await this.applyToEditor(editor, this.lastUsedMode);
  }

  /**
   * Rebuild the bucket decoration types (e.g. after a color-theme or config
   * change): clear + dispose the old types, build fresh ones from current
   * config, then re-apply cached decorations to visible editors. Deletion types
   * are per-file dynamic types and survive the rebuild unchanged.
   */
  private rebuildDecorationTypes(): void {
    // Clear old bucket decorations from all visible editors before disposing the types.
    // Deletion types are per-file dynamic types and survive the rebuild unchanged.
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
      for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    }
    for (const dt of this.decorationTypes) { dt.dispose(); }
    for (const dt of this.addedDecorationTypes) { dt.dispose(); }
    const built = buildDecorationTypes();
    this.decorationTypes = built.decorationTypes;
    this.addedDecorationTypes = built.addedDecorationTypes;
    // Re-apply from cache so active heatmaps update immediately. Skip diff
    // editors — their side is the wrong baseline to layer heatmap markers on
    // and the deletions could mislead about which ref the markers came from.
    for (const editor of vscode.window.visibleTextEditors) {
      if (isEditorInDiff(editor)) { continue; }
      const cached = this.files.getCache(editor.document.uri.fsPath);
      if (cached) {
        this.applyCache(editor, cached);
      }
    }
  }

  /**
   * Apply a blame heatmap mode for the given editor (idempotent).
   *
   * - Already in this mode: re-apply (refreshes decorations).
   * - In a different mode: clear first, then apply.
   * - Off: apply.
   *
   * To turn off, call `turnOff` — picking the same mode again no longer toggles
   * off, since the picker now exposes an explicit "Turn off" affordance.
   */
  async applyMode(editor: vscode.TextEditor, mode: BlameHeatmapMode): Promise<void> {
    const fsPath = editor.document.uri.fsPath;
    if (this.files.hasMode(fsPath)) {
      this.clearEditor(editor);
      this.files.invalidateCache(fsPath);
    }
    this.files.setMode(fsPath, mode);
    await this.applyToEditor(editor, mode);
  }

  /** Explicit off. No-op if no mode is active on this file. */
  turnOff(editor: vscode.TextEditor): void {
    const fsPath = editor.document.uri.fsPath;
    if (!this.files.hasMode(fsPath)) { return; }
    this.clearEditor(editor);
    this.forgetFile(fsPath);
    this.statusBar.setNewFile(fsPath, false);
    this.updateStatusBar(editor);
    this.updateDeletionLinesContext(editor);
  }

  /**
   * Forget the saved baseRef for the editor's repo. Branch mode will prompt
   * next time it's invoked. Doesn't touch any currently-active heatmap — the
   * decorations remain until the user re-applies.
   */
  clearSavedBaseRef(editor: vscode.TextEditor): void {
    const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, editor.document.uri.fsPath);
    if (!repoResult) { return; }
    this.baselineService.clearBaseRef(repoResult.repoFullPath);
    this.updateMenuContext(editor);
    this.updateStatusBar(editor);
  }

  /**
   * Snapshot of state the heatmap quick pick uses to compose its items.
   * Centralized so the picker stays presentation-only.
   */
  getPickerSnapshot(editor: vscode.TextEditor): {
    activeMode: BlameHeatmapMode | undefined;
    savedBaseRef: string | undefined;
    autoApply: boolean;
  } {
    return {
      activeMode: this.files.getMode(editor.document.uri.fsPath),
      savedBaseRef: this.getSavedBaseRefFor(editor),
      autoApply: ConfigService.getBlameHeatmapAutoApply(),
    };
  }

  /**
   * Apply branch mode, always showing the branch/tag picker regardless of any
   * previously persisted ref. Use this for explicit user-initiated selection.
   */
  async selectBranchMode(editor: vscode.TextEditor): Promise<void> {
    const fsPath = editor.document.uri.fsPath;
    if (this.files.hasMode(fsPath)) {
      this.clearEditor(editor);
      this.files.invalidateCache(fsPath);
    }
    this.files.setMode(fsPath, "branch");
    await this.applyToEditor(editor, "branch", { forcePickRef: true }); // always shows picker
  }

  /** Apply pre-computed decoration data to an editor instance. */
  private applyCache(editor: vscode.TextEditor, cache: CachedDecorations): void {
    for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
      editor.setDecorations(this.decorationTypes[i], cache.buckets[i]);
      editor.setDecorations(this.addedDecorationTypes[i], cache.addedBuckets[i]);
    }
    this.deletions.applyTo(editor);
  }

  /**
   * Deactivate the heatmap on a file: drop mode + cache AND dispose its
   * deletion markers. Marker types are live resources — dropping the file
   * state without disposing them leaves stale gutter badges decorating every
   * editor of the file (and leaks the types). Every bail-out path goes
   * through here so that invariant is structural.
   */
  private forgetFile(fsPath: string): void {
    this.deletions.disposeFor(fsPath);
    this.files.forget(fsPath);
  }

  /** Remove all blame heatmap decorations from an editor. */
  private clearEditor(editor: vscode.TextEditor): void {
    for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
    for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    // Disposing the deletion types removes them from all editors automatically.
    this.deletions.disposeFor(editor.document.uri.fsPath);
  }

  /**
   * Show a quick pick of all local and remote branches and return the selected
   * ref name, or `undefined` if the user cancelled.
   */
  private async pickBaseRef(repoRoot: string): Promise<string | undefined> {
    let branches;
    try {
      branches = await getAvailableBranches(repoRoot);
    } catch (err) {
      showError(
        "Branch blame heatmap: failed to list branches.",
        `Branch blame heatmap: failed to list branches — ${err}`,
      );
      return undefined;
    }

    if (branches.length === 0) {
      showInfo("Branch blame heatmap: no branches found.");
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      branches.map(b => ({ label: b.name, description: b.relativeDate })),
      { placeHolder: "Select a branch to compare against", title: "Blame Heatmap: Branch Changes" },
    );
    return picked?.label;
  }

  private async applyToEditor(
    editor: vscode.TextEditor,
    mode: BlameHeatmapMode,
    options: { forcePickRef?: boolean; baseRef?: string } = {},
  ): Promise<void> {
    const uri = editor.document.uri;
    // Non-file URI (output channel, settings, etc.) — silent no-op.
    if (uri.scheme !== "file") {
      this.forgetFile(uri.fsPath);
      return;
    }
    // Diff editors carry their own change indicators; layering blame on top is
    // duplicate signal. Silent no-op — and don't touch `activeModes`: a regular
    // tab of the same file shares this fsPath and may legitimately be decorated.
    if (isEditorInDiff(editor)) { return; }

    // Mark the mode immediately so updateStatusBar and the text-change listener
    // see the correct state even before the async git work completes.
    this.files.setMode(uri.fsPath, mode);

    const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, uri.fsPath);
    if (!repoResult) {
      this.statusBar.setWarning(uri.fsPath, "not in a git repo");
      this.forgetFile(uri.fsPath);
      this.updateStatusBar(editor);
      return;
    }

    // For branch mode: ask the user which ref to compare against before doing
    // any heavy git work, so a cancel bails out cheaply. Skip the pick if a
    // ref was already resolved (auto-apply or re-toggle with same ref).
    let baseRef: string | undefined;
    if (mode === "branch") {
      if (options.baseRef) {
        baseRef = options.baseRef;
      } else if (!options.forcePickRef) {
        baseRef = this.baselineService.getBaseRef(repoResult.repoFullPath);
      }
      if (!baseRef) {
        baseRef = await this.pickBaseRef(repoResult.repoFullPath);
        if (!baseRef) {
          this.forgetFile(uri.fsPath);
          return;
        }
      }
      if (editor.document.isClosed) {
        this.forgetFile(uri.fsPath);
        return;
      }
    }

    // Guard: skip large files to avoid slow git blame runs.
    const maxLines = ConfigService.getBlameHeatmapMaxLines();
    if (editor.document.lineCount > maxLines) {
      const msg = `Line count over config limit ${maxLines}`;
      this.statusBar.setWarning(uri.fsPath, msg);
      this.forgetFile(uri.fsPath);
      this.updateStatusBar(editor);
      return;
    }

    // From here on we hit git, so flip the spinner and clear it in finally so
    // every early-return path (errors, closed editor, untracked file) restores
    // the status bar to its post-load state.
    this.statusBar.setLoading(uri.fsPath, true);
    this.updateStatusBar(editor);
    try {

    // After every async hop the editor's mode may have flipped (user clicked
    // Turn off, switched modes, closed the tab) — bail before applying stale
    // decorations.  Closed-doc check stays bundled in here too.
    const isStale = (): boolean =>
      editor.document.isClosed || this.files.getMode(uri.fsPath) !== mode;

    // Bail out early for untracked files — git blame would fail with a fatal error.
    if (!(await isFileTracked(repoResult.repoFullPath, repoResult.filePathInRepo))) {
      return;
    }
    if (isStale()) { return; }

    let blameOutput: string;
    try {
      blameOutput = await runGitBlamePorcelain(repoResult.repoFullPath, repoResult.filePathInRepo);
    } catch (err) {
      showError(`Blame heatmap: git blame failed — ${err}`, true);
      this.forgetFile(uri.fsPath);
      return;
    }

    if (isStale()) { return; }

    const blameLines = parseGitBlamePorcelain(blameOutput);
    if (blameLines.length === 0) {
      this.statusBar.setWarning(uri.fsPath, "no blame data");
      this.forgetFile(uri.fsPath);
      this.updateStatusBar(editor);
      return;
    }

    const nowMs = Date.now();
    const rangesByBucket: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );
    let builtDeletions: DeletionDecoration[] = [];
    // Parallel bucket array for "added in this branch" lines — same buckets, different palette.
    const rangesByAddedBucket: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );

    let getBucket: BucketFn;
    let windowDays: number;
    let isAllNewFile = false;
    /** 1-based new-file line numbers that appeared as pure additions in branch mode (empty in absolute mode). */
    let addedLineNumbers = new Set<number>();

    if (mode === "branch") {
      // baseRef is guaranteed non-null here (checked above after the quick pick).
      let mergeBaseSha: string;
      try {
        mergeBaseSha = await this.baselineService.getMergeBase(repoResult.repoFullPath, baseRef!);
      } catch (err) {
        showInfo(
          `Branch blame heatmap: could not find a common ancestor with ${baseRef}.`,
          `Branch blame heatmap: no common ancestor with ${baseRef} — ${err}`,
        );
        this.forgetFile(uri.fsPath);
        return;
      }

      if (isStale()) { return; }

      // `existedAtMergeBase` distinguishes truly-new files from files that
      // existed at the merge base but had every line replaced — both produce
      // an empty pure-deletion set, so we can't tell them apart from blame
      // data alone. Run alongside the SHA range query (parallel git calls).
      const [branchCommitShas, existedAtMergeBase] = await Promise.all([
        getCommitSHAsInRange(repoResult.repoFullPath, mergeBaseSha, "HEAD"),
        fileExistsAtRef(repoResult.repoFullPath, mergeBaseSha, repoResult.filePathInRepo),
      ]);

      if (isStale()) { return; }

      const branchWindow = computeBranchWindow(blameLines, branchCommitShas, nowMs);
      windowDays = branchWindow.windowDays;
      getBucket = branchWindow.getBucket;

      log(
        `Branch blame heatmap: baseRef=${baseRef!}, mergeBase=${mergeBaseSha.slice(0, 7)}, branchCommits=${branchCommitShas.size}, branchLinesInFile=${branchWindow.branchLinesInFile}, window=${windowDays.toFixed(1)}d`,
      );

      // Fetch the branch diff once: deletions (gutter badges) + added-line set
      // + modified-line set (different tints below).
      const diffOutput = await getBranchFileDeletedHunks(
        repoResult.repoFullPath,
        mergeBaseSha,
        repoResult.filePathInRepo,
      );
      if (isStale()) { return; }
      const branchHunks = parseBranchHunks(diffOutput);
      addedLineNumbers = branchHunks.addedLines;

      builtDeletions = DeletionMarkers.build(branchHunks.deletions, editor.document.lineCount);

      isAllNewFile = detectAllNewFile(
        blameLines,
        branchCommitShas,
        existedAtMergeBase,
        builtDeletions.length > 0,
      );
    } else {
      const absoluteWindow = computeAbsoluteWindow(blameLines, nowMs);
      windowDays = absoluteWindow.windowDays;
      getBucket = absoluteWindow.getBucket;
    }

    for (const { lineIndex, timestamp, author, summary, sha } of blameLines) {
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
        continue;
      }
      const bucket = getBucket(sha, timestamp);
      if (bucket < 0) continue; // pre-branch line — no decoration in branch mode
      const relativeAge = formatRelativeDateLong(new Date(timestamp * 1000));
      const shortHash = sha.slice(0, 7);
      const commandArgs = encodeURIComponent(JSON.stringify([sha, repoResult.repoFullPath]));
      const commitLink = `[${shortHash}](command:freshFileExplorer.openCommitFromBlame?${commandArgs})`;
      const hover = new vscode.MarkdownString(
        `**${author}** · ${relativeAge} · ${commitLink}\n\n${summary}`,
      );
      hover.isTrusted = true;
      // Route pure-addition lines (branch mode) to the parallel "added" bucket
      // so a different palette can highlight them. Modifications and absolute
      // mode keep the standard age palette.
      const target = addedLineNumbers.has(lineIndex + 1) ? rangesByAddedBucket : rangesByBucket;
      target[bucket].push({
        // Full-width range, not a zero-width one at column 0: the gutter icon is
        // drawn once per *view* line the range covers, so a collapsed range
        // leaves wrapped lines with a bar only on their first screen row.
        range: new vscode.Range(lineIndex, 0, lineIndex, editor.document.lineAt(lineIndex).text.length),
        hoverMessage: hover,
      });
    }

    // Install the new markers, disposing any stale set from a previous run.
    // isAllNewFile implies builtDeletions is empty (checked by the guard).
    this.deletions.replaceFor(uri.fsPath, isAllNewFile ? [] : builtDeletions);

    if (isAllNewFile) {
      // File is entirely new on this branch — clear any stale decorations and
      // let the status bar carry the message instead.
      this.statusBar.setNewFile(uri.fsPath, true);
      for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
        editor.setDecorations(this.decorationTypes[i], []);
        editor.setDecorations(this.addedDecorationTypes[i], []);
      }
    } else {
      this.statusBar.setNewFile(uri.fsPath, false);
      for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
        editor.setDecorations(this.decorationTypes[i], rangesByBucket[i]);
        editor.setDecorations(this.addedDecorationTypes[i], rangesByAddedBucket[i]);
      }
      this.deletions.applyTo(editor);
    }

    this.statusBar.clearWarning(uri.fsPath);
    const emptyBuckets: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );
    this.files.setCache(uri.fsPath, {
      buckets: isAllNewFile ? emptyBuckets : rangesByBucket,
      addedBuckets: isAllNewFile ? emptyBuckets : rangesByAddedBucket,
    });
    // Record so auto-apply can reuse this mode + ref for subsequent tabs.
    this.lastUsedMode = mode;
    WorkspaceStateManager.setBlameHeatmapMode(mode);
    if (mode === "branch") {
      this.baselineService.setBaseRef(repoResult.repoFullPath, baseRef!);
    }
    log(
      isAllNewFile
        ? `Blame heatmap (branch): ${uri.fsPath} is entirely new since ${baseRef}`
        : `Blame heatmap (${mode}) applied to ${uri.fsPath} (${blameLines.length} lines, window=${windowDays.toFixed(1)}d)`,
    );

    } finally {
      this.statusBar.setLoading(uri.fsPath, false);
      this.updateStatusBar(editor);
      this.updateMenuContext(editor);
      this.updateDeletionLinesContext(editor);
    }
  }

  /**
   * Resolve the saved baseline ref for the editor's containing repo, if any.
   * Returns undefined when the editor isn't on a real file or the file isn't
   * inside a known git repo.
   */
  private getSavedBaseRefFor(editor: vscode.TextEditor | undefined): string | undefined {
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== "file") { return undefined; }
    const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, uri.fsPath);
    if (!repoResult) { return undefined; }
    return this.baselineService.getBaseRef(repoResult.repoFullPath);
  }

  /**
   * Drives context keys consumed by the gutter right-click menu / submenu:
   * - `hasBaseRef`  — saved baseline ref exists for this editor's repo.
   * - `active`      — heatmap is currently applied to this file.
   * - `autoApply`   — auto-apply config is on.
   */
  private updateMenuContext(editor: vscode.TextEditor | undefined): void {
    const fsPath = editor?.document.uri.fsPath;
    const active = fsPath !== undefined && this.files.hasMode(fsPath);
    ContextManager.setBlameHeatmapHasBaseRef(this.getSavedBaseRefFor(editor) !== undefined);
    ContextManager.setBlameHeatmapActive(active);
  }

  private updateStatusBar(editor: vscode.TextEditor | undefined): void {
    this.statusBar.update(editor);
  }

  /**
   * Connect the VS Code Git API so the controller can detect branch switches.
   *
   * When the user switches to the branch that was being used as the comparison
   * base in branch mode, the comparison is automatically flipped to the branch
   * they just left — so the heatmap continues to show "what changed relative to
   * where you came from" without requiring a manual re-pick.
   */
  connectGitApi(api: GitApi): void {
    /** Track the last-known branch per repo (keyed by normalized root path). */
    const prevBranchByRepo = new Map<string, string | undefined>();

    const handleRepoChange = async (repo: GitRepository) => {
      const key = normalizePath(repo.rootUri.fsPath);
      // Merge-base cache invalidation is handled by `baselineService.connectGitApi`
      // — every consumer subscribed to onDidChange picks it up there.

      const newBranch = repo.state.HEAD?.name;
      const prevBranch = prevBranchByRepo.get(key);
      prevBranchByRepo.set(key, newBranch);

      if (prevBranch === undefined || newBranch === undefined || prevBranch === newBranch) return;
      if (this.lastUsedMode !== "branch") return;
      const repoBaseRef = this.baselineService.getBaseRef(repo.rootUri.fsPath);
      if (!repoBaseRef) return;
      // Only flip when the user switches TO the branch they were comparing against.
      if (newBranch !== repoBaseRef) return;

      const newBaseRef = prevBranch;
      this.baselineService.setBaseRef(repo.rootUri.fsPath, newBaseRef);
      this.updateMenuContext(vscode.window.activeTextEditor);

      // Re-apply to all visible editors in this repo that are in branch mode.
      for (const editor of vscode.window.visibleTextEditors) {
        const editorFsPath = editor.document.uri.fsPath;
        if (this.files.getMode(editorFsPath) !== "branch") continue;
        const editorRepo = findRepoForAbsolutePath(
          this.freshFileProvider.workspaceFolders,
          editorFsPath,
        );
        if (!editorRepo || normalizePath(editorRepo.repoFullPath) !== key) continue;
        this.deletions.disposeFor(editorFsPath);
        this.files.invalidateCache(editorFsPath);
        await this.applyToEditor(editor, "branch", { baseRef: newBaseRef });
      }
    };

    const subscribeToRepo = (repo: GitRepository) => {
      prevBranchByRepo.set(normalizePath(repo.rootUri.fsPath), repo.state.HEAD?.name);
      this.subscriptions.push(repo.state.onDidChange(() => handleRepoChange(repo)));
    };

    for (const repo of api.repositories) {
      subscribeToRepo(repo);
    }
    this.subscriptions.push(api.onDidOpenRepository(repo => subscribeToRepo(repo)));
  }

  /**
   * Open a VS Code diff editor showing the current file against the merge-base
   * with a chosen branch/tag.
   *
   * Reuses the same per-repo ref the blame heatmap's branch mode uses
   * (`lastUsedBaseRefByRepo`), so the picker only appears the first time —
   * subsequent invocations diff straight against the saved ref. The ref is
   * persisted, so a later "Branch" heatmap activation finds it already set.
   */
  async openBaselineDiff(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    // Non-file URI — silent no-op (the menu's `when` already hides the entry
    // for these; this is the Command Palette / programmatic path).
    if (uri.scheme !== "file") { return; }

    const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, uri.fsPath);
    if (!repoResult) {
      this.statusBar.setWarning(uri.fsPath, "not in a git repo");
      this.updateStatusBar(editor);
      return;
    }

    let baseRef = this.baselineService.getBaseRef(repoResult.repoFullPath);
    if (!baseRef) {
      baseRef = await this.pickBaseRef(repoResult.repoFullPath);
      if (!baseRef) { return; } // user cancelled the picker
      this.baselineService.setBaseRef(repoResult.repoFullPath, baseRef);
      this.updateMenuContext(editor);
    }

    let mergeBaseSha: string;
    try {
      mergeBaseSha = await this.baselineService.getMergeBase(repoResult.repoFullPath, baseRef);
    } catch (err) {
      showInfo(
        `Could not find a common ancestor with ${baseRef}.`,
        `Blame diff: no common ancestor with ${baseRef} — ${err}`,
      );
      return;
    }

    // The file may have been added after the merge-base — `git show {ref}:{path}`
    // fails for missing blobs and the git URI resolver surfaces that as
    // "Unable to resolve nonexistent file". Pre-check so we can give a useful
    // message instead of an unexplained error in the log.
    if (!(await fileExistsAtRef(repoResult.repoFullPath, mergeBaseSha, repoResult.filePathInRepo))) {
      showInfo(
        `This file is new since ${baseRef} — nothing to diff against.`,
        `Blame diff: ${repoResult.filePathInRepo} absent at merge-base ${mergeBaseSha.slice(0, 7)} (baseRef=${baseRef})`,
      );
      return;
    }

    const baselineUri = gitUri(uri, mergeBaseSha);
    const title = `${repoResult.filePathInRepo} (${baseRef} baseline ↔ working tree)`;
    await openDiff(baselineUri, uri, title);
  }

  /**
   * Remove a specific deletion marker (by anchor line index) and refresh the
   * gutter-menu visibility. Called after a successful restore so the indicator
   * disappears without waiting for the debounced re-apply.
   */
  private dismissDeletion(fsPath: string, anchorLineIndex: number): void {
    this.deletions.dismiss(fsPath, anchorLineIndex);
    // Refresh the gutter-menu visibility set if the dismissed deletion is in the active editor.
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.fsPath === fsPath) {
      this.updateDeletionLinesContext(active);
    }
  }

  /**
   * Wipe every heatmap decoration from a specific editor instance without
   * disposing the decoration types (other editors with the same `fsPath`
   * keep their markers). Used when a `file://` editor gets reused as the
   * working-tree side of a diff and we need to scrub leftover markers.
   */
  private clearEditorDecorations(editor: vscode.TextEditor): void {
    for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
    for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    this.deletions.clearFromEditor(editor);
  }

  /**
   * Drives the `freshFileExplorer.blameHeatmap.deletionLines` context key — the array
   * of 1-based line numbers where deletion markers exist for the active editor.
   * The gutter right-click menu uses this to gate visibility of the
   * "Copy / Restore deleted lines" entries via `editorLineNumber in <key>`.
   */
  private updateDeletionLinesContext(editor: vscode.TextEditor | undefined): void {
    // Gate the gutter menu items: when the active editor is part of a diff,
    // the markers came from the blame-heatmap baseline — which may be a
    // different ref than whatever the diff editor is actually showing.
    // "Restore from baseline" there would silently resurrect lines from the
    // wrong ref. Hide the affordance instead of risking that.
    const lines = editor && !isEditorInDiff(editor)
      ? this.deletions.linesFor(editor.document.uri.fsPath)
      : [];
    ContextManager.setBlameHeatmapDeletionLines(lines);
  }

  /**
   * Apply a restore: insert `lines` after `anchorLineIndex` in the document at `uri`,
   * then dismiss the deletion marker so the gutter badge disappears.
   */
  private async applyRestoreEdit(uri: vscode.Uri, anchorLineIndex: number, lines: string[]): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    // Insert after the anchor line (or at EOF for trailing deletions).
    const insertLine = Math.min(anchorLineIndex + 1, document.lineCount);
    const insertPos = insertLine < document.lineCount
      ? new vscode.Position(insertLine, 0)
      : new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const textToInsert = lines.join(eol) + eol;
    edit.insert(uri, insertPos, textToInsert);
    await vscode.workspace.applyEdit(edit);
    // Persist to disk — `git diff` reads from the working tree, so without a
    // save the next debounced re-apply still sees the lines as missing and
    // re-stamps the marker.
    await document.save();
    this.dismissDeletion(uri.fsPath, anchorLineIndex);
  }

  /**
   * Look up the deletion at the given 1-based line in the active editor's cache
   * and restore it. Invoked by the gutter right-click menu.
   */
  async restoreDeletionAt(uri: vscode.Uri, lineNumber1Based: number): Promise<void> {
    // Belt-and-suspenders: the context-key gate already hides the menu in
    // diff editors, but a keybinding or palette invocation could still reach
    // here. Refuse so the user can't accidentally restore lines from the
    // heatmap baseline while looking at a diff against a different ref.
    const active = vscode.window.activeTextEditor;
    if (active && isEditorInDiff(active)) { return; }
    const deletion = this.findDeletionAt(uri.fsPath, lineNumber1Based);
    if (!deletion) { return; }
    await this.applyRestoreEdit(uri, lineNumber1Based - 1, deletion.lines);
  }

  /**
   * Look up the deletion at the given 1-based line and copy its lines to the
   * clipboard. No notification — the gutter badge disappearing is the cue
   * (well, it doesn't here since we don't dismiss; we just copy).
   */
  async copyDeletionAt(uri: vscode.Uri, lineNumber1Based: number): Promise<void> {
    const active = vscode.window.activeTextEditor;
    if (active && isEditorInDiff(active)) { return; }
    const deletion = this.findDeletionAt(uri.fsPath, lineNumber1Based);
    if (!deletion) { return; }
    await vscode.env.clipboard.writeText(deletion.lines.join("\n"));
  }

  private findDeletionAt(fsPath: string, lineNumber1Based: number): DeletionDecoration | undefined {
    return this.deletions.findAt(fsPath, lineNumber1Based);
  }

  dispose(): void {
    for (const timer of this.reapplyTimers.values()) {
      clearTimeout(timer);
    }
    this.statusBar.dispose();
    for (const dt of this.decorationTypes) { dt.dispose(); }
    for (const dt of this.addedDecorationTypes) { dt.dispose(); }
    this.deletions.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
  }
}
