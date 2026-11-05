/**
 * What a changed file means for a repo we watch ourselves:
 * - `head`: HEAD may point elsewhere (HEAD itself, the current branch's ref, packed-refs)
 * - `pending`: uncommitted state may differ (the index, or a working-tree file)
 * - `ignore`: anything else (other branches' refs, logs, other worktrees' git dirs)
 */
export type RepoChangeKind = "head" | "pending" | "ignore";

export interface WatchedRepoDirs {
  root: string;
  gitDir: string;
  commonDir: string;
  /** Current branch, from HEAD. Undefined when detached. */
  branch: string | undefined;
}

/** All paths normalized to forward slashes. */
export function classifyRepoChange(path: string, repo: WatchedRepoDirs, caseInsensitive: boolean): RepoChangeKind {
  const key = (p: string) => caseInsensitive ? p.toLowerCase() : p;
  const p = key(path);
  // Only the directory prefix is compared case-insensitively; git's own file names are exact.
  const relTo = (dir: string): string | undefined => {
    const d = key(dir);
    return p.startsWith(d + "/") ? path.slice(d.length + 1) : undefined;
  };

  const inCommon = relTo(repo.commonDir);
  if (inCommon !== undefined) {
    if (inCommon === "packed-refs") { return "head"; }
    if (repo.branch && inCommon === `refs/heads/${repo.branch}`) { return "head"; }
  }
  const inGitDir = relTo(repo.gitDir);
  if (inGitDir !== undefined) {
    if (inGitDir === "HEAD") { return "head"; }
    if (inGitDir === "index") { return "pending"; }
    return "ignore";
  }
  if (inCommon !== undefined) { return "ignore"; }

  const inRoot = relTo(repo.root);
  if (inRoot === undefined || inRoot === ".git" || inRoot.startsWith(".git/")) { return "ignore"; }
  return "pending";
}

/** Branch name from the contents of a HEAD file; undefined when detached. */
export function branchFromHeadFile(content: string): string | undefined {
  const m = /^ref: refs\/heads\/(.+)$/.exec(content.trim());
  return m ? m[1] : undefined;
}
