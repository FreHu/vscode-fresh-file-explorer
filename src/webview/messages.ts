// Shared message types between the extension host and webview scripts.
// This file is compiled by both tsconfig.json (extension host) and
// tsconfig.webview.json (webview scripts).

import type { GroupingMode } from "../fresh-files/groupingMode";
import type { DiffMode } from "../branch-compare/branchCompareConstants";

// ── Branch Compare settings panel ───────────────────────────────────────────

export interface SavedComparisonDTO {
  id: string;
  repoFullPath: string;
  source: string;
  target: string;
  label?: string;
  active: boolean;
  isHeatmapBaseline?: boolean;
  groupingMode: GroupingMode;
  diffMode: DiffMode;
  /** Hide files marked reviewed (per-comparison — see the "reviewed" checkbox on file/folder rows). */
  hideReviewed?: boolean;
  /** Auto-follow row (managed by AutoFollowController). Editing adopts it; deleting dismisses it. */
  auto?: boolean;
}

export interface RepoDTO {
  /** Normalized absolute path — used as the value when writing back. */
  fullPath: string;
  /** Display name for the picker — basename or workspace-folder name. */
  name: string;
  /** Current HEAD branch, if known. */
  currentBranch?: string;
}

export interface RefDTO {
  name: string;
  /** Human-readable relative committer date, e.g. "2 days ago". */
  relativeDate: string;
}

export interface RefValidationResult {
  /** Git resolved the ref. Includes the abbreviated SHA so the UI can hint what it pointed at. */
  valid: boolean;
  /** When valid: short SHA the ref resolves to. Useful as a tooltip hint. */
  resolvedSha?: string;
  /** When invalid: the stderr line from `git rev-parse`. */
  message?: string;
}

/**
 * Heatmap controls surfaced in the settings panel. The mode is workspace-state,
 * the two booleans are user-config — but they're a single coherent block to the
 * user, so the panel treats them uniformly.
 */
export interface HeatmapSettingsDTO {
  enabled: boolean;
  autoApply: boolean;
  /** `absolute` = age tint; `branch` = diff vs the starred baseline. */
  mode: "absolute" | "branch";
}

export type BranchCompareSettingsToWebview =
  | { command: "state"; repos: RepoDTO[]; comparisons: SavedComparisonDTO[]; autoFollow: boolean }
  | { command: "refs"; repoFullPath: string; branches: RefDTO[] }
  | {
      command: "refValidation";
      repoFullPath: string;
      ref: string;
      result: RefValidationResult;
    }
  | { command: "heatmapState"; settings: HeatmapSettingsDTO };

export type BranchCompareSettingsFromWebview =
  | { command: "ready" }
  | {
      command: "add";
      repoFullPath: string;
      source: string;
      target: string;
      label?: string;
    }
  | {
      command: "update";
      id: string;
      patch: Partial<Omit<SavedComparisonDTO, "id">>;
    }
  | { command: "delete"; id: string }
  | { command: "move"; id: string; delta: number }
  | { command: "moveTo"; id: string; targetIndex: number }
  | { command: "setHeatmapBaseline"; id: string | undefined }
  | { command: "setAllGroupingMode"; mode: GroupingMode }
  | { command: "requestRefs"; repoFullPath: string }
  | { command: "validateRef"; repoFullPath: string; ref: string }
  | { command: "refreshRefs" }
  | { command: "updateHeatmap"; patch: Partial<HeatmapSettingsDTO> }
  | { command: "setAutoFollow"; enabled: boolean }
  | { command: "openHeatmapHelp" };

// ── Git Log -L panel ─────────────────────────────────────────────────────────

export interface CommitData {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // ISO 8601
  message: string;
  hunk: string | null;
  added: number;
  removed: number;
  /** Non-null when the file had a different path at this commit (rename detected) */
  filePathAtCommit: string | null;
}

export type GitLogLToWebview =
  | { command: "setCommits"; commits: CommitData[]; label: string; gitCommand?: string; mode: "logL" | "fileHistory" };

export type GitLogLFromWebview =
  | { command: "ready" }
  | { command: "compare"; hashA: string; hashB: string }
  | { command: "openCommit"; hash: string }
  | { command: "openSingle"; hash: string };

// ── Diff Search panel ─────────────────────────────────────────────────────────

export interface DiffSearchParams {
  pattern: string;
  isRegex: boolean;
  caseInsensitive: boolean;
  includePattern: string;
  excludePattern: string;
  pendingOnly: boolean;
  /**
   * Time window as a duration token ("6h", "2w", "1mo") or bare day number;
   * empty string means full history. Parsed by `parseTimeWindowValue`.
   */
  window: string;
  /** Include merge commits (their first-parent diff) in the history search. */
  includeMerges: boolean;
}

export interface DiffSearchHistoryEntry {
  params: DiffSearchParams;
  label: string;      // human-readable summary
  timestamp: number;  // Date.now()
}

export type DiffSearchToWebview =
  | { command: "prefill"; pattern: string }
  | { command: "prefillParams"; params: DiffSearchParams }
  | { command: "setHistory"; entries: DiffSearchHistoryEntry[] }
  | { command: "reposStarted"; repoCount: number; repoNames: string[] }
  | { command: "repoProgress"; repoIndex: number; status: string }
  | { command: "repoComplete"; repoIndex: number; commits: number; matches: number; pendingMatches: number; elapsedMs?: number }
  | { command: "searchComplete"; message: string; count: number; gitCommand?: string };

export type DiffSearchFromWebview =
  | { command: "ready" }
  | { command: "clearHistory" }
  | {
      command: "search";
      pattern: string;
      isRegex: boolean;
      caseInsensitive: boolean;
      includePattern: string;
      excludePattern: string;
      pendingOnly: boolean;
      window: string;
      includeMerges: boolean;
    };

// ── Stonks panel ──────────────────────────────────────────────────────────────

export type XAxisMode = "commit" | "day" | "week" | "month";

export interface StonksDataPoint {
  hash?: string;
  author?: string;
  date: string; // ISO 8601
  /** Committer's timezone offset in minutes east of UTC. Only set in commit mode. */
  tzOffsetMinutes?: number;
  message?: string;
  filesChanged: number;
  filesAdded: number;
  filesDeleted: number;
  cumulativeFileCount: number;
  commitCount: number;
}

export interface StonksTimeWindowOption {
  label: string;
  /** undefined = pending changes mode */
  days: number | undefined;
}

export interface StonksConfig {
  sections: { fileCount: boolean; filesChanged: boolean; authors: boolean; velocity: boolean; churn: boolean; authorConcentration: boolean; commitSize: boolean; activityHeatmap: boolean };
  sectionOptions?: {
    authors?: { windowSize: number };
    authorConcentration?: { topX: number };
    commitSize?: { windowSize: number };
    activityHeatmap?: {
      workdayStart: number; // hour 0–23
      workdayEnd: number;   // hour 1–24
      /** Author whitelist. `undefined` = no filter (show all). */
      selectedAuthors?: string[];
    };
  };
  compareRepos?: boolean;
  maxVisibleTicks: number;
  selectedDays: number;
  xAxisMode: XAxisMode;
}

export interface StonksRepoSeries {
  repoName: string;
  repoPath: string;
  data: StonksDataPoint[];
}

export interface StonksRepoTicker {
  name: string;
  path: string;
  totalFiles?: number;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  lastCommitFilesChanged?: number;
  lastCommitFilesAdded?: number;
  lastCommitFilesDeleted?: number;
}

export type StonksToWebview =
  | { command: "setRepos"; repos: StonksRepoTicker[] }
  | { command: "setData"; data: StonksDataPoint[] }
  | { command: "setCompareData"; series: StonksRepoSeries[] }
  | { command: "setLoading"; loading: boolean }
  | { command: "setTimeWindows"; options: StonksTimeWindowOption[]; selectedDays: number | undefined }
  | { command: "setConfig"; config: StonksConfig };

export type StonksFromWebview =
  | { command: "ready" }
  | { command: "selectRepo"; repoPath: string }
  | { command: "openCommit"; hash: string }
  | { command: "selectTimeWindow"; days: number | undefined }
  | { command: "updateConfig"; config: StonksConfig }
  | { command: "requestCompareData" }
  | { command: "openHelp" }
  | { command: "exportSvg"; svg: string };
