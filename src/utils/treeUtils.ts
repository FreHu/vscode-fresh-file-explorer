import * as vscode from "vscode";
import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { log } from "../extension/logger";

/**
 * Helper function to expand tree items - collects all directories first, then expands in batch
 */
export async function expandItemRecursively(
  treeView: vscode.TreeView<FreshFilesTreeItem>,
  provider: vscode.TreeDataProvider<FreshFilesTreeItem>,
  item: FreshFileItem,
): Promise<void> {
  try {
    // Collect directories level-by-level (BFS), keeping each level as a separate array.
    // We must reveal level N before level N+1: if a parent and its child are revealed
    // concurrently, VS Code's internal _fetchChildrenNodes can be triggered twice for the
    // parent simultaneously, the fetch-token guard cancels one of them, and the child
    // can't be found in the cache → "Cannot resolve tree item" error.
    const levels: FreshFileItem[][] = [[item]];

    for (let li = 0; li < levels.length; li++) {
      const nextLevel: FreshFileItem[] = [];
      for (const current of levels[li]) {
        const children = await provider.getChildren(current);
        if (children) {
          for (const child of children) {
            if (child instanceof FreshFileItem && child.isDirectory) {
              nextLevel.push(child);
            }
          }
        }
      }
      if (nextLevel.length > 0) {
        levels.push(nextLevel);
      }
    }

    let failureCount = 0;
    const maxFailures = 10; // Stop if too many failures (tree is likely stale)

    // Reveal one level at a time. Within each level siblings are independent so
    // they can be revealed in parallel safely.
    for (const level of levels) {
      if (failureCount >= maxFailures) { break; }
      const results = await Promise.allSettled(level.map(dir => treeView.reveal(dir, { expand: true })));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          continue;
        } else {
          failureCount++;
        }
      }
    }

    if (failureCount >= maxFailures) {
      log("Expansion was stopped prematurely due to too many unknown failures.");
    }
  } catch (err) {
    log(`Expansion threw an exception: ${err}`);
  }
}
