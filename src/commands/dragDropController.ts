import * as vscode from "vscode";
import { FreshFileItem, FreshFilesTreeItem, NoteTreeItem } from "../fresh-files/freshFileTreeItems";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log } from "../extension/logger";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";

// MIME types for drag & drop operations
export const MIME_TYPE_URI_LIST = "text/uri-list";
export const MIME_TYPE_TREE_INTERNAL = "application/vnd.code.tree.freshFileExplorer";

/**
 * Creates a drag & drop controller for the Fresh File Explorer tree view.
 * Supports:
 * - Dragging pinned items to reorder them
 * - Dragging files from elsewhere to pin them
 * - Dragging files from the regular view to pin them
 */
export function createDragAndDropController(freshFileProvider: FreshFileProvider): vscode.TreeDragAndDropController<FreshFilesTreeItem> {
  return {
    dragMimeTypes: [MIME_TYPE_URI_LIST, MIME_TYPE_TREE_INTERNAL],
    dropMimeTypes: [MIME_TYPE_URI_LIST, MIME_TYPE_TREE_INTERNAL],
    handleDrag: createHandleDrag(),
    handleDrop: createHandleDrop(freshFileProvider),
  };
}

/**
 * Creates the drag handler for tree items.
 * Sets up data transfer for both pinned items (for reordering) and regular files (for external drag).
 */
function createHandleDrag() {
  return (items: readonly FreshFilesTreeItem[], dataTransfer: vscode.DataTransfer) => {
    // Handle dragging pinned items for reordering
    const pinnedItems = items.filter((item): item is FreshFileItem | NoteTreeItem =>
      (item instanceof FreshFileItem && item.contextValue === TreeItemContextValues.PINNED_FILE) ||
      (item instanceof NoteTreeItem)
    );
    
    if (pinnedItems.length > 0) {
      // Store item IDs for reordering
      const itemIds = pinnedItems.map(item => item.id!);
      log(`Drag: Setting internal data with IDs: ${JSON.stringify(itemIds)}`);
      dataTransfer.set(
        MIME_TYPE_TREE_INTERNAL,
        new vscode.DataTransferItem(JSON.stringify(itemIds))
      );
    }
    
    // Also handle regular file URIs for non-deleted, non-directory items
    const uris = items
      .filter((item): item is FreshFileItem => item instanceof FreshFileItem && !item.isDirectory && !item.isDeleted)
      .map(item => item.resourceUri);
    if (uris.length > 0) {
      dataTransfer.set(MIME_TYPE_URI_LIST, new vscode.DataTransferItem(uris.map(uri => uri.toString()).join("\r\n")));
    }
  };
}

/**
 * Creates the drop handler for tree items.
 * Handles both reordering of pinned items and pinning new files at specific positions.
 */
function createHandleDrop(freshFileProvider: FreshFileProvider) {
  return async (target: FreshFilesTreeItem | undefined, dataTransfer: vscode.DataTransfer) => {
    log(`Drop: Target type: ${target?.constructor.name}, contextValue: ${target instanceof FreshFileItem ? target.contextValue : 'N/A'}`);
    
    // Check for internal reordering first (our custom MIME type with array of IDs)
    const internalData = await dataTransfer.get(MIME_TYPE_TREE_INTERNAL)?.asString();
    log(`Drop: Internal data: ${internalData || 'none'}`);
    
    if (internalData && target) {
      const sourceIds = parseInternalDragData(internalData);
      
      if (sourceIds) {
        if (handleInternalReorder(sourceIds, target, freshFileProvider)) {
          return;
        }
      }
      
      log(`Drop: Not our custom format, treating as external drop`);
    }

    // Handle external file drops (pinning new files)
    await handleExternalFileDrop(target, dataTransfer, freshFileProvider);
  };
}

/**
 * Parses internal drag data to extract source item IDs.
 * Returns undefined if the data is not in our custom format (JSON array of strings).
 */
function parseInternalDragData(data: string): string[] | undefined {
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Not our format
  }
  return undefined;
}

/**
 * Handles reordering of pinned items within the pinned folder.
 * Returns true if the operation was handled.
 */
function handleInternalReorder(
  sourceIds: string[],
  target: FreshFilesTreeItem,
  freshFileProvider: FreshFileProvider
): boolean {
  // Reordering within pinned items
  if ((target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FILE) ||
      (target instanceof NoteTreeItem)) {
    log(`Drop: Reordering sourceIds=${JSON.stringify(sourceIds)}, targetId=${target.id}`);
    if (sourceIds.length === 1 && target.id) {
      freshFileProvider.reorderPinnedItems(sourceIds[0], target.id, false);
    }
    return true;
  }
  
  // Dropping onto pinnedFolder itself - move to first position
  if (target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FOLDER) {
    log(`Drop: Moving to first position, sourceIds=${JSON.stringify(sourceIds)}`);
    if (sourceIds.length === 1) {
      freshFileProvider.movePinnedItemToFirst(sourceIds[0]);
    }
    return true;
  }
  
  return false;
}

/**
 * Handles dropping external files to pin them at specific positions.
 */
async function handleExternalFileDrop(
  target: FreshFilesTreeItem | undefined,
  dataTransfer: vscode.DataTransfer,
  freshFileProvider: FreshFileProvider
): Promise<void> {
  const uriListData = await dataTransfer.get(MIME_TYPE_URI_LIST)?.asString();
  if (!uriListData) {
    return;
  }

  // Determine target position
  const dropTarget = determineDropTarget(target);
  if (!dropTarget) {
    return;
  }

  // Parse and filter URIs
  const filePaths = await parseAndFilterUris(uriListData);
  if (filePaths.length === 0) {
    return;
  }

  // Pin files at the appropriate position
  if (dropTarget.insertAtFirst) {
    freshFileProvider.pinFilesAtPosition(filePaths, 0);
  } else if (dropTarget.afterItemId) {
    freshFileProvider.pinFilesAfterItem(filePaths, dropTarget.afterItemId);
  }
}

/**
 * Determines where to insert dropped files based on the drop target.
 */
function determineDropTarget(target: FreshFilesTreeItem | undefined): { insertAtFirst: boolean; afterItemId?: string } | undefined {
  if (target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FOLDER) {
    return { insertAtFirst: true };
  } else if (target instanceof FreshFileItem && target.contextValue === TreeItemContextValues.PINNED_FILE) {
    return { insertAtFirst: false, afterItemId: target.id };
  } else if (target instanceof NoteTreeItem) {
    return { insertAtFirst: false, afterItemId: target.id };
  }
  // Not a valid drop target for external files
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
        // If stat fails, skip this URI
      }
    }
  }
  return filePaths;
}
