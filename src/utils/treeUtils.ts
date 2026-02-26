import * as vscode from "vscode";
import { FreshFileItem, FreshFilesTreeItem } from "../treeItems";
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
    // Collect all directory items first (breadth-first)
    const allDirectories: FreshFileItem[] = [item];
    let index = 0;

    while (index < allDirectories.length) {
      const current = allDirectories[index];
      const children = await provider.getChildren(current);

      if (children) {
        for (const child of children) {
          if (child instanceof FreshFileItem && child.isDirectory) {
            allDirectories.push(child);
          }
        }
      }
      index++;
    }

    // Now expand all directories in parallel batches
    // Reveal in batches to avoid overwhelming the UI
    // Use smaller batches and add error handling for large trees
    // it looks a bit janky with a big enough subtree but is reasonably fast
    const batchSize = 20;
    let failureCount = 0;
    const maxFailures = 10; // Stop if too many failures (tree is likely stale)

    for (let i = 0; i < allDirectories.length && failureCount < maxFailures; i += batchSize) {
      const batch = allDirectories.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(dir => treeView.reveal(dir, { expand: true })));

      // Log failures but continue - partial expansion is fine
      for (const result of results) {
        if (result.status === "rejected") {
          failureCount++;
          log(`Failed expansion: ${result.status} - ${result.reason}`);
        }
      }
    }

    if (failureCount === maxFailures) {
      log("Expansion was stopped prematurely due to too many unknown failures.");
    }
  } catch (err) {
    log(`Expansion threw an exception: ${err}`);
  }
}
