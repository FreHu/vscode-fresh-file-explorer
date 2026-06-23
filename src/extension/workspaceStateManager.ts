import * as vscode from "vscode";
import { PinnedItem, SortOrder } from "../types";
import { GroupingMode, DEFAULT_GROUPING_MODE, coerceGroupingMode } from "../fresh-files/groupingMode";
import { DiffMode } from "../branch-compare/branchCompareConstants";
import { DiffSearchParams, DiffSearchHistoryEntry, StonksConfig } from "../webview/messages";
import { NormalizedRepoPath } from "../pathTypes";
import type { SavedComparison } from "../branch-compare/savedComparisonsService";

/**
 * The persisted shape of a saved comparison — a relaxed {@link SavedComparison}.
 * It tracks the canonical interface for every shared field, but deliberately
 * differs at the storage boundary in two ways: the path comes back as a raw
 * `string` (callers re-brand it to `NormalizedRepoPath`), and `groupingMode` /
 * `diffMode` are optional because legacy records predate them and are
 * backfilled on read (see `savedComparisonsService`).
 */
export type PersistedSavedComparison =
  & Omit<SavedComparison, "repoFullPath" | "groupingMode" | "diffMode">
  & {
    repoFullPath: string;
    groupingMode?: GroupingMode;
    diffMode?: DiffMode;
  };

/**
 * Centralized manager for all values persisted via `context.workspaceState`.
 *
 * Call `WorkspaceStateManager.initialize(context)` once during extension
 * activation before any other method is used. All getters and setters below
 * are strongly-typed so every key name and value type is auditable in one place.
 */
export class WorkspaceStateManager {
  private static context: vscode.ExtensionContext | undefined;

  static initialize(context: vscode.ExtensionContext): void {
    WorkspaceStateManager.context = context;
  }

  private static ctx(): vscode.ExtensionContext {
    if (!WorkspaceStateManager.context) {
      throw new Error("WorkspaceStateManager has not been initialized");
    }
    return WorkspaceStateManager.context;
  }

  // ── Time window ─────────────────────────────────────────────────────────────

  static getSelectedTimeWindowDays(): number | undefined {
    return WorkspaceStateManager.ctx().workspaceState.get<number>("selectedTimeWindowDays");
  }

  static setSelectedTimeWindowDays(days: number): void {
    WorkspaceStateManager.ctx().workspaceState.update("selectedTimeWindowDays", days);
  }

  // ── Open-changes mode ────────────────────────────────────────────────────────

  static getOpenChangesMode(fallback: boolean = false): boolean {
    return WorkspaceStateManager.ctx().workspaceState.get<boolean>("openChangesMode", fallback);
  }

  static setOpenChangesMode(value: boolean): void {
    WorkspaceStateManager.ctx().workspaceState.update("openChangesMode", value);
  }

  /**
   * Branch Compare's own open-changes mode — independent of Fresh Files.
   * Defaults to `true` (diff on click)
   */
  static getBranchCompareOpenChangesMode(fallback: boolean = true): boolean {
    return WorkspaceStateManager.ctx().workspaceState.get<boolean>("branchCompareOpenChangesMode", fallback);
  }

  static setBranchCompareOpenChangesMode(value: boolean): void {
    WorkspaceStateManager.ctx().workspaceState.update("branchCompareOpenChangesMode", value);
  }

  // ── Grouping mode ────────────────────────────────────────────────────────────

  static getGroupingMode(fallback: GroupingMode = DEFAULT_GROUPING_MODE): GroupingMode {
    const raw = WorkspaceStateManager.ctx().workspaceState.get<unknown>("groupingMode");
    return coerceGroupingMode(raw, fallback);
  }

  static setGroupingMode(mode: GroupingMode): void {
    WorkspaceStateManager.ctx().workspaceState.update("groupingMode", mode);
  }

  // ── Sort order ───────────────────────────────────────────────────────────────

  static getSortOrder(fallback: SortOrder = "name"): SortOrder {
    return WorkspaceStateManager.ctx().workspaceState.get<SortOrder>("sortOrder", fallback);
  }

  static setSortOrder(order: SortOrder): void {
    WorkspaceStateManager.ctx().workspaceState.update("sortOrder", order);
  }

  static clearGroupingMode(): void {
    WorkspaceStateManager.ctx().workspaceState.update("groupingMode", undefined);
  }

  static clearSortOrder(): void {
    WorkspaceStateManager.ctx().workspaceState.update("sortOrder", undefined);
  }

  // ── Pinned items ─────────────────────────────────────────────────────────────

  static getPinnedItems(): PinnedItem[] {
    return WorkspaceStateManager.ctx().workspaceState.get<PinnedItem[]>("pinnedItems", []);
  }

  static setPinnedItems(items: PinnedItem[]): void {
    WorkspaceStateManager.ctx().workspaceState.update("pinnedItems", items);
  }

  // ── Repo pathspecs ─────────────────────────────────────────────────────────

  // ── Stonks config ──────────────────────────────────────────────────────────

  static getStonksConfig(): StonksConfig | undefined {
    return WorkspaceStateManager.ctx().workspaceState.get<StonksConfig>("stonksConfig");
  }

  static setStonksConfig(config: StonksConfig): void {
    WorkspaceStateManager.ctx().workspaceState.update("stonksConfig", config);
  }

  /** Returns the stored pathspec map (normalized repo path → pathspec string). */
  static getRepoPathspecs(): Map<NormalizedRepoPath, string> {
    const record = WorkspaceStateManager.ctx().workspaceState.get<Record<string, string>>("repoPathspecs", {});
    return new Map(Object.entries(record) as [NormalizedRepoPath, string][]);
  }

  /** Set or clear a pathspec for the given normalized repo path. Passing undefined removes the entry. */
  static setRepoPathspec(normalizedRepoPath: NormalizedRepoPath, pathspec: string | undefined): void {
    const map = WorkspaceStateManager.ctx().workspaceState.get<Record<string, string>>("repoPathspecs", {});
    if (pathspec) {
      map[normalizedRepoPath] = pathspec;
    } else {
      delete map[normalizedRepoPath];
    }
    WorkspaceStateManager.ctx().workspaceState.update("repoPathspecs", map);
  }

  static clearRepoPathspec(normalizedRepoPath: NormalizedRepoPath): void {
    return this.setRepoPathspec(normalizedRepoPath, undefined);
  }

  // ── Repo folder scopes ─────────────────────────────────────────────────────

  /** Returns the stored folder scope map (normalized repo path → normalized absolute folder path). */
  static getRepoFolderScopes(): Map<NormalizedRepoPath, string> {
    const record = WorkspaceStateManager.ctx().workspaceState.get<Record<string, string>>("repoFolderScopes", {});
    return new Map(Object.entries(record) as [NormalizedRepoPath, string][]);
  }

  /** Set or clear a folder scope for the given normalized repo path. Passing undefined removes the entry. */
  static setRepoFolderScope(normalizedRepoPath: NormalizedRepoPath, normalizedFolderPath: string | undefined): void {
    const map = WorkspaceStateManager.ctx().workspaceState.get<Record<string, string>>("repoFolderScopes", {});
    if (normalizedFolderPath) {
      map[normalizedRepoPath] = normalizedFolderPath;
    } else {
      delete map[normalizedRepoPath];
    }
    WorkspaceStateManager.ctx().workspaceState.update("repoFolderScopes", map);
  }

  // ── Diff search ──────────────────────────────────────────────────────────────

  static getDiffSearchParams(): DiffSearchParams | undefined {
    return WorkspaceStateManager.ctx().workspaceState.get<DiffSearchParams>("diffSearchParams");
  }

  static setDiffSearchParams(params: DiffSearchParams): void {
    WorkspaceStateManager.ctx().workspaceState.update("diffSearchParams", params);
  }

  static getDiffSearchHistory(): DiffSearchHistoryEntry[] {
    return WorkspaceStateManager.ctx().workspaceState.get<DiffSearchHistoryEntry[]>("diffSearchHistory", []);
  }

  static setDiffSearchHistory(entries: DiffSearchHistoryEntry[]): void {
    WorkspaceStateManager.ctx().workspaceState.update("diffSearchHistory", entries);
  }

  // ── Pathspec history ──────────────────────────────────────────────────────────

  private static readonly PATHSPEC_HISTORY_LIMIT = 10;

  /** Returns the stored pathspec history array (most recent first). */
  static getPathspecHistory(): string[] {
    return WorkspaceStateManager.ctx().workspaceState.get<string[]>("pathspecHistory", []);
  }

  /** Adds a pathspec to history, removing duplicates and limiting to last 10. */
  static addPathspecToHistory(pathspec: string): void {
    if (!pathspec.trim()) {
      return;
    }
    
    const history = WorkspaceStateManager.getPathspecHistory();
    
    // Remove duplicate if exists
    const filtered = history.filter(p => p !== pathspec);
    
    // Add to front
    filtered.unshift(pathspec);
    
    // Limit to 10
    const limited = filtered.slice(0, WorkspaceStateManager.PATHSPEC_HISTORY_LIMIT);
    
    WorkspaceStateManager.ctx().workspaceState.update("pathspecHistory", limited);
  }

  /** Clears all pathspec history. */
  static clearPathspecHistory(): void {
    WorkspaceStateManager.ctx().workspaceState.update("pathspecHistory", []);
  }

  // ── Blame heatmap ────────────────────────────────────────────────────────────

  /** Last blame heatmap mode used by the user ("absolute" | "branch"), or undefined. */
  static getBlameHeatmapMode(): "absolute" | "branch" | undefined {
    const raw = WorkspaceStateManager.ctx().workspaceState.get<string>("blameHeatmapMode");
    return raw === "absolute" || raw === "branch" ? raw : undefined;
  }

  static setBlameHeatmapMode(mode: "absolute" | "branch"): void {
    WorkspaceStateManager.ctx().workspaceState.update("blameHeatmapMode", mode);
  }

  // ── Branch compare saved comparisons (multi-comparison list) ─────────────

  /** Returns the persisted list as raw objects. Callers re-brand the path field. */
  static getSavedComparisons(): PersistedSavedComparison[] {
    return WorkspaceStateManager.ctx().workspaceState.get(
      "branchCompareSavedComparisons",
      [] as PersistedSavedComparison[],
    );
  }

  static setSavedComparisons(list: PersistedSavedComparison[]): void {
    WorkspaceStateManager.ctx().workspaceState.update("branchCompareSavedComparisons", list);
  }
}
