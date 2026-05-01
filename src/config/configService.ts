import * as vscode from "vscode";
import { DescriptionFormat, DEFAULT_DESCRIPTION_FORMAT, SortOrder } from "../types";
import { DEFAULT_TIME_WINDOW_DAYS } from "../fresh-files/timeWindowUtils";
import { ConfigKeys } from "./configKeyConstants";
import { GroupingMode } from "../fresh-files/groupingMode";

/** Default color resolved from `contributes.colors` in the extension's own
 *  package.json — single source of truth, no duplicated hex tables. */
interface ContributedColor { id: string; defaults: Record<string, string> }

function pickDefault(defaults: Record<string, string>): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:             return defaults.light ?? defaults.dark ?? "#000000";
    case vscode.ColorThemeKind.HighContrast:      return defaults.highContrast ?? defaults.dark ?? "#000000";
    case vscode.ColorThemeKind.HighContrastLight: return defaults.highContrastLight ?? defaults.light ?? "#000000";
    default:                                       return defaults.dark ?? "#000000";
  }
}

function getContributedColors(): ContributedColor[] {
  const ext = vscode.extensions.getExtension("frehu.fresh-file-explorer");
  return (ext?.packageJSON?.contributes?.colors as ContributedColor[] | undefined) ?? [];
}

/** Resolve the 8-bucket palette for an `age` or `added` ID prefix, applying
 *  `workbench.colorCustomizations` overrides over the registered defaults. */
function resolvePalette(prefix: "age" | "added"): string[] {
  const customizations = vscode.workspace.getConfiguration("workbench").get<Record<string, string>>("colorCustomizations", {});
  const contributed = getContributedColors();
  return Array.from({ length: 8 }, (_, i) => {
    const id = `freshFileExplorer.heatmap.${prefix}${i + 1}`;
    const override = customizations[id];
    if (override) { return override; }
    const entry = contributed.find(c => c.id === id);
    return entry ? pickDefault(entry.defaults) : "#000000";
  });
}

/**
 * Centralized configuration service for Fresh File Explorer settings
 */
export class ConfigService {
  /**
   * Get the description format configuration
   */
  static getDescriptionFormat(): DescriptionFormat {
    return {
      showDate: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_DATE, DEFAULT_DESCRIPTION_FORMAT.showDate),
      showAuthor: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_AUTHOR, DEFAULT_DESCRIPTION_FORMAT.showAuthor),
      showCommitHash: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_COMMIT_HASH, DEFAULT_DESCRIPTION_FORMAT.showCommitHash),
      showCommitMessage: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_COMMIT_MESSAGE, DEFAULT_DESCRIPTION_FORMAT.showCommitMessage),
      showStatus: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_STATUS, DEFAULT_DESCRIPTION_FORMAT.showStatus),
      showLineChanges: vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.DESCRIPTION_SHOW_LINE_CHANGES, DEFAULT_DESCRIPTION_FORMAT.showLineChanges),
    };
  }

  /**
   * Get the auto-expand depth setting
   */
  static getAutoExpandDepth(): number {
    return vscode.workspace.getConfiguration().get<number>(ConfigKeys.AUTO_EXPAND_DEPTH, 2);
  }

  /**
   * Get the git timeout in milliseconds
   */
  static getGitTimeoutMs(): number {
    const timeoutSeconds = vscode.workspace.getConfiguration().get<number>(ConfigKeys.GIT_TIMEOUT, 30);
    return timeoutSeconds * 1000; // Convert to milliseconds
  }

  /**
   * Get the git timeout (alias for consistency)
   */
  static getGitTimeout(): number {
    return ConfigService.getGitTimeoutMs();
  }

  /**
   * Get the time window day values
   */
  static getTimeWindowDays(): number[] {
    const days = vscode.workspace.getConfiguration().get<number[]>(ConfigKeys.TIME_WINDOWS, DEFAULT_TIME_WINDOW_DAYS);
    return [...days].sort((a, b) => a - b);
  }

  /**
   * Get whether to show current branch sync status
   */
  static getShowCurrentBranchSync(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.SHOW_CURRENT_BRANCH_SYNC, true);
  }

  /**
   * Get whether to show base branch sync status
   */
  static getShowBaseBranchSync(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.SHOW_BASE_BRANCH_SYNC, true);
  }

  /**
   * Get the maximum length for search include patterns
   */
  static getSearchPatternMaxLength(): number {
    return vscode.workspace.getConfiguration().get<number>(ConfigKeys.SEARCH_PATTERN_MAX_LENGTH, 4000);
  }

  /**
   * Get whether to open search in editor instead of view
   */
  static getOpenSearchInEditor(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.OPEN_SEARCH_IN_EDITOR, false);
  }

  static getCodeTelescopeIntegration(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.CODE_TELESCOPE_INTEGRATION, false);
  }

  /**
   * Get whether to progressively update the tree at each time window threshold during history loading
   */
  static getincrementalTreeLoading(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.INCREMENTAL_TREE_LOADING, true);
  }

  /**
   * Get whether heatmap coloring is enabled
   */
  static isHeatmapEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.HEATMAP_ENABLED, false);
  }

  /**
   * Get whether the blame heatmap should auto-apply the last used mode when
   * switching to a new editor tab.
   */
  static getBlameHeatmapAutoApply(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.BLAME_HEATMAP_AUTO_APPLY, true);
  }

  static setBlameHeatmapAutoApply(value: boolean): Thenable<void> {
    return vscode.workspace.getConfiguration().update(
      ConfigKeys.BLAME_HEATMAP_AUTO_APPLY,
      value,
      vscode.ConfigurationTarget.Global,
    );
  }

  static getBlameHeatmapBackgroundOpacity(): number {
    return vscode.workspace.getConfiguration().get<number>(ConfigKeys.BLAME_HEATMAP_BG_OPACITY, 0.15);
  }

  static getBlameHeatmapMaxLines(): number {
    return vscode.workspace.getConfiguration().get<number>(ConfigKeys.BLAME_HEATMAP_MAX_LINES, 1500);
  }

  static getBlameHeatmapAgeColors(): string[] {
    return resolvePalette("age");
  }

  /**
   * Palette for "added in this branch" lines — visually distinct from the age
   * palette so users can distinguish brand-new code from modified code.
   */
  static getBlameHeatmapAddedColors(): string[] {
    return resolvePalette("added");
  }

  /**
   * Get whether the tree should automatically reveal the active editor's file
   */
  static getAutoReveal(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.AUTO_REVEAL, false);
  }

  /**
   * Get the default grouping mode (used when no workspace state is persisted yet)
   */
  static getDefaultGroupingMode(): GroupingMode {
    return vscode.workspace.getConfiguration().get<GroupingMode>(
      ConfigKeys.DEFAULT_GROUPING_MODE,
      "File Structure",
    );
  }

  /**
   * Get the default sort order (used when no workspace state is persisted yet)
   */
  static getDefaultSortOrder(): SortOrder {
    return vscode.workspace.getConfiguration().get<SortOrder>(
      ConfigKeys.DEFAULT_SORT_ORDER,
      "name",
    );
  }

  /**
   * Get the default open-changes mode (used when no workspace state is persisted yet)
   */
  static getDefaultOpenChangesMode(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(
      ConfigKeys.DEFAULT_OPEN_CHANGES_MODE,
      false,
    );
  }

  /**
   * Get the flat list label style.
   * "path" (default): repo-relative path is the label.
   * "filename": basename is the label; directory path is prepended to the description.
   */
  static getFlatListLabelStyle(): "path" | "filename" {
    return vscode.workspace.getConfiguration().get<"path" | "filename">(
      ConfigKeys.FLAT_LIST_LABEL_STYLE,
      "path",
    );
  }

  /**
   * Get whether to use git mv for renames (auto-stages the rename)
   */
  static getAutoStageRename(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.AUTO_STAGE_RENAME, true);
  }

}
