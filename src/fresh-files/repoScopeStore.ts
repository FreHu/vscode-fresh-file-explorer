import { NormalizedRepoPath } from "../pathTypes";
import { RepoInfo } from "./dataCollector";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { GroupingMode } from "./groupingMode";

/**
 * Per-repo scoping state for the fresh-files tree: the git `pathspec` that
 * restricts which files a repo's `git log` reports, and the `folderScope` that
 * narrows the displayed tree to a subdirectory without re-running git.
 *
 * Also holds per-repo grouping overrides of the view-wide grouping mode.
 *
 * Owns the maps and their persistence (via {@link WorkspaceStateManager}),
 * plus the scope predicate. Deliberately does NOT trigger refreshes — callers
 * decide whether a change needs a git reload (pathspec) or a tree-only
 * re-render (folder scope). That keeps this a pure, host-free state holder,
 * unit-tested in `repoScopeStore.unit.test.ts`.
 */
export class RepoScopeStore {
  private _pathspecs: Map<NormalizedRepoPath, string> = new Map();
  private folderScopes: Map<NormalizedRepoPath, string> = new Map();
  private groupingModes: Map<NormalizedRepoPath, GroupingMode> = new Map();

  /** Load the maps from persisted workspace state. Call after `WorkspaceStateManager.initialize`. */
  load(): void {
    this._pathspecs = WorkspaceStateManager.getRepoPathspecs();
    this.folderScopes = WorkspaceStateManager.getRepoFolderScopes();
    this.groupingModes = WorkspaceStateManager.getRepoGroupingModes();
  }

  // ── Grouping overrides ─────────────────────────────────────────────────────

  /** The repo's own grouping mode, or `viewMode` when it has none. */
  groupingModeFor(repo: NormalizedRepoPath, viewMode: GroupingMode): GroupingMode {
    return this.groupingModes.get(repo) ?? viewMode;
  }

  /** A mode equal to the view-wide one clears the override, so later view-wide changes still apply. */
  setGroupingMode(repo: NormalizedRepoPath, mode: GroupingMode, viewMode: GroupingMode): void {
    if (mode === viewMode) {
      this.groupingModes.delete(repo);
    } else {
      this.groupingModes.set(repo, mode);
    }
    WorkspaceStateManager.setRepoGroupingModes(this.groupingModes);
  }

  clearGroupingModes(): void {
    this.groupingModes.clear();
    WorkspaceStateManager.setRepoGroupingModes(this.groupingModes);
  }

  // ── Pathspecs ──────────────────────────────────────────────────────────────

  getPathspec(repo: NormalizedRepoPath): string | undefined {
    return this._pathspecs.get(repo);
  }

  /** Set or clear (on `undefined`) a repo's pathspec, persisting the change. */
  setPathspec(repo: NormalizedRepoPath, pathspec: string | undefined): void {
    if (pathspec) {
      this._pathspecs.set(repo, pathspec);
    } else {
      this._pathspecs.delete(repo);
    }
    WorkspaceStateManager.setRepoPathspec(repo, pathspec || undefined);
  }

  /** Live map of active pathspecs — for cache APIs that take the whole map. */
  get pathspecs(): Map<NormalizedRepoPath, string> {
    return this._pathspecs;
  }

  // ── Folder scopes ────────────────────────────────────────────────────────────

  getFolderScope(repo: NormalizedRepoPath): string | undefined {
    return this.folderScopes.get(repo);
  }

  /** Set or clear (on `undefined`) a repo's folder scope, persisting the change. */
  setFolderScope(repo: NormalizedRepoPath, folderPath: string | undefined): void {
    if (folderPath) {
      this.folderScopes.set(repo, folderPath);
    } else {
      this.folderScopes.delete(repo);
    }
    WorkspaceStateManager.setRepoFolderScope(repo, folderPath);
  }

  hasFolderScopes(): boolean {
    return this.folderScopes.size > 0;
  }

  /**
   * True if `normalizedFilePath` is within its owning repo's active folder scope
   * (or that repo has no scope). Files in repos with no scope always pass.
   */
  passesScope(normalizedFilePath: string, resolvedRepos: RepoInfo[]): boolean {
    if (this.folderScopes.size === 0) {
      return true;
    }
    // Find which repo this file belongs to, then check its scope.
    for (const { normalizedRepoPath } of resolvedRepos) {
      if (normalizedFilePath.startsWith(normalizedRepoPath + "/") || normalizedFilePath === normalizedRepoPath) {
        const scope = this.folderScopes.get(normalizedRepoPath);
        if (scope === undefined) {
          return true; // No scope for this repo
        }
        return normalizedFilePath.startsWith(scope + "/") || normalizedFilePath === scope;
      }
    }
    return true;
  }
}
