import * as path from "path";
import { FreshFileItem, SubmoduleEntryItem } from "./freshFileTreeItems";
import { SortOrder } from "../types";
import { sortTreeEntries } from "../utils/treeEntrySort";

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
    sortTreeEntries(items, sortOrder, {
      name: itemName,
      isDirectory: item => item.isDirectory,
      date: getDate,
      author: getAuthor,
    });
  }
}
