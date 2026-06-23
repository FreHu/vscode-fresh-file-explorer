import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { CommitHash, asCommitHash } from "../types";
import { decodeGitPath, execGitWithArgs } from "../git/gitOperations";
import { parseCommitDate } from "../git/gitDateUtils";
import { escapeRegex } from "../utils/formatUtils";
import { isPathWithinRoot } from "../utils/pathUtils";
import { log } from "../extension/logger";
import { ConfigService } from "../config/configService";

/**
 * Git config can silently break diff parsing: `diff.noprefix` drops the `b/` we key on
 * (→ zero matches), `diff.mnemonicPrefix` swaps it for `w/`/`i/`, and `log.showSignature`
 * interleaves GPG lines. Force the formats this parser expects regardless of the user's
 * global config. (`log.date` is overridden per-call with `--date=default`.)
 */
const DIFF_PREFIX_FLAGS = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];
const LOG_CONFIG_FLAGS = [...DIFF_PREFIX_FLAGS, "-c", "log.showSignature=false"];

/**
 * Thrown when the search pattern compiles in JS but git's regex engine rejects it.
 *
 * The two engines differ: git pickaxe (`-G`) uses POSIX ERE while the panel pre-validates
 * and the line-level display filter ({@link filterMatchesByPattern}) use JS `RegExp`. A
 * pattern can be valid in one and not the other — e.g. `foo\1` (JS treats it as a
 * backreference, git rejects it) or `a{` (JS reads `{` as a literal, git errors). Such a
 * pattern clears the JS pre-check, then git fails mid-search. Surfacing this as an error
 * beats silently reporting "No matches".
 */
export class DiffSearchPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffSearchPatternError";
  }
}

/** True when git's stderr indicates the pickaxe regex failed to compile (POSIX ERE). */
export function isGitRegexError(stderr: string): boolean {
  return /invalid regex/i.test(stderr);
}

/**
 * Re-throw a swallowed git error as {@link DiffSearchPatternError} when it's a regex
 * compile failure, so callers surface it instead of treating it as "no matches". Other
 * errors are left for the caller to handle (e.g. log-and-continue).
 */
function throwIfGitRegexError(err: unknown, isRegex: boolean): void {
  if (!isRegex) { return; }
  const msg = typeof err === "string" ? err : (err as { message?: string })?.message ?? String(err);
  if (isGitRegexError(msg)) {
    throw new DiffSearchPatternError(msg.trim());
  }
}

/**
 * Represents a single match found in a diff
 */
export interface DiffMatch {
  filePath: AbsolutePath;
  lineNumber: number;
  lineContent: string;
  changeType: "added" | "removed";
  commitHash?: CommitHash;
  commitMessage?: string;
  commitDate?: Date;
  /** Committer's timezone offset in minutes east of UTC (from `git log` Date: header). */
  commitTzOffsetMinutes?: number;
  isStaged?: boolean; // For pending changes: true = staged, false = unstaged
  fileAdded?: boolean; // True if file was newly added in this commit (no parent version)
}

/**
 * Search for a pattern in historical diffs within a time window
 * Uses streaming to handle unlimited history without memory issues
 * @param repoPath Absolute path to the Git repository
 * @param pattern Search pattern (can be regex or plain text)
 * @param isRegex Whether the pattern should be treated as regex
 * @param caseInsensitive Whether the search should be case-insensitive
 * @param includePattern Comma-separated glob patterns to include (e.g. "*.ts,src/**")
 * @param excludePattern Comma-separated glob patterns to exclude (e.g. "*.test.ts,dist/**")
 * @param sinceDays Days to look back (-1 for unlimited/all history); may be fractional (e.g. 0.25 = 6h)
 * @param includeMerges Include merge commits' first-parent diff (default git log -p omits merges)
 * @param onBatch Optional callback for progressive results (called periodically with new matches)
 * @param onCommitFound Optional callback for commit progress tracking
 * @returns Array of diff matches
 */
export async function searchHistoricalDiffs(
  repoPath: string,
  pattern: string,
  isRegex: boolean,
  caseInsensitive: boolean,
  includePattern: string,
  excludePattern: string,
  sinceDays: number,
  includeMerges: boolean,
  onBatch?: (matches: DiffMatch[]) => void,
  onCommitFound?: (commitNumber: number) => void
): Promise<DiffMatch[]> {
  if (!pattern) {
    return [];
  }

  try {
    const args = buildHistoricalSearchArgs({
      pattern, isRegex, caseInsensitive, includePattern, excludePattern,
      sinceDays, includeMerges, nowMs: Date.now(),
    });

    // For unlimited searches, don't use timeout (let it run as long as needed)
    // For time-limited searches, use configured timeout
    const timeout = sinceDays === -1 ? undefined : ConfigService.getGitTimeout();

    // Prepare filter for batches
    const regexFlags = caseInsensitive ? "i" : "";
    const searchRegex = isRegex ? new RegExp(pattern, regexFlags) : null;
    
    // Wrap callback to filter batches before sending to tree view
    const filteredOnBatch = onBatch ? (matches: DiffMatch[]) => {
      const filtered = filterMatchesByPattern(matches, pattern, searchRegex, caseInsensitive);
      if (filtered.length > 0) {
        onBatch(filtered);
      }
    } : undefined;

    // Stream and parse the output incrementally
    const allMatches = await streamGitDiffOutput(args, repoPath, timeout, true, filteredOnBatch, onCommitFound);
    
    // Filter final results (for the returned array)
    const filtered = filterMatchesByPattern(allMatches, pattern, searchRegex, caseInsensitive);
    return filtered;
  } catch (error: any) {
    // A git-side regex compile failure must surface, not masquerade as "no matches".
    // (streamGitDiffOutput rejects with git's stderr string; the child 'error' event
    // rejects with a message string.)
    const msg = typeof error === "string" ? error : error?.message ?? String(error);
    if (isRegex && isGitRegexError(msg)) {
      throw new DiffSearchPatternError(msg.trim());
    }
    // Log other errors for debugging; stay resilient (e.g. empty repo) and return nothing.
    log(`Historical diff search error: ${error}`, "error");
    return [];
  }
}

/**
 * Creates a stateful line processor for `git log -p` / `git diff` output.
 * Extracted for testability — `parseDiffOutput` and `streamGitDiffOutput` both use it.
 *
 * @param cwd         Repo root prepended to relative file paths in the output.
 * @param extractCommitInfo  Whether to parse commit/author/date headers (git log -p).
 * @param onMatch     Called for every added/removed diff line that is parsed.
 * @param onCommitFound  Optional progress callback, called per commit header parsed.
 */
function createDiffLineProcessor(
  cwd: string,
  extractCommitInfo: boolean,
  onMatch: (match: DiffMatch) => void,
  onCommitFound?: (commitNumber: number) => void,
): (line: string) => void {
  let currentFile: string | null = null;
  let currentFileAdded = false;
  let currentCommit: CommitHash | undefined;
  let currentCommitMessage: string | undefined;
  let currentCommitDate: Date | undefined;
  let currentCommitTzOffsetMinutes: number | undefined;
  let addedLineNum = 0;
  let removedLineNum = 0;
  let commitCount = 0;

  return function processLine(line: string) {
    // Parse commit header (from git log -p)
    if (extractCommitInfo && line.startsWith("commit ")) {
      const hash = line.substring(7, 47).trim();
      currentCommit = asCommitHash(hash);
      currentCommitMessage = undefined;
      currentCommitDate = undefined;
      currentCommitTzOffsetMinutes = undefined;
      commitCount++;
      if (onCommitFound) {
        onCommitFound(commitCount);
      }
      return;
    }

    // Parse commit date
    if (extractCommitInfo && currentCommit && line.startsWith("Date:   ")) {
      const dateStr = line.substring(8).trim();
      const parsed = parseCommitDate(dateStr);
      currentCommitDate = parsed.date;
      currentCommitTzOffsetMinutes = parsed.tzOffsetMinutes;
      return;
    }

    // Parse commit message
    if (extractCommitInfo && currentCommit && line.startsWith("    ") && !currentCommitMessage) {
      currentCommitMessage = line.trim();
      return;
    }

    // Parse diff header
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      currentFileAdded = false;
      return;
    }

    // Detect new file
    if (line.startsWith("new file mode")) {
      currentFileAdded = true;
      return;
    }

    // Skip binary files
    if (line.startsWith("Binary files ")) {
      currentFile = null;
      return;
    }

    // Parse file path from +++ b/path
    if (line.startsWith("+++ b/")) {
      let filePath = line.substring(6);
      filePath = decodeGitPath(filePath);
      const absolutePath = asAbsolutePath(`${cwd}/${filePath}`);
      currentFile = absolutePath;
      return;
    }

    // Parse hunk header
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        removedLineNum = parseInt(match[1], 10);
        addedLineNum = parseInt(match[2], 10);
      }
      return;
    }

    // Parse diff lines
    if (currentFile && line.length > 0) {
      const prefix = line[0];

      if (prefix === "+") {
        onMatch({
          filePath: currentFile as AbsolutePath,
          lineNumber: addedLineNum,
          lineContent: line.substring(1),
          changeType: "added",
          commitHash: currentCommit,
          commitMessage: currentCommitMessage,
          commitDate: currentCommitDate,
          commitTzOffsetMinutes: currentCommitTzOffsetMinutes,
          fileAdded: currentFileAdded,
        });
        addedLineNum++;
      } else if (prefix === "-") {
        onMatch({
          filePath: currentFile as AbsolutePath,
          lineNumber: removedLineNum,
          lineContent: line.substring(1),
          changeType: "removed",
          commitHash: currentCommit,
          commitMessage: currentCommitMessage,
          commitDate: currentCommitDate,
          commitTzOffsetMinutes: currentCommitTzOffsetMinutes,
        });
        removedLineNum++;
      } else if (prefix === " ") {
        addedLineNum++;
        removedLineNum++;
      }
    }
  };
}

/**
 * Parse raw `git log -p` or `git diff` text into an array of diff matches.
 * Pure function with no I/O — suitable for unit testing.
 *
 * @param raw              Full text output from git.
 * @param cwd              Repo root used to build absolute file paths.
 * @param extractCommitInfo  Pass `true` for `git log -p` output, `false` for plain `git diff`.
 */
export function parseDiffOutput(raw: string, cwd: string, extractCommitInfo: boolean): DiffMatch[] {
  const matches: DiffMatch[] = [];
  const processLine = createDiffLineProcessor(cwd, extractCommitInfo, m => matches.push(m));
  for (const line of raw.split("\n")) {
    processLine(line);
  }
  return matches;
}

/**
 * Execute git command and stream/parse output line-by-line to avoid memory issues
 * Supports incremental result callbacks for live UI updates
 */
function streamGitDiffOutput(
  args: string[],
  cwd: string,
  timeout: number | undefined,
  extractCommitInfo: boolean,
  onBatch?: (matches: DiffMatch[]) => void,
  onCommitFound?: (commitNumber: number) => void
): Promise<DiffMatch[]> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    const matches: DiffMatch[] = [];

    // Batching for incremental updates
    let batchBuffer: DiffMatch[] = [];
    const BATCH_SIZE = 250;
    let lastBatchTime = Date.now();
    const BATCH_INTERVAL = 1000;

    function flushBatch() {
      if (batchBuffer.length > 0 && onBatch) {
        onBatch(batchBuffer);
        batchBuffer = [];
        lastBatchTime = Date.now();
      }
    }

    function addMatch(match: DiffMatch) {
      matches.push(match);
      batchBuffer.push(match);
      if (batchBuffer.length >= BATCH_SIZE || Date.now() - lastBatchTime >= BATCH_INTERVAL) {
        flushBatch();
      }
    }

    let buffer = "";
    const processLine = createDiffLineProcessor(cwd, extractCommitInfo, addMatch, onCommitFound);

    // Stream stdout data in chunks
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      
      // Process complete lines
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";
      
      // Process each complete line
      for (const line of lines) {
        processLine(line);
      }
    });

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error.message);
    });

    child.on("close", (code) => {
      // Flush any remaining batched matches
      flushBatch();
      
      // Process any remaining buffered content
      if (buffer.trim()) {
        processLine(buffer);
        flushBatch(); // Flush again in case processLine added matches
      }
      
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve(matches);
      }
    });
  });
}

/**
 * Search for a pattern in pending (uncommitted) diffs
 * @param repoPath Absolute path to the Git repository
 * @param pattern Search pattern
 * @param isRegex Whether the pattern should be treated as regex
 * @param caseInsensitive Whether the search should be case-insensitive
 * @param includePattern Comma-separated glob patterns to include
 * @param excludePattern Comma-separated glob patterns to exclude
 * @param onBatch Optional callback for progressive results
 * @returns Array of diff matches from staged and unstaged changes
 */
/**
 * Search for a pattern in untracked files (new files not yet staged or committed).
 * These are invisible to `git diff` / `git diff --staged`, so we list them with
 * `git ls-files --others --exclude-standard` and read each file directly.
 */
/**
 * Pure function: scan `lines` of a single file and return a DiffMatch for every line that
 * satisfies the search criteria. Used by searchUntrackedFiles and directly testable.
 */
export function matchFileLines(
  lines: string[],
  filePath: AbsolutePath,
  pattern: string,
  isRegex: boolean,
  caseInsensitive: boolean,
): DiffMatch[] {
  const regexFlags = caseInsensitive ? "i" : "";
  const searchRegex = isRegex ? new RegExp(pattern, regexFlags) : null;
  const lowerPattern = caseInsensitive ? pattern.toLowerCase() : "";
  const matches: DiffMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched: boolean;
    if (searchRegex) {
      matched = searchRegex.test(line);
    } else if (caseInsensitive) {
      matched = line.toLowerCase().includes(lowerPattern);
    } else {
      matched = line.includes(pattern);
    }

    if (matched) {
      matches.push({
        filePath,
        lineNumber: i + 1,
        lineContent: line,
        changeType: "added",
        isStaged: false,
        fileAdded: true,
      });
    }
  }

  return matches;
}

async function searchUntrackedFiles(
  repoPath: string,
  pattern: string,
  isRegex: boolean,
  caseInsensitive: boolean,
  includePattern: string,
  excludePattern: string,
): Promise<DiffMatch[]> {
  const pathspecs = buildPathspecs(includePattern, excludePattern);
  const args = pathspecs.length > 0
    ? ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs]
    : ["ls-files", "--others", "--exclude-standard"];

  let output: string;
  try {
    output = await execGitWithArgs(args, repoPath, { timeout: ConfigService.getGitTimeout() });
  } catch (err) {
    log(`Untracked files listing error: ${err}`, "warn");
    return [];
  }

  const relPaths = output.split("\n").map(l => l.trim()).filter(Boolean);
  if (relPaths.length === 0) {
    return [];
  }

  const matches: DiffMatch[] = [];
  const repoRoot = asAbsolutePath(repoPath);

  for (const relPath of relPaths) {
    const decodedPath = decodeGitPath(relPath);
    const absPath = asAbsolutePath(path.join(repoPath, decodedPath));

    // Security: ensure the resolved path is within the repo root
    if (!isPathWithinRoot(absPath, repoRoot)) {
      log(`Skipping untracked path outside repo root: ${absPath}`, "warn");
      continue;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(absPath, "utf8");
    } catch (err) {
      log(`Could not read untracked file ${absPath}: ${err}`, "warn");
      continue;
    }

    const lines = content.split("\n").map(l => l.replace(/\r$/, ""));
    const fileMatches = matchFileLines(lines, absPath, pattern, isRegex, caseInsensitive);
    matches.push(...fileMatches);
  }

  return matches;
}

export async function searchPendingDiffs(
  repoPath: string,
  pattern: string,
  isRegex: boolean,
  caseInsensitive: boolean,
  includePattern: string,
  excludePattern: string,
  onBatch?: (matches: DiffMatch[]) => void
): Promise<DiffMatch[]> {
  if (!pattern) {
    return [];
  }

  const matches: DiffMatch[] = [];
  const regexFlags = caseInsensitive ? "i" : "";
  const searchRegex = isRegex ? new RegExp(pattern, regexFlags) : null;
  const timeout = ConfigService.getGitTimeout();

  try {
    const argOpts = { pattern, isRegex, caseInsensitive, includePattern, excludePattern };

    // Search unstaged changes (working tree vs index)
    const unstagedArgs = buildPendingSearchArgs({ ...argOpts, staged: false });

    try {
      // Don't pass onBatch here because we filter line-by-line afterwards.
      const unstagedMatches = await streamGitDiffOutput(unstagedArgs, repoPath, timeout, false);
      const filtered = filterMatchesByPattern(unstagedMatches, pattern, searchRegex, caseInsensitive);
      filtered.forEach(m => {
        m.isStaged = false;
        matches.push(m);
      });

      // If we have a callback and found matches, send them as a batch
      if (onBatch && filtered.length > 0) {
        onBatch(filtered);
      }
    } catch (err) {
      throwIfGitRegexError(err, isRegex); // surface a bad pattern; don't mask as "no changes"
      log(`Unstaged diff search error: ${err}`, "warn");
    }

    // Search staged changes (index vs HEAD)
    const stagedArgs = buildPendingSearchArgs({ ...argOpts, staged: true });

    try {
      const stagedMatches = await streamGitDiffOutput(stagedArgs, repoPath, timeout, false);
      const filtered = filterMatchesByPattern(stagedMatches, pattern, searchRegex, caseInsensitive);
      filtered.forEach(m => {
        m.isStaged = true;
        matches.push(m);
      });

      // If we have a callback and found matches, send them as a batch
      if (onBatch && filtered.length > 0) {
        onBatch(filtered);
      }
    } catch (err) {
      throwIfGitRegexError(err, isRegex);
      log(`Staged diff search error: ${err}`, "warn");
    }

    // Search untracked files (new files not yet added to git)
    try {
      const untrackedMatches = await searchUntrackedFiles(
        repoPath, pattern, isRegex, caseInsensitive, includePattern, excludePattern
      );
      if (untrackedMatches.length > 0) {
        untrackedMatches.forEach(m => matches.push(m));
        if (onBatch) {
          onBatch(untrackedMatches);
        }
      }
    } catch (err) {
      log(`Untracked files search error: ${err}`, "warn");
    }
  } catch (error: any) {
    if (error instanceof DiffSearchPatternError) { throw error; } // bubble up to the panel
    log(`Pending diff search error: ${error}`, "error");
  }

  return matches;
}

/**
 * Filter diff matches by pattern (needed because git diff doesn't support -G/-S)
 */
export function filterMatchesByPattern(matches: DiffMatch[], pattern: string, regex: RegExp | null, caseInsensitive: boolean): DiffMatch[] {
  if (regex) {
    return matches.filter(m => regex.test(m.lineContent));
  } else if (caseInsensitive) {
    const lowerPattern = pattern.toLowerCase();
    return matches.filter(m => m.lineContent.toLowerCase().includes(lowerPattern));
  } else {
    return matches.filter(m => m.lineContent.includes(pattern));
  }
}

export interface HistoricalSearchArgsOptions {
  pattern: string;
  isRegex: boolean;
  caseInsensitive: boolean;
  includePattern: string;
  excludePattern: string;
  /** Days to look back; -1 (or any non-positive) means unlimited. May be fractional. */
  sinceDays: number;
  /** Include merge commits' first-parent diff (plain `git log -p` omits merge diffs). */
  includeMerges: boolean;
  /** "Now" in epoch ms, used to compute the `--since` cutoff. */
  nowMs: number;
}

/**
 * Build the `git log` argument vector for a historical pickaxe search. Pure and
 * deterministic given `nowMs`, so the flag/cutoff logic is unit-testable without git.
 *
 * Notes baked in here:
 * - LOG_CONFIG_FLAGS + `--date=default` neutralize user git config that would break parsing.
 * - Merges: `--diff-merges=first-parent` surfaces merge commits with a single diff vs the
 *   mainline (plain `-p` shows no merge diff, so pickaxe can't match them).
 * - Time window: an exact ISO `--since`, not approxidate "N.days.ago", which silently
 *   mishandles fractional days (sub-day windows like 6h = 0.25d).
 */
export function buildHistoricalSearchArgs(o: HistoricalSearchArgsOptions): string[] {
  const args = [
    ...LOG_CONFIG_FLAGS,
    "log",
    "-p",
    "--date=default",
    ...(o.includeMerges ? ["--diff-merges=first-parent"] : []),
    ...(o.caseInsensitive ? ["-i"] : []),
    o.isRegex ? "-G" : "-S",
    o.pattern,
  ];

  if (o.sinceDays > 0) {
    args.push(`--since=${new Date(o.nowMs - o.sinceDays * 86400000).toISOString()}`);
  }

  const pathspecs = buildPathspecs(o.includePattern, o.excludePattern);
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }

  return args;
}

export interface PendingSearchArgsOptions {
  /** false = working tree vs index (`git diff`); true = index vs HEAD (`git diff --staged`). */
  staged: boolean;
  pattern: string;
  isRegex: boolean;
  caseInsensitive: boolean;
  includePattern: string;
  excludePattern: string;
}

/**
 * Build the `git diff` argument vector for a pending (uncommitted) pickaxe search.
 *
 * Hands git the pickaxe so it pre-narrows to files that actually touched the pattern,
 * rather than streaming the entire working-tree diff for JS to filter. Always uses `-G`
 * (line-based — a changed line matched), never `-S` (net occurrence count): `-S` would drop
 * a same-line edit like `foo(1)`→`foo(2)` whose count is unchanged, yet the downstream line
 * filter keeps it, so `-S` would silently lose matches. A literal pattern is regex-escaped
 * so `-G` matches it verbatim; `-i` keeps the pre-filter case-insensitive in lockstep with
 * the line filter. The caller still runs a per-line filter for display.
 */
export function buildPendingSearchArgs(o: PendingSearchArgsOptions): string[] {
  const pickaxe = [
    ...(o.caseInsensitive ? ["-i"] : []),
    "-G",
    o.isRegex ? o.pattern : escapeRegex(o.pattern),
  ];
  const pathspecs = buildPathspecs(o.includePattern, o.excludePattern);
  const pathspecTail = pathspecs.length > 0 ? ["--", ...pathspecs] : [];
  return [
    ...DIFF_PREFIX_FLAGS,
    "diff",
    ...(o.staged ? ["--staged"] : []),
    ...pickaxe,
    ...pathspecTail,
  ];
}

/**
 * Convert comma-separated include/exclude pattern strings into git pathspec args.
 * Include globs are passed as-is; excludes use the :(exclude) pathspec magic.
 * If only excludes are specified, a leading "." is added to match everything first.
 */
export function buildPathspecs(includePattern: string, excludePattern: string): string[] {
  const includes = includePattern.split(",").map(p => p.trim()).filter(Boolean);
  const excludes = excludePattern.split(",").map(p => p.trim()).filter(Boolean);

  if (includes.length === 0 && excludes.length === 0) {
    return [];
  }

  const pathspecs: string[] = [];

  // If there are excludes but no includes, start with "." to match everything
  if (includes.length === 0 && excludes.length > 0) {
    pathspecs.push(".");
  } else {
    pathspecs.push(...includes);
  }

  for (const ex of excludes) {
    pathspecs.push(`:(exclude)${ex}`);
  }

  return pathspecs;
}

