/**
 * What kind of checkout a discovered repo root is. Drives the icon split VS
 * Code's Source Control view uses: `repo` / `worktree` / `archive`.
 */
export type RepoKind = "repo" | "worktree" | "submodule";

export function repoKindOf(r: { isWorktree?: boolean; isSubmodule?: boolean }): RepoKind {
  if (r.isSubmodule) { return "submodule"; }
  if (r.isWorktree) { return "worktree"; }
  return "repo";
}

/** Codicon id for the kind — mirrors the Source Control view. */
export function repoKindIcon(kind: RepoKind): string {
  switch (kind) {
    case "worktree": return "worktree";
    case "submodule": return "archive";
    default: return "repo";
  }
}

/** Extra tooltip line for non-plain kinds; undefined for an ordinary repo. */
export function repoKindLabel(kind: RepoKind): string | undefined {
  switch (kind) {
    case "worktree": return "Linked worktree";
    case "submodule": return "Submodule";
    default: return undefined;
  }
}
