// Pure, vscode-free: imported by both the extension host and the settings webview bundle.
import { parseHeadOffset } from "../git/refSyntax";

/** Display-friendly ref name; empty becomes `"?"`. */
export function displayRef(ref: string): string {
  return ref || "?";
}

/**
 * The tree message for a comparison whose source has no commits past the base.
 * `targetOnlyCommits` (commits on target, not on source) tells "same commit" apart
 * from "source is behind": only in the latter does swapping the sides show anything.
 */
export function emptyComparisonMessage(
  source: string,
  target: string,
  targetOnlyCommits: number | undefined,
): { label: string; tooltip?: string } {
  const t = displayRef(target);
  if (targetOnlyCommits === 0) {
    return { label: `No commits beyond ${t} yet`, tooltip: `${displayRef(source)} and ${t} point at the same commit.` };
  }
  if (targetOnlyCommits === undefined) {
    return { label: `Nothing new vs ${t}` };
  }
  return {
    label: `Nothing new vs ${t} · ${t} is ${targetOnlyCommits} commit${targetOnlyCommits === 1 ? "" : "s"} ahead`,
    tooltip: `Swap source and target to see what ${t} adds.`,
  };
}

/**
 * Name shown for a comparison the user hasn't named. `HEAD` vs `HEAD~N` reads
 * as "last N commits", so it follows the target when N is edited.
 */
export function defaultComparisonLabel(repoName: string, source: string, target: string): string {
  const offset = source.trim() === "HEAD" ? parseHeadOffset(target) : undefined;
  if (offset !== undefined) {
    return `${repoName} · last ${offset} commit${offset === 1 ? "" : "s"}`;
  }
  return `${repoName} · ${displayRef(source)}..${displayRef(target)}`;
}
