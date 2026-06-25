import { compileFilesExclude, ExcludePredicate } from "./filesExcludeMatcher";

/** Minimal shape of a workspace folder this filter needs. */
export interface FolderPath {
  path: string;
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve which workspace folder owns an absolute path, by longest matching
 * prefix. In overlapping-root workspaces (a folder added alongside one of its
 * own subfolders) the most specific folder wins.
 */
export function findOwningFolder<T extends FolderPath>(
  normalizedAbsPath: string,
  folders: readonly T[],
): T | undefined {
  let owner: T | undefined;
  for (const folder of folders) {
    const fp = toForwardSlash(folder.path);
    if (normalizedAbsPath === fp || normalizedAbsPath.startsWith(fp + "/")) {
      if (!owner || folder.path.length > owner.path.length) {
        owner = folder;
      }
    }
  }
  return owner;
}

/**
 * Applies workspace folders' `files.exclude` settings, mirroring the VS Code
 * Explorer (which the extension can't observe directly because it builds its
 * tree from git, not the filesystem).
 *
 * `files.exclude` is evaluated PER NODE, not globally: the same file can be
 * hidden under one workspace-folder node and visible under another. In the
 * canonical case — a repo root added alongside its own `backend/` subfolder, the
 * root excluding `backend` — `backend/app.js` is hidden under the root node
 * (matches the root's `backend` glob, path-relative to the root) yet shown under
 * the backend node (path-relative to backend, which excludes nothing). So
 * callers pass the folder of the node being rendered, not the file's owner.
 *
 * Stateful only for the compiled-glob cache; matching is delegated to the pure
 * `filesExcludeMatcher`. The provider owns one instance and calls `invalidate()`
 * when `files.exclude` or the respect toggle changes.
 */
export class FilesExcludeFilter {
  /** glob predicate per workspace-folder path. */
  private matchers = new Map<string, ExcludePredicate>();

  constructor(
    /** Whether the feature is enabled (reads the respect-files-exclude setting). */
    private readonly isEnabled: () => boolean,
    /** The raw `files.exclude` expression resolved at a folder's scope. */
    private readonly expressionFor: (folderPath: string) => Record<string, unknown>,
  ) {}

  get enabled(): boolean {
    return this.isEnabled();
  }

  /** Drop compiled matchers so the next pass re-reads config. */
  invalidate(): void {
    this.matchers.clear();
  }

  /**
   * True if `absPath` is hidden under `folder`'s node — i.e. `folder`'s
   * `files.exclude` matches the path taken relative to `folder`. Returns false
   * (and never errors) when the feature is off or the path isn't under `folder`.
   */
  isExcludedUnder(absPath: string, folder: FolderPath): boolean {
    if (!this.isEnabled()) {
      return false;
    }
    const folderPath = toForwardSlash(folder.path);
    const normalized = toForwardSlash(absPath);
    if (normalized !== folderPath && !normalized.startsWith(folderPath + "/")) {
      return false;
    }
    const relativePath = normalized === folderPath ? "" : normalized.slice(folderPath.length + 1);
    return this.matcherFor(folder.path)(relativePath);
  }

  /**
   * True if `absPath` is hidden under its most-specific owning folder. Used for
   * the flat lenses (group-by-author/commit, search) that have no node context.
   */
  isExcludedByOwner(absPath: string, folders: readonly FolderPath[]): boolean {
    if (!this.isEnabled()) {
      return false;
    }
    const owner = findOwningFolder(toForwardSlash(absPath), folders);
    return owner ? this.isExcludedUnder(absPath, owner) : false;
  }

  /**
   * Owner-filtered copy of `map` for the flat lenses. Returns the SAME reference
   * when the feature is off or nothing is excluded (the common case is free).
   */
  filterByOwner<K extends string, V>(map: Map<K, V>, folders: readonly FolderPath[]): Map<K, V> {
    if (!this.isEnabled()) {
      return map;
    }
    let filtered: Map<K, V> | undefined;
    for (const [absPath, value] of map) {
      if (this.isExcludedByOwner(absPath, folders)) {
        if (!filtered) {
          filtered = new Map();
          for (const [p, v] of map) {
            if (p === absPath) { break; }
            filtered.set(p, v);
          }
        }
        continue;
      }
      filtered?.set(absPath, value);
    }
    return filtered ?? map;
  }

  private matcherFor(folderPath: string): ExcludePredicate {
    const cached = this.matchers.get(folderPath);
    if (cached) {
      return cached;
    }
    const matcher = compileFilesExclude(this.expressionFor(folderPath));
    this.matchers.set(folderPath, matcher);
    return matcher;
  }
}
