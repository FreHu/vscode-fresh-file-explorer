// Pure, vscode-free: imported by both the extension host and the settings webview bundle.
import { parseHeadOffset } from "../git/refSyntax";

/** Display-friendly ref name; empty becomes `"?"`. */
export function displayRef(ref: string): string {
  return ref || "?";
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
