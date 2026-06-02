import * as vscode from "vscode";

import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { NormalizedRepoPath, asNormalizedRepoPath } from "../pathTypes";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "../fresh-files/groupingMode";
import { DiffMode, DEFAULT_DIFF_MODE } from "./branchCompareConstants";

/**
 * One saved comparison record. Multiple of these can exist per repo; the
 * branch-compare tree shows the `active: true` ones, the settings panel
 * shows everything.
 *
 * `source === "HEAD"` is a sentinel meaning "diff against the working
 * branch". Working-tree overlay is only applied when source is HEAD —
 * arbitrary refs can't carry working-tree changes.
 *
 * `isHeatmapBaseline` marks the comparison whose `target` ref drives the
 * blame heatmap. At most one per repo. Heatmap operates only against
 * HEAD-source comparisons (it can't blame against a non-HEAD ref).
 */
export interface SavedComparison {
  id: string;
  repoFullPath: NormalizedRepoPath;
  source: string;
  target: string;
  /** User-given name. Empty / undefined → tree shows `repo · source..target`. */
  label?: string;
  active: boolean;
  isHeatmapBaseline?: boolean;
  /** How the branch-compare tree groups this comparison's files (per-comparison). */
  groupingMode: GroupingMode;
  /** Whether the diff is computed against the merge-base (`merge`) or the target ref directly (`full`). */
  diffMode: DiffMode;
}

export interface SavedComparisonsChangeEvent {
  /** When undefined → wholesale change. Otherwise the affected ids. */
  ids?: string[];
  /**
   * When true, only the list order changed — refs/labels/active state are
   * untouched. Receivers can skip expensive diff re-fetches and just re-render.
   */
  reorderOnly?: boolean;
  /**
   * When true, only display state (grouping mode) changed — the diff data is
   * unaffected. Receivers re-render from cached files and only re-fetch when
   * the new grouping needs commit info the cached load didn't include.
   */
  displayOnly?: boolean;
}

/** Sentinel for "use the working branch as the source." */
export const HEAD_SOURCE = "HEAD";

/** Generate a stable id without pulling in a uuid dependency. */
function makeId(): string {
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owner of the saved-comparisons list. Reads/writes via WorkspaceStateManager,
 * fires events on change. Consumers (branch-compare provider, baseline
 * projection, settings panel) all subscribe to the single onDidChange event.
 */
export class SavedComparisonsService implements vscode.Disposable {
  private comparisons: SavedComparison[];
  private readonly _onDidChange = new vscode.EventEmitter<SavedComparisonsChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.comparisons = this.load();
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /** Snapshot of all saved comparisons (active + inactive). */
  getAll(): SavedComparison[] {
    return this.comparisons.map(c => ({ ...c }));
  }

  /** Active-only snapshot. The branch-compare tree renders one section per entry. */
  getActive(): SavedComparison[] {
    return this.comparisons.filter(c => c.active).map(c => ({ ...c }));
  }

  getById(id: string): SavedComparison | undefined {
    const c = this.comparisons.find(x => x.id === id);
    return c ? { ...c } : undefined;
  }

  /**
   * The comparison currently driving the blame heatmap for the given repo,
   * if any. At most one. Always has `source === "HEAD"`.
   */
  getHeatmapBaselineFor(repoFullPath: string): SavedComparison | undefined {
    const key = asNormalizedRepoPath(repoFullPath);
    const c = this.comparisons.find(
      x => x.repoFullPath === key && x.isHeatmapBaseline && x.source === HEAD_SOURCE,
    );
    return c ? { ...c } : undefined;
  }

  /** True when at least one comparison is active. Drives view visibility. */
  hasAnyActive(): boolean {
    return this.comparisons.some(c => c.active);
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Add a new comparison. Returns the generated id. New comparisons default
   * to `active: true` so they appear in the tree immediately.
   */
  add(input: {
    repoFullPath: string;
    source: string;
    target: string;
    label?: string;
    active?: boolean;
    isHeatmapBaseline?: boolean;
  }): string {
    const id = makeId();
    const repoKey = asNormalizedRepoPath(input.repoFullPath);
    const newCmp: SavedComparison = {
      id,
      repoFullPath: repoKey,
      source: input.source,
      target: input.target,
      label: input.label?.trim() || undefined,
      active: input.active ?? true,
      isHeatmapBaseline: input.isHeatmapBaseline,
      groupingMode: DEFAULT_GROUPING_MODE,
      diffMode: DEFAULT_DIFF_MODE,
    };
    if (newCmp.isHeatmapBaseline) {
      this.clearHeatmapBaselineForRepo(repoKey);
    }
    this.comparisons.push(newCmp);
    this.persist();
    this._onDidChange.fire({ ids: [id] });
    return id;
  }

  /**
   * Patch an existing comparison. Only fields present in `patch` are changed.
   * Setting `isHeatmapBaseline: true` automatically clears the flag from any
   * other comparison in the same repo (mutual exclusion).
   */
  update(id: string, patch: Partial<Omit<SavedComparison, "id">>): void {
    const idx = this.comparisons.findIndex(c => c.id === id);
    if (idx === -1) { return; }
    const existing = this.comparisons[idx];
    const next: SavedComparison = { ...existing };
    if (patch.repoFullPath !== undefined) {
      next.repoFullPath = asNormalizedRepoPath(patch.repoFullPath);
    }
    if (patch.source !== undefined) { next.source = patch.source; }
    if (patch.target !== undefined) { next.target = patch.target; }
    if ("label" in patch) {
      next.label = patch.label?.toString().trim() || undefined;
    }
    if (patch.active !== undefined) { next.active = patch.active; }
    if (patch.isHeatmapBaseline !== undefined) {
      next.isHeatmapBaseline = patch.isHeatmapBaseline;
    }
    if (patch.groupingMode !== undefined) { next.groupingMode = patch.groupingMode; }
    if (patch.diffMode !== undefined) { next.diffMode = patch.diffMode; }

    // Heatmap baseline can only attach to a HEAD-source comparison.
    if (next.isHeatmapBaseline && next.source !== HEAD_SOURCE) {
      next.isHeatmapBaseline = false;
    }

    // Split the diff into "affects the diff data" vs "display only". A
    // grouping-only change must not trigger the provider's diff re-fetch —
    // it re-renders from cached files. diffMode IS a data change (merge vs full
    // produce different file sets), so it lives on the re-fetch path.
    const dataChanged =
      next.source !== existing.source ||
      next.target !== existing.target ||
      next.label !== existing.label ||
      next.active !== existing.active ||
      next.isHeatmapBaseline !== existing.isHeatmapBaseline ||
      next.repoFullPath !== existing.repoFullPath ||
      next.diffMode !== existing.diffMode;
    const groupingChanged = next.groupingMode !== existing.groupingMode;

    // Bail if the patch was a no-op — persisting + firing onChange here
    // cascades into the provider's diff re-fetch, which is wasteful.
    if (!dataChanged && !groupingChanged) {
      return;
    }

    this.comparisons[idx] = next;
    if (next.isHeatmapBaseline) {
      this.clearHeatmapBaselineForRepo(next.repoFullPath, id);
    }
    this.persist();
    // Only a grouping change → display-only event so the provider skips the
    // diff re-fetch. Any data change takes the full path even if grouping
    // also changed (the re-fetch picks up the new mode anyway).
    this._onDidChange.fire(
      dataChanged ? { ids: [id] } : { ids: [id], displayOnly: true },
    );
  }

  /**
   * Set the grouping mode on every comparison at once (the panel's batch
   * toggle). Fires a single display-only event.
   */
  setAllGroupingModes(mode: GroupingMode): void {
    let changed = false;
    for (const c of this.comparisons) {
      if (c.groupingMode !== mode) { c.groupingMode = mode; changed = true; }
    }
    if (!changed) { return; }
    this.persist();
    this._onDidChange.fire({ ids: this.comparisons.map(c => c.id), displayOnly: true });
  }

  delete(id: string): void {
    const before = this.comparisons.length;
    this.comparisons = this.comparisons.filter(c => c.id !== id);
    if (this.comparisons.length === before) { return; }
    this.persist();
    this._onDidChange.fire({ ids: [id] });
  }

  /**
   * Move a comparison up (`delta < 0`) or down (`delta > 0`) in the persisted
   * list. Order in this array drives the section order in the tree, so this
   * is the user-facing reorder. Clamps to valid bounds — calls that would
   * cross either end are silently no-ops.
   */
  move(id: string, delta: number): void {
    const idx = this.comparisons.findIndex(c => c.id === id);
    if (idx === -1) { return; }
    const target = Math.max(0, Math.min(this.comparisons.length - 1, idx + delta));
    if (target === idx) { return; }
    const [item] = this.comparisons.splice(idx, 1);
    this.comparisons.splice(target, 0, item);
    this.persist();
    this._onDidChange.fire({ ids: [id], reorderOnly: true });
  }

  /**
   * Move to an absolute index. `targetIndex` follows `Array.splice` semantics
   * — the destination in the **final** array, computed as if the item were
   * removed first. Used by the drag-and-drop reorder path; up/down arrows
   * use the simpler `move(id, delta)` form above.
   */
  moveTo(id: string, targetIndex: number): void {
    const idx = this.comparisons.findIndex(c => c.id === id);
    if (idx === -1) { return; }
    const clamped = Math.max(0, Math.min(this.comparisons.length - 1, targetIndex));
    if (clamped === idx) { return; }
    const [item] = this.comparisons.splice(idx, 1);
    this.comparisons.splice(clamped, 0, item);
    this.persist();
    this._onDidChange.fire({ ids: [id], reorderOnly: true });
  }

  /**
   * Mark a HEAD-source comparison as the heatmap baseline for its repo.
   * Clearing is done by passing `undefined`. Non-HEAD sources are rejected
   * silently (heatmap can't compare against a non-checked-out ref).
   */
  setHeatmapBaseline(id: string | undefined): void {
    if (id === undefined) {
      // Clear all heatmap-baseline flags
      let anyChanged = false;
      for (const c of this.comparisons) {
        if (c.isHeatmapBaseline) { c.isHeatmapBaseline = false; anyChanged = true; }
      }
      if (anyChanged) {
        this.persist();
        this._onDidChange.fire({});
      }
      return;
    }
    const cmp = this.comparisons.find(c => c.id === id);
    if (!cmp) { return; }
    if (cmp.source !== HEAD_SOURCE) { return; }
    this.clearHeatmapBaselineForRepo(cmp.repoFullPath);
    cmp.isHeatmapBaseline = true;
    this.persist();
    this._onDidChange.fire({ ids: [id] });
  }

  /**
   * Convenience used by the heatmap "Set Baseline" flow: ensure there is
   * exactly one HEAD-source comparison for the given repo with this target,
   * and that it's marked as the heatmap baseline + active.
   *
   * Returns the resulting comparison's id.
   */
  setHeatmapBaselineByRefForRepo(repoFullPath: string, targetRef: string): string {
    const repoKey = asNormalizedRepoPath(repoFullPath);
    // Find an existing HEAD..targetRef comparison for this repo.
    const existing = this.comparisons.find(
      c => c.repoFullPath === repoKey && c.source === HEAD_SOURCE && c.target === targetRef,
    );
    if (existing) {
      this.clearHeatmapBaselineForRepo(repoKey, existing.id);
      // Don't touch `active`: the heatmap baseline can be set on a comparison
      // the user deliberately hid from the tree. Flipping `active` here would
      // un-hide it without consent.
      existing.isHeatmapBaseline = true;
      this.persist();
      this._onDidChange.fire({ ids: [existing.id] });
      return existing.id;
    }
    return this.add({
      repoFullPath: repoKey,
      source: HEAD_SOURCE,
      target: targetRef,
      active: true,
      isHeatmapBaseline: true,
    });
  }

  /**
   * Drop heatmap-baseline flag for the given repo. Used by the heatmap
   * "Clear Baseline" flow. Does not delete the comparison.
   */
  clearHeatmapBaselineForRepoByRef(repoFullPath: string): void {
    const repoKey = asNormalizedRepoPath(repoFullPath);
    let changed = false;
    for (const c of this.comparisons) {
      if (c.repoFullPath === repoKey && c.isHeatmapBaseline) {
        c.isHeatmapBaseline = false;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      this._onDidChange.fire({});
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    this._onDidChange.dispose();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /** Load persisted comparisons from workspace state. */
  private load(): SavedComparison[] {
    return WorkspaceStateManager.getSavedComparisons().map(c => ({
      ...c,
      repoFullPath: asNormalizedRepoPath(c.repoFullPath),
      // Records predating these per-comparison fields have none — default them.
      groupingMode: c.groupingMode ?? DEFAULT_GROUPING_MODE,
      diffMode: c.diffMode ?? DEFAULT_DIFF_MODE,
    }));
  }

  private persist(): void {
    WorkspaceStateManager.setSavedComparisons(this.comparisons);
  }

  /**
   * Clear `isHeatmapBaseline` from every comparison in the given repo,
   * optionally except for `keepId`. Caller must persist + fire.
   */
  private clearHeatmapBaselineForRepo(repoKey: NormalizedRepoPath, keepId?: string): void {
    for (const c of this.comparisons) {
      if (c.repoFullPath !== repoKey) { continue; }
      if (c.id === keepId) { continue; }
      if (c.isHeatmapBaseline) { c.isHeatmapBaseline = false; }
    }
  }
}
