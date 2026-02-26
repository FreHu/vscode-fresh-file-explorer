import * as vscode from "vscode";
import { PinnedItem, SortOrder } from "../types";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "../groupingMode";
import { DiffSearchParams, DiffSearchHistoryEntry } from "../webview/messages";

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

  static getOpenChangesMode(): boolean {
    return WorkspaceStateManager.ctx().workspaceState.get<boolean>("openChangesMode", false);
  }

  static setOpenChangesMode(value: boolean): void {
    WorkspaceStateManager.ctx().workspaceState.update("openChangesMode", value);
  }

  // ── Grouping mode ────────────────────────────────────────────────────────────

  static getGroupingMode(): GroupingMode {
    return WorkspaceStateManager.ctx().workspaceState.get<GroupingMode>("groupingMode", DEFAULT_GROUPING_MODE);
  }

  static setGroupingMode(mode: GroupingMode): void {
    WorkspaceStateManager.ctx().workspaceState.update("groupingMode", mode);
  }

  // ── Sort order ───────────────────────────────────────────────────────────────

  static getSortOrder(): SortOrder {
    return WorkspaceStateManager.ctx().workspaceState.get<SortOrder>("sortOrder", "name");
  }

  static setSortOrder(order: SortOrder): void {
    WorkspaceStateManager.ctx().workspaceState.update("sortOrder", order);
  }

  // ── Pinned items ─────────────────────────────────────────────────────────────

  static getPinnedItems(): PinnedItem[] {
    return WorkspaceStateManager.ctx().workspaceState.get<PinnedItem[]>("pinnedItems", []);
  }

  static setPinnedItems(items: PinnedItem[]): void {
    WorkspaceStateManager.ctx().workspaceState.update("pinnedItems", items);
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
}
