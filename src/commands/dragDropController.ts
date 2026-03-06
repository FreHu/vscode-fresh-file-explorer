import * as vscode from "vscode";
import { FreshFileItem, FreshFilesTreeItem, NoteTreeItem } from "../fresh-files/freshFileTreeItems";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { PinnedItemsProvider } from "../fresh-files/pinnedItemsProvider";
import { log } from "../extension/logger";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";

// MIME types for drag & drop operations
export const MIME_TYPE_URI_LIST = "text/uri-list";
/** Internal MIME for items dragged within / from the Fresh File Explorer view. */
export const MIME_TYPE_TREE_FRESH_FILES = "application/vnd.code.tree.freshFileExplorer";
/** Internal MIME for items dragged within the Pinned Items view (reordering). */
export const MIME_TYPE_TREE_PINNED = "application/vnd.code.tree.pinnedItems";

/**
 * Drag & drop controller for the Fresh File Explorer tree view.
 * Only handles dragging files OUT (so they can be dropped onto the Pinned Items view).
 * Drop is not supported here — files must be dropped onto the Pinned Items view.
 */
export function createFreshFilesDragAndDropController(_freshFileProvider: FreshFileProvider): vscode.TreeDragAndDropController<FreshFilesTreeItem> {
  return {
    dragMimeTypes: [MIME_TYPE_URI_LIST, MIME_TYPE_TREE_FRESH_FILES],
    dropMimeTypes: [],   // Fresh Files view does not accept drops
    handleDrag: createHandleDrag(),
  };
}

/**
 * Drag & drop controller for the Pinned Items tree view.
 * Supports:
 * - Reordering pinned items within the view (internal MIME)
 * - Dropping files from the Fresh Files view or Explorer to pin them (uri-list)
 */
export function createPinnedDragAndDropController(pinnedItemsProvider: PinnedItemsProvider): vscode.TreeDragAndDropController<FreshFilesTreeItem> {
  return {
    dragMimeTypes: [MIME_TYPE_URI_LIST, MIME_TYPE_TREE_PINNED],
    dropMimeTypes: [MIME_TYPE_URI_LIST, MIME_TYPE_TREE_PINNED, MIME_TYPE_TREE_FRESH_FILES],
    handleDrag: createHandlePinnedDrag(),
    handleDrop: createHandlePinnedDrop(pinnedItemsProvider),
  };
}

// ---------------------------------------------------------------------------
// Fresh Files view — drag handler (files dragged OUT to be pinned elsewhere)
// ---------------------------------------------------------------------------

/**
 * Drag handler for the Fresh File Explorer.
 * Exposes file URIs so they can be dropped onto the Pinned Items view.
 */
function createHandleDrag() {
  return (items: readonly FreshFilesTreeItem[], dataTransfer: vscode.DataTransfer) => {
    // Expose file URIs for cross-view drops (e.g. pinning via drag to Pinned Items)
    const uris = items
      .filter((item): item is FreshFileItem =>
        item instanceof FreshFileItem && !item.isDirectory && !item.isDeleted
      )
      .map(item => item.resourceUri);

    if (uris.length > 0) {
      dataTransfer.set(
        MIME_TYPE_URI_LIST,
        new vscode.DataTransferItem(uris.map(uri => uri.toString()).join("\r\n")),
      );
      dataTransfer.set(
        MIME_TYPE_TREE_FRESH_FILES,
        new vscode.DataTransferItem(JSON.stringify(uris.map(u => u.toString()))),
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Pinned Items view — drag & drop handlers
// ---------------------------------------------------------------------------

/**
 * Drag handler for the Pinned Items view.
 * Exposes pinned item IDs (for reordering) and file URIs (for external drops).
 */
function createHandlePinnedDrag() {
  return (items: readonly FreshFilesTreeItem[], dataTransfer: vscode.DataTransfer) => {
    const ids = items
      .filter(
        (item): item is FreshFileItem | NoteTreeItem =>
          (item instanceof FreshFileItem && item.contextValue === TreeItemContextValues.PINNED_FILE) ||
          item instanceof NoteTreeItem,
      )
      .map(item => item.id!);

    if (ids.length > 0) {
      log(`PinnedDrag: Setting reorder data with IDs: ${JSON.stringify(ids)}`);
      dataTransfer.set(MIME_TYPE_TREE_PINNED, new vscode.DataTransferItem(JSON.stringify(ids)));
    }

    // Also expose URIs so pinned files can be dragged to other views
    const uris = items
      .filter(
        (item): item is FreshFileItem =>
          item instanceof FreshFileItem &&
          item.contextValue === TreeItemContextValues.PINNED_FILE &&
          !item.isDeleted,
      )
      .map(item => item.resourceUri);

    if (uris.length > 0) {
      dataTransfer.set(
        MIME_TYPE_URI_LIST,
        new vscode.DataTransferItem(uris.map(u => u.toString()).join("\r\n")),
      );
    }
  };
}

/**
 * Drop handler for the Pinned Items view.
 * Handles:
 * - Reordering pinned items within the view (MIME_TYPE_TREE_PINNED)
 * - Pinning files dropped from the Fresh Files view or Explorer (uri-list)
 */
function createHandlePinnedDrop(pinnedItemsProvider: PinnedItemsProvider) {
  return async (target: FreshFilesTreeItem | undefined, dataTransfer: vscode.DataTransfer) => {
    log(`PinnedDrop: target=${target instanceof FreshFileItem ? target.contextValue : target?.constructor.name ?? "root"}`);

    // 1. Internal reorder (dragging within the Pinned Items view)
    const internalData = await dataTransfer.get(MIME_TYPE_TREE_PINNED)?.asString();
    if (internalData) {
      const sourceIds = parseJsonStringArray(internalData);
      if (sourceIds && sourceIds.length === 1) {
        if (target && ((target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FILE) ||
                       target instanceof NoteTreeItem)) {
          log(`PinnedDrop: Reordering ${sourceIds[0]} → before ${target.id}`);
          pinnedItemsProvider.pinnedItemsManager.reorderPinnedItems(sourceIds[0], target.id!, false);
        } else {
          // Drop on empty space (root) → move to first
          log(`PinnedDrop: Moving ${sourceIds[0]} to first`);
          pinnedItemsProvider.pinnedItemsManager.movePinnedItemToFirst(sourceIds[0]);
        }
        return;
      }
    }

    // 2. Pin files from uri-list (drop from Fresh Files view, Explorer, or external)
    const uriListData = await dataTransfer.get(MIME_TYPE_URI_LIST)?.asString();
    if (!uriListData) { return; }

    const filePaths = await parseAndFilterUris(uriListData);
    if (filePaths.length === 0) { return; }

    if (target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FILE && target.id) {
      pinnedItemsProvider.pinnedItemsManager.pinFilesAfterItem(filePaths, target.id);
    } else if (target instanceof NoteTreeItem && target.id) {
      pinnedItemsProvider.pinnedItemsManager.pinFilesAfterItem(filePaths, target.id);
    } else {
      // Drop on root or unknown target → insert at the top
      pinnedItemsProvider.pinnedItemsManager.pinFilesAtPosition(filePaths, 0);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Parses a JSON string that should be a string[]. Returns undefined if invalid.
 */
function parseJsonStringArray(data: string): string[] | undefined {
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Not our format
  }
  return undefined;
}

/**
 * Parses URI list data and filters to only valid file URIs.
 */
async function parseAndFilterUris(uriListData: string): Promise<AbsolutePath[]> {
  const uris = uriListData
    .split(/\r\n|\n/)
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => vscode.Uri.parse(line));

  const filePaths: AbsolutePath[] = [];
  for (const uri of uris) {
    if (uri.scheme === "file") {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.File) {
          filePaths.push(asAbsolutePath(uri.fsPath));
        }
      } catch {
        // Skip if stat fails
      }
    }
  }
  return filePaths;
}
