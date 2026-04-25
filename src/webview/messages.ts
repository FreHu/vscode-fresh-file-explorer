// Shared message types between the extension host and webview scripts.
// This file is compiled by both tsconfig.json (extension host) and
// tsconfig.webview.json (webview scripts).

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
  days: number | null;
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
      days: number | null;
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
