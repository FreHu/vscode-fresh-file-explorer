import type { CommitData } from "./messages";

/**
 * Search over the in-memory commit list backing the log -L / file history panel.
 *
 * DOM-free on purpose: the panel's collapsed hunks are `display: none`, which
 * VS Code's find widget (`window.find`) cannot see, so matching has to run on
 * the data rather than the rendered tree.
 */

export type LogLSearchScope = "all" | "message" | "diff";

export interface LogLSearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scope: LogLSearchScope;
}

/** Half-open [start, end) offsets of one match within a single line. */
export type MatchRange = readonly [number, number];

export interface HunkLineMatch {
  /** Index into the hunk's `\n`-split lines. */
  line: number;
  ranges: MatchRange[];
}

export interface CommitMatch {
  hash: string;
  /** Index into the searched `commits` array. */
  index: number;
  messageRanges: MatchRange[];
  hunkLines: HunkLineMatch[];
  /** messageRanges + every hunk line's ranges. */
  count: number;
}

export interface LogLSearchResult {
  matches: CommitMatch[];
  totalMatches: number;
  /** Commits with at least one match. */
  commitCount: number;
  /** Non-null when `isRegex` and the pattern failed to compile. */
  error: string | null;
}

const EMPTY: LogLSearchResult = { matches: [], totalMatches: 0, commitCount: 0, error: null };

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns null for an empty query, an Error for an uncompilable regex. */
export function compileMatcher(query: LogLSearchQuery): RegExp | Error | null {
  if (!query.text) { return null; }
  const source = query.isRegex ? query.text : escapeRegex(query.text);
  const flags = query.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export function findRanges(text: string, re: RegExp): MatchRange[] {
  const ranges: MatchRange[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    // Zero-length matches (e.g. /x*/) would spin forever without this.
    if (m[0].length === 0) { re.lastIndex++; }
  }
  return ranges;
}

export function searchCommits(commits: readonly CommitData[], query: LogLSearchQuery): LogLSearchResult {
  const matcher = compileMatcher(query);
  if (matcher === null) { return EMPTY; }
  if (matcher instanceof Error) { return { ...EMPTY, error: matcher.message }; }

  const searchMessage = query.scope !== "diff";
  const searchDiff = query.scope !== "message";
  const matches: CommitMatch[] = [];
  let totalMatches = 0;

  commits.forEach((commit, index) => {
    const messageRanges = searchMessage ? findRanges(commit.message, matcher) : [];
    const hunkLines: HunkLineMatch[] = [];
    if (searchDiff && commit.hunk) {
      commit.hunk.split("\n").forEach((line, lineIdx) => {
        const ranges = findRanges(line, matcher);
        if (ranges.length > 0) { hunkLines.push({ line: lineIdx, ranges }); }
      });
    }

    const count = messageRanges.length + hunkLines.reduce((n, l) => n + l.ranges.length, 0);
    if (count === 0) { return; }
    matches.push({ hash: commit.hash, index, messageRanges, hunkLines, count });
    totalMatches += count;
  });

  return { matches, totalMatches, commitCount: matches.length, error: null };
}

/** Human-readable result summary, e.g. "12 matches in 8 commits". */
export function describeResult(result: LogLSearchResult): string {
  if (result.error) { return "Invalid regex"; }
  if (result.totalMatches === 0) { return "No matches"; }
  const m = result.totalMatches === 1 ? "1 match" : `${result.totalMatches} matches`;
  const c = result.commitCount === 1 ? "1 commit" : `${result.commitCount} commits`;
  return `${m} in ${c}`;
}

export interface TextSegment {
  text: string;
  hit: boolean;
}

/**
 * Splits `text` into alternating plain / matched segments. Callers escape each
 * segment themselves, so highlighting never has to build raw HTML from ranges.
 * Overlapping or unsorted ranges are normalized; zero-length ranges dropped.
 */
export function splitByRanges(text: string, ranges: readonly MatchRange[]): TextSegment[] {
  if (ranges.length === 0) { return text ? [{ text, hit: false }] : []; }

  const sorted = [...ranges]
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) { continue; }              // fully swallowed by previous range
    const from = Math.max(start, cursor);
    if (from > cursor) { segments.push({ text: text.slice(cursor, from), hit: false }); }
    segments.push({ text: text.slice(from, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) { segments.push({ text: text.slice(cursor), hit: false }); }
  return segments;
}
