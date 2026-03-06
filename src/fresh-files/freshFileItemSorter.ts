import * as path from "path";
import { FreshFileItem, SubmoduleEntryItem } from "./freshFileTreeItems";
import { SortOrder } from "../types";

type SortableItem = FreshFileItem | SubmoduleEntryItem;

function itemName(item: SortableItem): string {
  return item instanceof SubmoduleEntryItem
    ? path.basename(item.submoduleFsPath)
    : path.basename(item.resourceUri.fsPath);
}

export class FreshFileItemSorter {
  /**
   * Sorts `items` in-place according to `sortOrder`.
   * @param getDate  Returns the relevant date for an item (directory or file).
   * @param getAuthor Returns the author string for an item (empty string for directories).
   */
  static sort(
    items: SortableItem[],
    sortOrder: SortOrder,
    getDate: (item: SortableItem) => Date | undefined,
    getAuthor: (item: SortableItem) => string,
  ): void {
    items.sort((a, b) => {
      // For date sorting, don't separate directories and files.
      // For other sorts, directories come first.
      if (sortOrder !== "date" && a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }

      switch (sortOrder) {
        case "date": {
          const dateA = getDate(a);
          const dateB = getDate(b);

          if (!dateA && !dateB) { return 0; }
          if (!dateA) { return 1; }  // items without dates go to the end
          if (!dateB) { return -1; }

          // Sort by date descending (newest first)
          const dateDiff = dateB.getTime() - dateA.getTime();
          if (dateDiff !== 0) { return dateDiff; }

          // Tiebreaker: alphabetical by filename
          return itemName(a).localeCompare(itemName(b));
        }

        case "author": {
          const authorCompare = getAuthor(a).localeCompare(getAuthor(b));
          if (authorCompare !== 0) { return authorCompare; }

          // Tiebreaker: alphabetical by filename
          return itemName(a).localeCompare(itemName(b));
        }

        case "name":
        default:
          // Alphabetical by filename (directories already sorted first above)
          return itemName(a).localeCompare(itemName(b));
      }
    });
  }
}
