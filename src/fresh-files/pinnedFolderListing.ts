import { sortTreeEntries } from "../utils/treeEntrySort";

export interface FolderEntry {
  name: string;
  /** Absolute path, forward slashes. */
  path: string;
  isDirectory: boolean;
}

/**
 * The rows a pinned folder shows when expanded: its direct entries minus the
 * ones `isExcluded` hides, folders first, then by name like the Explorer.
 * `entries` is what `workspace.fs.readDirectory` returns, as name + is-folder.
 */
export function listPinnedFolder(
  dirPath: string,
  entries: ReadonlyArray<readonly [name: string, isDirectory: boolean]>,
  isExcluded: (absPath: string) => boolean,
): FolderEntry[] {
  const base = dirPath.endsWith("/") ? dirPath : dirPath + "/";
  const rows = entries
    .map(([name, isDirectory]) => ({ name, path: base + name, isDirectory }))
    .filter(row => !isExcluded(row.path));
  sortTreeEntries(rows, "name", {
    name: row => row.name,
    isDirectory: row => row.isDirectory,
    date: () => undefined,
    author: () => "",
  });
  return rows;
}
