import * as vscode from "vscode";

import {
  getCommitSHAsInRange,
  getAvailableBranches,
  getBranchFileDeletedHunks,
  isFileTracked,
  fileExistsAtRef,
  runGitBlamePorcelain,
  parseGitBlamePorcelain,
  parseBranchHunks,
} from "../git/gitOperations";
import { GitApi, GitRepository } from "../git/gitExecutionListener";
import { findRepoForAbsolutePath } from "../utils/pathUtils";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { blameTimestampToBucket, HEATMAP_BUCKET_COUNT } from "./heatmapUtils";
import { formatRelativeDateLong } from "../utils/formatUtils";
import { log, showInfo, showError } from "../extension/logger";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { normalizePath } from "../utils";
import { Commands } from "../commands/commandConstants";
import { FeatureStatusBar } from "../ui/featureStatusBar";
import { hexToRgba } from "../utils/colorUtils";
import { gitUri } from "../git/gitOperations";
import { openDiff } from "../utils";
import { BaselineService } from "../baseline/baselineService";
import { ContextManager } from "../extension/contextManager";

/** Which mode is active for a given editor file. */
export type BlameHeatmapMode = "absolute" | "branch";

/**
 * True when the given editor is one side of an open diff tab.
 *
 * Diff editors already convey what changed visually — overlaying our blame
 * heatmap on top duplicates the signal and clutters the gutter. We detect this
 * by walking `vscode.window.tabGroups` and checking whether any tab in the
 * editor's view column is a `TabInputTextDiff` whose `original` or `modified`
 * URI matches the editor's document URI.
 *
 * Duck-typed instead of `instanceof vscode.TabInputTextDiff` so it stays
 * resilient if VS Code reshapes the type.
 */
function isEditorInDiff(editor: vscode.TextEditor): boolean {
  // VS Code reports `undefined` viewColumn for diff sides — the column belongs
  // to the diff tab, not the individual TextEditor side. So if we know the
  // editor's column, restrict the scan to that group; otherwise (undefined →
  // probably a diff side) scan every group's active tab and match any diff
  // input that contains this URI.
  //
  // Only the active tab in a group renders its TextEditor(s) into
  // `visibleTextEditors`, so checking the active tab is sufficient — and
  // necessary: scanning every tab would falsely match a regular tab of the
  // same file that happens to coexist with a diff tab in the same column.
  const uriString = editor.document.uri.toString();
  const targetCol = editor.viewColumn;
  for (const group of vscode.window.tabGroups.all) {
    if (targetCol !== undefined && group.viewColumn !== targetCol) { continue; }
    const activeTab = group.activeTab;
    if (!activeTab) { continue; }
    const input = activeTab.input;
    if (!input || typeof input !== "object") { continue; }
    if ("original" in input && "modified" in input) {
      const orig = (input as { original: vscode.Uri }).original;
      const mod = (input as { modified: vscode.Uri }).modified;
      if (orig.toString() === uriString || mod.toString() === uriString) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a gutter icon URI for a given hex color.
 * Produces a 16×16 SVG with a full-height colored bar on the right edge,
 * mimicking the GitLens-style gutter indicator.
 */
function makeGutterIconUri(hexColor: string): vscode.Uri {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect x='12' y='0' width='2' height='16' fill='${hexColor.replace(/#/g, "%23")}'/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml,${svg}`);
}

/** A dynamically-created decoration type + options pair for a single deletion marker. */
interface DeletionDecoration {
  type: vscode.TextEditorDecorationType;
  options: vscode.DecorationOptions;
  /** The deleted line content, retained so gutter-menu actions can copy/restore without re-fetching. */
  lines: string[];
}

/**
 * Build a gutter icon URI for a deletion badge — a red circle containing the
 * deleted-line count (e.g. "36"). The leading minus that earlier versions
 * baked into the label was redundant (the red circle already signals deletion)
 * and ate the budget the digits needed to stay readable, so the badge now
 * shows just the number at a much larger font size.
 *
 * `viewBox` lets VS Code scale the SVG to whatever gutter width it allocates.
 */
function makeDeletionGutterIcon(count: number): vscode.Uri {
  const num = count > 999 ? "999+" : String(count);
  // Sized to fit 1–4 chars in a 16-unit circle.
  const fontSize = num.length === 1 ? 11 : num.length === 2 ? 9 : num.length === 3 ? 7 : 6;
  // Use rgb() to avoid URL-encoding issues with '#' in data URIs.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='16' height='16'>` +
    `<circle cx='8' cy='8' r='7.5' fill='rgb(248,81,73)'/>` +
    `<text x='8' y='8' text-anchor='middle' dominant-baseline='central' ` +
    `fill='white' font-size='${fontSize}' font-family='sans-serif' font-weight='bold'>${num}</text>` +
    `</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml,${svg}`);
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
   * Cached decoration options per fsPath — kept until the user explicitly
   * toggles off, so decorations can be re-applied when an editor reappears.
   */
  private readonly decorationCache = new Map<
    string,
    {
      buckets: vscode.DecorationOptions[][];
      addedBuckets: vscode.DecorationOptions[][];
      deletions: DeletionDecoration[];
    }
  >();

  /** Tracks which mode is currently active per fsPath. */
  private readonly activeModes = new Map<string, BlameHeatmapMode>();

  /** Last mode successfully applied — used for auto-apply on new tabs. Persisted across restarts. */
  private lastUsedMode: BlameHeatmapMode | undefined;

  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly reapplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly statusBar: FeatureStatusBar;
  /** fsPath → user-visible problem text (e.g. "file too large"). Cleared on editor change. */
  private readonly statusBarWarnings = new Map<string, string>();
  /** fsPath set for branch-mode files where every line is new (no pre-branch content). */
  private readonly statusBarNewFiles = new Set<string>();
  /** fsPath set for files whose heatmap is currently being computed (drives the spinner state). */
  private readonly loadingFsPaths = new Set<string>();
  constructor(
    private readonly freshFileProvider: FreshFileProvider,
    private readonly baselineService: BaselineService,
  ) {
    const built = this.buildDecorationTypes();
    this.decorationTypes = built.decorationTypes;
    this.addedDecorationTypes = built.addedDecorationTypes;

    this.statusBar = new FeatureStatusBar({
      alignment: vscode.StatusBarAlignment.Left,
      priority: 10,
      command: Commands.BLAME_HEATMAP_PICKER,
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
          const cached = this.decorationCache.get(editor.document.uri.fsPath);
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
        if (!this.activeModes.has(fsPath)) return;
        const existing = this.reapplyTimers.get(fsPath);
        if (existing) clearTimeout(existing);
        this.reapplyTimers.set(
          fsPath,
          setTimeout(async () => {
            this.reapplyTimers.delete(fsPath);
            const editor = vscode.window.visibleTextEditors.find(
              ed => ed.document.uri.fsPath === fsPath,
            );
            if (!editor) return;
            const mode = this.activeModes.get(fsPath);
            if (!mode) return;
            this.disposeDeletionsForFile(fsPath);
            this.decorationCache.delete(fsPath);
            await this.applyToEditor(editor, mode);
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
    if (this.activeModes.has(fsPath)) return;

    if (this.lastUsedMode === "branch") {
      const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, fsPath);
      if (!repoResult) return;
      if (!this.baselineService.getBaseRef(repoResult.repoFullPath)) return;
    }

    await this.applyToEditor(editor, this.lastUsedMode);
  }

  /**
   * Build a bucket of decoration types from a colors array + the matching
   * `freshFileExplorer.heatmap.<idPrefix>${1..N}` overview-ruler theme color.
   * Used twice in `buildDecorationTypes()` — once for the modified palette,
   * once for the added palette.
   */
  private buildBucketTypes(colors: string[], idPrefix: "age" | "added"): vscode.TextEditorDecorationType[] {
    const opacity = ConfigService.getBlameHeatmapBackgroundOpacity();
    return Array.from({ length: HEATMAP_BUCKET_COUNT }, (_, i) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        gutterIconPath: makeGutterIconUri(colors[i]),
        gutterIconSize: "contain",
        backgroundColor: hexToRgba(colors[i], opacity),
        overviewRulerColor: new vscode.ThemeColor(`freshFileExplorer.heatmap.${idPrefix}${i + 1}`),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
    );
  }

  private buildDecorationTypes(): { decorationTypes: vscode.TextEditorDecorationType[]; addedDecorationTypes: vscode.TextEditorDecorationType[] } {
    return {
      decorationTypes: this.buildBucketTypes(ConfigService.getBlameHeatmapAgeColors(), "age"),
      addedDecorationTypes: this.buildBucketTypes(ConfigService.getBlameHeatmapAddedColors(), "added"),
    };
  }

  private rebuildDecorationTypes(): void {
    // Clear old bucket decorations from all visible editors before disposing the types.
    // Deletion types are per-file dynamic types and survive the rebuild unchanged.
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
      for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    }
    for (const dt of this.decorationTypes) { dt.dispose(); }
    for (const dt of this.addedDecorationTypes) { dt.dispose(); }
    const built = this.buildDecorationTypes();
    this.decorationTypes = built.decorationTypes;
    this.addedDecorationTypes = built.addedDecorationTypes;
    // Re-apply from cache so active heatmaps update immediately. Skip diff
    // editors — their side is the wrong baseline to layer heatmap markers on
    // and the deletions could mislead about which ref the markers came from.
    for (const editor of vscode.window.visibleTextEditors) {
      if (isEditorInDiff(editor)) { continue; }
      const cached = this.decorationCache.get(editor.document.uri.fsPath);
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
    if (this.activeModes.has(fsPath)) {
      this.clearEditor(editor);
      this.decorationCache.delete(fsPath);
    }
    this.activeModes.set(fsPath, mode);
    await this.applyToEditor(editor, mode);
  }

  /** Explicit off. No-op if no mode is active on this file. */
  turnOff(editor: vscode.TextEditor): void {
    const fsPath = editor.document.uri.fsPath;
    if (!this.activeModes.has(fsPath)) { return; }
    this.clearEditor(editor);
    this.decorationCache.delete(fsPath);
    this.activeModes.delete(fsPath);
    this.statusBarNewFiles.delete(fsPath);
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
      activeMode: this.activeModes.get(editor.document.uri.fsPath),
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
    if (this.activeModes.has(fsPath)) {
      this.clearEditor(editor);
      this.decorationCache.delete(fsPath);
    }
    this.activeModes.set(fsPath, "branch");
    await this.applyToEditor(editor, "branch", { forcePickRef: true }); // always shows picker
  }

  /** Apply pre-computed decoration data to an editor instance. */
  private applyCache(
    editor: vscode.TextEditor,
    cache: {
      buckets: vscode.DecorationOptions[][];
      addedBuckets: vscode.DecorationOptions[][];
      deletions: DeletionDecoration[];
    },
  ): void {
    for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
      editor.setDecorations(this.decorationTypes[i], cache.buckets[i]);
      editor.setDecorations(this.addedDecorationTypes[i], cache.addedBuckets[i]);
    }
    for (const d of cache.deletions) {
      editor.setDecorations(d.type, [d.options]);
    }
  }

  /**
   * Dispose all per-file deletion decoration types for `fsPath`, automatically
   * removing their decorations from every editor. Clears the cached array
   * in-place so subsequent cache operations don't double-dispose.
   */
  private disposeDeletionsForFile(fsPath: string): void {
    const cache = this.decorationCache.get(fsPath);
    if (!cache) return;
    for (const d of cache.deletions) {
      d.type.dispose();
    }
    cache.deletions = [];
  }

  /** Remove all blame heatmap decorations from an editor. */
  private clearEditor(editor: vscode.TextEditor): void {
    for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
    for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    // Disposing the deletion types removes them from all editors automatically.
    this.disposeDeletionsForFile(editor.document.uri.fsPath);
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
      this.activeModes.delete(uri.fsPath);
      return;
    }
    // Diff editors carry their own change indicators; layering blame on top is
    // duplicate signal. Silent no-op — and don't touch `activeModes`: a regular
    // tab of the same file shares this fsPath and may legitimately be decorated.
    if (isEditorInDiff(editor)) { return; }

    // Mark the mode immediately so updateStatusBar and the text-change listener
    // see the correct state even before the async git work completes.
    this.activeModes.set(uri.fsPath, mode);

    const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, uri.fsPath);
    if (!repoResult) {
      this.statusBarWarnings.set(uri.fsPath, "not in a git repo");
      this.activeModes.delete(uri.fsPath);
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
          this.activeModes.delete(uri.fsPath);
          return;
        }
      }
      if (editor.document.isClosed) {
        this.activeModes.delete(uri.fsPath);
        return;
      }
    }

    // Guard: skip large files to avoid slow git blame runs.
    const maxLines = ConfigService.getBlameHeatmapMaxLines();
    if (editor.document.lineCount > maxLines) {
      const msg = `Line count over config limit ${maxLines}`;
      this.statusBarWarnings.set(uri.fsPath, msg);
      this.activeModes.delete(uri.fsPath);
      this.updateStatusBar(editor);
      return;
    }

    // From here on we hit git, so flip the spinner and clear it in finally so
    // every early-return path (errors, closed editor, untracked file) restores
    // the status bar to its post-load state.
    this.loadingFsPaths.add(uri.fsPath);
    this.updateStatusBar(editor);
    try {

    // After every async hop the editor's mode may have flipped (user clicked
    // Turn off, switched modes, closed the tab) — bail before applying stale
    // decorations.  Closed-doc check stays bundled in here too.
    const isStale = (): boolean =>
      editor.document.isClosed || this.activeModes.get(uri.fsPath) !== mode;

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
      this.activeModes.delete(uri.fsPath);
      return;
    }

    if (isStale()) { return; }

    const blameLines = parseGitBlamePorcelain(blameOutput);
    if (blameLines.length === 0) {
      this.statusBarWarnings.set(uri.fsPath, "no blame data");
      this.activeModes.delete(uri.fsPath);
      this.updateStatusBar(editor);
      return;
    }

    const nowMs = Date.now();
    const rangesByBucket: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );
    const rangesByDeletions: DeletionDecoration[] = [];
    // Parallel bucket array for "added in this branch" lines — same buckets, different palette.
    const rangesByAddedBucket: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );

    let getBucket: (sha: string, timestamp: number) => number;
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
        this.activeModes.delete(uri.fsPath);
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

      // Window spans the actual age range of branch-touched lines in **this file**
      // (not from merge-base to now). Using merge-base→now collapses every line
      // into bucket 0 when the branch's edits cluster near the recent end of a
      // long-lived branch — palette becomes a single colour. Anchoring on the
      // oldest branch-line in the file restores per-bucket spread.
      const branchLineTimestamps = blameLines.filter(l => branchCommitShas.has(l.sha)).map(l => l.timestamp);
      const oldestBranchTimestamp = branchLineTimestamps.length > 0
        ? Math.min(...branchLineTimestamps)
        : Math.floor(nowMs / 1000); // no branch lines in this file → window irrelevant
      windowDays = Math.max(1, (nowMs - oldestBranchTimestamp * 1000) / (24 * 60 * 60 * 1000));
      getBucket = (sha, timestamp) =>
        branchCommitShas.has(sha) ? blameTimestampToBucket(timestamp, windowDays, nowMs) : -1; // sentinel: skip this line

      log(
        `Branch blame heatmap: baseRef=${baseRef!}, mergeBase=${mergeBaseSha.slice(0, 7)}, branchCommits=${branchCommitShas.size}, branchLinesInFile=${branchLineTimestamps.length}, window=${windowDays.toFixed(1)}d`,
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

      const lineCount = editor.document.lineCount;
      for (const { afterNewLine1, count, lines } of branchHunks.deletions) {
        // afterNewLine1 is 1-based; clamp to valid [0, lineCount-1] range.
        // A value of 0 means the deletion is before the first surviving line.
        const lineIndex = Math.max(0, Math.min(afterNewLine1, lineCount) - 1);

        // Each deletion gets its own decoration type so the gutter badge can
        // show the specific count (e.g. "36"). The user-facing actions live in
        // the gutter right-click menu (`editor/lineNumber/context`); no hover
        // message is set because the decoration's zero-width range never
        // triggers one anyway.
        const type = vscode.window.createTextEditorDecorationType({
          gutterIconPath: makeDeletionGutterIcon(count),
          gutterIconSize: "contain",
        });
        rangesByDeletions.push({
          type,
          options: {
            range: new vscode.Range(lineIndex, 0, lineIndex, 0),
          },
          lines,
        });
      }

      // Suppress decorations only when the file is **genuinely new** since the
      // merge base — every line a fresh addition. A fully-rewritten file
      // (existed at mergeBase, every line replaced) also blames entirely to
      // branch with no pure-deletion hunks, but it's *not* new — we want
      // normal age decorations there.
      if (!existedAtMergeBase && rangesByDeletions.length === 0) {
        isAllNewFile = blameLines.every(l => branchCommitShas.has(l.sha));
      }
    } else {
      // Absolute mode: derive window from the oldest line in the file so that
      // the full colour range is always used regardless of configured windows.
      const oldestTimestamp = Math.min(...blameLines.map(l => l.timestamp));
      windowDays = Math.max(1, (nowMs - oldestTimestamp * 1000) / (24 * 60 * 60 * 1000));
      getBucket = (_sha, timestamp) => blameTimestampToBucket(timestamp, windowDays, nowMs);
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
        range: new vscode.Range(lineIndex, 0, lineIndex, 0),
        hoverMessage: hover,
      });
    }

    // Dispose stale deletion types before installing new ones (covers re-apply
    // path where the cache entry already exists from a previous run).
    this.disposeDeletionsForFile(uri.fsPath);

    if (isAllNewFile) {
      // File is entirely new on this branch — clear any stale decorations and
      // let the status bar carry the message instead.
      // rangesByDeletions is empty here (checked by the isAllNewFile guard), so
      // no types were created and there is nothing to apply or dispose.
      this.statusBarNewFiles.add(uri.fsPath);
      for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
        editor.setDecorations(this.decorationTypes[i], []);
        editor.setDecorations(this.addedDecorationTypes[i], []);
      }
    } else {
      this.statusBarNewFiles.delete(uri.fsPath);
      for (let i = 0; i < HEATMAP_BUCKET_COUNT; i++) {
        editor.setDecorations(this.decorationTypes[i], rangesByBucket[i]);
        editor.setDecorations(this.addedDecorationTypes[i], rangesByAddedBucket[i]);
      }
      for (const d of rangesByDeletions) {
        editor.setDecorations(d.type, [d.options]);
      }
    }

    this.statusBarWarnings.delete(uri.fsPath);
    const emptyBuckets: vscode.DecorationOptions[][] = Array.from(
      { length: HEATMAP_BUCKET_COUNT },
      () => [],
    );
    this.decorationCache.set(uri.fsPath, {
      buckets: isAllNewFile ? emptyBuckets : rangesByBucket,
      addedBuckets: isAllNewFile ? emptyBuckets : rangesByAddedBucket,
      deletions: isAllNewFile ? [] : rangesByDeletions,
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
      this.loadingFsPaths.delete(uri.fsPath);
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
    const active = fsPath !== undefined && this.activeModes.has(fsPath);
    ContextManager.setBlameHeatmapHasBaseRef(this.getSavedBaseRefFor(editor) !== undefined);
    ContextManager.setBlameHeatmapActive(active);
  }

  private updateStatusBar(editor: vscode.TextEditor | undefined): void {
    if (!ConfigService.getStatusBarHeatmapEnabled()) {
      this.statusBar.update({ kind: "hidden" });
      return;
    }
    const uri = editor?.document.uri;
    // Only show the indicator for real files. Output channels, settings, etc. → hide.
    if (!uri || uri.scheme !== "file") {
      this.statusBar.update({ kind: "hidden" });
      return;
    }
    const fsPath = uri.fsPath;

    const warning = this.statusBarWarnings.get(fsPath);
    if (warning) {
      this.statusBar.update({
        kind: "warning",
        text: `$(color-mode) Heatmap: $(warning) ${warning}`,
        tooltip: warning,
      });
      return;
    }

    if (this.loadingFsPaths.has(fsPath)) {
      this.statusBar.update({
        kind: "active",
        text: `$(sync~spin) Heatmap…`,
        tooltip: "Computing blame heatmap.",
      });
      return;
    }

    const mode = this.activeModes.get(fsPath);
    if (!mode) {
      const savedRef = this.getSavedBaseRefFor(editor);
      this.statusBar.update({
        kind: "inactive",
        text: savedRef ? `$(color-mode) Heatmap: off (vs ${savedRef})` : `$(color-mode) Heatmap: off`,
        tooltip: savedRef
          ? `Click to enable the blame heatmap. Saved diff baseline: ${savedRef}.`
          : "Click to enable the blame heatmap (Age or Branch).",
      });
      return;
    }

    if (mode === "absolute") {
      this.statusBar.update({
        kind: "active",
        text: `$(color-mode) Heatmap: Age`,
        tooltip: "Blame heatmap: coloring by commit age. Click to change.",
      });
    } else {
      const repoResult = findRepoForAbsolutePath(this.freshFileProvider.workspaceFolders, fsPath);
      const ref = (repoResult && this.baselineService.getBaseRef(repoResult.repoFullPath)) ?? "branch";
      if (this.statusBarNewFiles.has(fsPath)) {
        this.statusBar.update({
          kind: "new-file",
          text: `$(add) Heatmap: new file vs ${ref}`,
          tooltip: `Blame heatmap: this file is entirely new since ${ref}. Click to change.`,
        });
      } else {
        this.statusBar.update({
          kind: "active",
          text: `$(color-mode) Heatmap: vs ${ref}`,
          tooltip: `Blame heatmap: showing changes since ${ref}. Click to change.`,
        });
      }
    }
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
        if (this.activeModes.get(editorFsPath) !== "branch") continue;
        const editorRepo = findRepoForAbsolutePath(
          this.freshFileProvider.workspaceFolders,
          editorFsPath,
        );
        if (!editorRepo || normalizePath(editorRepo.repoFullPath) !== key) continue;
        this.disposeDeletionsForFile(editorFsPath);
        this.decorationCache.delete(editorFsPath);
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
      this.statusBarWarnings.set(uri.fsPath, "not in a git repo");
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
   * Remove a specific deletion marker (by anchor line index) from the cache
   * and immediately re-apply decorations. Called after a successful restore so
   * the indicator disappears without waiting for the debounced re-apply.
   */
  private dismissDeletion(fsPath: string, anchorLineIndex: number): void {
    const cache = this.decorationCache.get(fsPath);
    if (!cache) return;
    const idx = cache.deletions.findIndex(d => d.options.range.start.line === anchorLineIndex);
    if (idx !== -1) {
      // Disposing the type automatically removes its decoration from all editors.
      cache.deletions[idx].type.dispose();
      cache.deletions.splice(idx, 1);
    }
    // Refresh the gutter-menu visibility set if the dismissed deletion is in the active editor.
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.fsPath === fsPath) {
      this.updateDeletionLinesContext(active);
    }
  }

  /**
   * Drives the `freshFileExplorer.blameHeatmap.deletionLines` context key — the array
   * of 1-based line numbers where deletion markers exist for the active editor.
   * The gutter right-click menu uses this to gate visibility of the
   * "Copy / Restore deleted lines" entries via `editorLineNumber in <key>`.
   */
  /**
   * Wipe every heatmap decoration from a specific editor instance without
   * disposing the decoration types (other editors with the same `fsPath`
   * keep their markers). Used when a `file://` editor gets reused as the
   * working-tree side of a diff and we need to scrub leftover markers.
   */
  private clearEditorDecorations(editor: vscode.TextEditor): void {
    for (const dt of this.decorationTypes) { editor.setDecorations(dt, []); }
    for (const dt of this.addedDecorationTypes) { editor.setDecorations(dt, []); }
    const cached = this.decorationCache.get(editor.document.uri.fsPath);
    if (cached) {
      for (const d of cached.deletions) { editor.setDecorations(d.type, []); }
    }
  }

  private updateDeletionLinesContext(editor: vscode.TextEditor | undefined): void {
    let lines: number[] = [];
    // Gate the gutter menu items: when the active editor is part of a diff,
    // the cached deletions came from the blame-heatmap baseline — which may
    // be a different ref than whatever the diff editor is actually showing.
    // "Restore from baseline" there would silently resurrect lines from the
    // wrong ref. Hide the affordance instead of risking that.
    if (editor && !isEditorInDiff(editor)) {
      const fsPath = editor.document.uri.fsPath;
      const cached = this.decorationCache.get(fsPath);
      if (cached) {
        // Decoration ranges are 0-based; the menu's `editorLineNumber` key is 1-based.
        lines = cached.deletions.map(d => d.options.range.start.line + 1);
      }
    }
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
    const cached = this.decorationCache.get(fsPath);
    if (!cached) { return undefined; }
    const target0 = lineNumber1Based - 1;
    return cached.deletions.find(d => d.options.range.start.line === target0);
  }

  dispose(): void {
    for (const timer of this.reapplyTimers.values()) {
      clearTimeout(timer);
    }
    this.statusBar.dispose();
    for (const dt of this.decorationTypes) { dt.dispose(); }
    for (const dt of this.addedDecorationTypes) { dt.dispose(); }
    // Dispose all per-file deletion types.
    for (const cache of this.decorationCache.values()) {
      for (const d of cache.deletions) {
        d.type.dispose();
      }
    }
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
  }
}
