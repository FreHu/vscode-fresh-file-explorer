import { normalizePath } from "../pathTypes";

/** Worktree root from the contents of `<common>/worktrees/<name>/gitdir`, which holds `<worktree>/.git`. */
export function worktreePathFromGitdirFile(content: string): string | undefined {
  const gitFile = normalizePath(content.trim());
  return gitFile.endsWith("/.git") ? gitFile.slice(0, -"/.git".length) : undefined;
}

/**
 * Compare the worktrees git lists for one common dir with the ones discovery knows.
 * `listed` holds only worktrees whose folder still exists, so a stale entry (folder
 * deleted without `git worktree prune`) neither counts as added nor keeps a removed one.
 */
export function diffWorktrees(opts: {
  listed: readonly string[];
  known: readonly string[];
  workspaceRoots: readonly string[];
  caseInsensitive: boolean;
}): { added: string[]; removed: string[] } {
  const key = (p: string) => opts.caseInsensitive ? p.toLowerCase() : p;
  const roots = opts.workspaceRoots.map(key);
  const inWorkspace = (p: string) => roots.some(r => p === r || p.startsWith(r + "/"));
  const listed = new Set(opts.listed.map(key));
  const known = new Set(opts.known.map(key));
  return {
    added: opts.listed.filter(p => inWorkspace(key(p)) && !known.has(key(p))),
    removed: opts.known.filter(p => !listed.has(key(p))),
  };
}
