// Pure heatmap computation extracted from BlameHeatmapController.
//
// These functions take blame/diff data and produce the windowing + bucket
// decisions that drive gutter colouring. They are deliberately free of any
// `vscode` dependency so they can be unit-tested directly (see
// blameHeatmapCompute.unit.test.ts). The controller keeps the I/O (git calls,
// decoration creation) and delegates the math here.

import type { BlameLineInfo } from "../git/blameDiffParsers";
import { blameTimestampToBucket } from "./heatmapUtils";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A line → bucket mapping. Returns -1 to signal "skip this line" (no decoration). */
export type BucketFn = (sha: string, timestamp: number) => number;

export interface WindowResult {
  /** Span (in days) the colour palette is stretched across. */
  windowDays: number;
  getBucket: BucketFn;
}

/**
 * Branch mode: only lines whose commit is part of the branch (between merge-base
 * and HEAD) get a bucket; everything older returns -1.
 *
 * The window spans the actual age range of branch-touched lines in *this file*
 * (oldest branch line → now), not merge-base→now. Anchoring on merge-base
 * collapses every line into bucket 0 when the branch's edits cluster near the
 * recent end of a long-lived branch, flattening the palette to a single colour.
 */
export function computeBranchWindow(
  blameLines: BlameLineInfo[],
  branchCommitShas: Set<string>,
  nowMs: number,
): WindowResult & { branchLinesInFile: number } {
  const branchLineTimestamps = blameLines
    .filter(l => branchCommitShas.has(l.sha))
    .map(l => l.timestamp);
  const oldestBranchTimestamp = branchLineTimestamps.length > 0
    ? Math.min(...branchLineTimestamps)
    : Math.floor(nowMs / 1000); // no branch lines in this file → window irrelevant
  const windowDays = Math.max(1, (nowMs - oldestBranchTimestamp * 1000) / MS_PER_DAY);
  const getBucket: BucketFn = (sha, timestamp) =>
    branchCommitShas.has(sha) ? blameTimestampToBucket(timestamp, windowDays, nowMs) : -1;
  return { windowDays, getBucket, branchLinesInFile: branchLineTimestamps.length };
}

/**
 * Absolute mode: derive the window from the oldest line in the file so the full
 * colour range is always used regardless of configured time windows.
 */
export function computeAbsoluteWindow(
  blameLines: BlameLineInfo[],
  nowMs: number,
): WindowResult {
  const oldestTimestamp = Math.min(...blameLines.map(l => l.timestamp));
  const windowDays = Math.max(1, (nowMs - oldestTimestamp * 1000) / MS_PER_DAY);
  const getBucket: BucketFn = (_sha, timestamp) => blameTimestampToBucket(timestamp, windowDays, nowMs);
  return { windowDays, getBucket };
}

/**
 * Whether a branch-mode file is *genuinely* new since the merge base — every
 * line a fresh addition.
 *
 * A fully-rewritten file (existed at merge base, every line replaced) also
 * blames entirely to the branch with no pure-deletion hunks, but it is NOT new:
 * we want normal age decorations there. So a file only counts as all-new when it
 * did not exist at the merge base AND produced no deletion hunks.
 */
export function detectAllNewFile(
  blameLines: BlameLineInfo[],
  branchCommitShas: Set<string>,
  existedAtMergeBase: boolean,
  hasDeletions: boolean,
): boolean {
  if (existedAtMergeBase || hasDeletions) { return false; }
  return blameLines.every(l => branchCommitShas.has(l.sha));
}

/**
 * Clamp a deletion hunk's 1-based "after this new-file line" anchor to a valid
 * 0-based editor line index. A value of 0 means the deletion sits before the
 * first surviving line.
 */
export function clampDeletionLineIndex(afterNewLine1: number, lineCount: number): number {
  return Math.max(0, Math.min(afterNewLine1, lineCount) - 1);
}
