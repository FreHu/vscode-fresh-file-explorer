import * as vscode from "vscode";
import { DescriptionFormat, DEFAULT_DESCRIPTION_FORMAT } from "../types";
import { DEFAULT_TIME_WINDOW_DAYS } from "../fresh-files/timeWindowUtils";
import { ConfigKeys } from "./constants";

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
   * Get whether the tree should automatically reveal the active editor's file
   */
  static getAutoReveal(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ConfigKeys.AUTO_REVEAL, false);
  }

}
