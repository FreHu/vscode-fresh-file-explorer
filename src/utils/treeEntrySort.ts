import { SortOrder } from "../types";

export interface TreeEntryAccessors<T> {
  name(item: T): string;
  isDirectory(item: T): boolean;
  /** For a folder: its newest file's date. Undefined sorts last. */
  date(item: T): Date | undefined;
  /** Empty for folders. */
  author(item: T): string;
}

/**
 * Sorts a folder's children in place, the same way in Fresh Files and Branch
 * Compare. Name and Author put folders first; Date mixes folders and files,
 * newest first. Ties break by name.
 */
export function sortTreeEntries<T>(items: T[], sortOrder: SortOrder, get: TreeEntryAccessors<T>): void {
  const byName = (a: T, b: T) => get.name(a).localeCompare(get.name(b));
  items.sort((a, b) => {
    if (sortOrder !== "date" && get.isDirectory(a) !== get.isDirectory(b)) {
      return get.isDirectory(a) ? -1 : 1;
    }
    switch (sortOrder) {
      case "date": {
        const dateA = get.date(a);
        const dateB = get.date(b);
        if (!dateA && !dateB) { return byName(a, b); }
        if (!dateA) { return 1; }
        if (!dateB) { return -1; }
        return dateB.getTime() - dateA.getTime() || byName(a, b);
      }
      case "author":
        return get.author(a).localeCompare(get.author(b)) || byName(a, b);
      case "name":
        return byName(a, b);
    }
  });
}
