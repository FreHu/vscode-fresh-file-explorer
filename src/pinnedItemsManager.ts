import { AbsolutePath } from "./pathTypes";
import { WorkspaceStateManager } from "./extension/workspaceStateManager";
import { PinnedItem } from "./types";
import { log } from "./extension/logger";
import { normalizePath } from "./utils";
import { normalizeItemId, getItemIdWithNormalizedPath } from "./treeItemConstants";

/**
 * Manages pinned items (files and notes) for the Fresh File Explorer.
 * Handles persistence, ordering, and operations on pinned items.
 */
export class PinnedItemsManager {
  private pinnedItems: PinnedItem[] = [];
  private onChangeCallback?: () => void;

  /**
   * Initialize with a callback invoked whenever pinned items change.
   */
  initialize(onChangeCallback?: () => void): void {
    this.onChangeCallback = onChangeCallback;
    this.pinnedItems = WorkspaceStateManager.getPinnedItems();
  }

  /**
   * Get all pinned items in order
   */
  getItems(): PinnedItem[] {
    return this.pinnedItems;
  }

  /**
   * Get the count of pinned items
   */
  getCount(): number {
    return this.pinnedItems.length;
  }

  // ============================================================
  // File Operations
  // ============================================================

  /**
   * Add file(s) to pinned items
   */
  pinFiles(filePaths: AbsolutePath[]): void {
    for (const filePath of filePaths) {
      if (!this.pinnedItems.some(item => item.type === "file" && item.id === filePath)) {
        this.pinnedItems.push({ type: "file", id: filePath, data: "" });
      }
    }
    this.persistAndNotify();
    log(`Pinned ${filePaths.length} file(s)`);
  }

  /**
   * Remove file(s) from pinned items
   */
  unpinFiles(filePaths: AbsolutePath[]): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => !(item.type === "file" && filePaths.includes(item.id as AbsolutePath))
    );
    this.persistAndNotify();
    log(`Unpinned ${filePaths.length} file(s)`);
  }

  /**
   * Check if a file is pinned
   */
  isPinned(filePath: AbsolutePath): boolean {
    return this.pinnedItems.some(item => item.type === "file" && item.id === filePath);
  }

  /**
   * Get all pinned files
   */
  getPinnedFiles(): AbsolutePath[] {
    return this.pinnedItems
      .filter(item => item.type === "file")
      .map(item => item.id as AbsolutePath);
  }

  /**
   * Pin files at a specific position (0 = first)
   */
  pinFilesAtPosition(filePaths: AbsolutePath[], position: number): void {
    log(`pinFilesAtPosition: Adding ${filePaths.length} file(s) at position ${position}`);
    
    const alreadyPinned: AbsolutePath[] = [];
    const newFiles: AbsolutePath[] = [];
    
    for (const path of filePaths) {
      if (this.pinnedItems.some(item => item.type === "file" && normalizePath(item.id) === normalizePath(path))) {
        alreadyPinned.push(path);
      } else {
        newFiles.push(path);
      }
    }
    
    if (newFiles.length > 0) {
      const newItems: PinnedItem[] = newFiles.map(path => ({ type: "file" as const, id: path, data: "" }));
      this.pinnedItems.splice(position, 0, ...newItems);
      log(`pinFilesAtPosition: Added ${newItems.length} new file(s)`);
    }
    
    if (alreadyPinned.length > 0) {
      let targetIndex = position + newFiles.length;
      for (const path of alreadyPinned) {
        const pinnedId = `pinned:${normalizePath(path)}`;
        const currentIndex = this.pinnedItems.findIndex(item => 
          item.type === "file" && `pinned:${normalizePath(item.id)}` === pinnedId
        );
        if (currentIndex !== -1 && currentIndex !== targetIndex) {
          const [item] = this.pinnedItems.splice(currentIndex, 1);
          if (currentIndex < targetIndex) {
            targetIndex--;
          }
          this.pinnedItems.splice(targetIndex, 0, item);
          targetIndex++;
        }
      }
      log(`pinFilesAtPosition: Reordered ${alreadyPinned.length} already-pinned file(s)`);
    }
    
    log(`pinFilesAtPosition: Total pinnedItems=${this.pinnedItems.length}`);
    
    this.persistAndNotify();
  }

  /**
   * Pin files after a specific item
   */
  pinFilesAfterItem(filePaths: AbsolutePath[], afterItemId: string): void {
    const normalizedAfterId = normalizeItemId(afterItemId, normalizePath);
    
    log(`pinFilesAfterItem: Adding ${filePaths.length} file(s) after item ${normalizedAfterId}`);
    
    const afterIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedAfterId;
    });
    
    if (afterIndex === -1) {
      log(`pinFilesAfterItem: Target item not found, falling back to append`);
      this.pinFiles(filePaths);
      return;
    }
    
    const alreadyPinned: AbsolutePath[] = [];
    const newFiles: AbsolutePath[] = [];
    
    for (const path of filePaths) {
      if (this.pinnedItems.some(item => item.type === "file" && normalizePath(item.id) === normalizePath(path))) {
        alreadyPinned.push(path);
      } else {
        newFiles.push(path);
      }
    }
    
    let insertPosition = afterIndex + 1;
    if (newFiles.length > 0) {
      const newItems: PinnedItem[] = newFiles.map(path => ({ type: "file" as const, id: path, data: "" }));
      this.pinnedItems.splice(insertPosition, 0, ...newItems);
      log(`pinFilesAfterItem: Added ${newItems.length} new file(s) after index ${afterIndex}`);
      insertPosition += newItems.length;
    }
    
    if (alreadyPinned.length > 0) {
      for (const path of alreadyPinned) {
        const pinnedId = `pinned:${normalizePath(path)}`;
        const currentIndex = this.pinnedItems.findIndex(item => 
          item.type === "file" && `pinned:${normalizePath(item.id)}` === pinnedId
        );
        if (currentIndex !== -1 && currentIndex !== insertPosition) {
          const [item] = this.pinnedItems.splice(currentIndex, 1);
          if (currentIndex < insertPosition) {
            insertPosition--;
          }
          this.pinnedItems.splice(insertPosition, 0, item);
          insertPosition++;
        }
      }
      log(`pinFilesAfterItem: Reordered ${alreadyPinned.length} already-pinned file(s)`);
    }
    
    log(`pinFilesAfterItem: Total pinnedItems=${this.pinnedItems.length}`);
    
    this.persistAndNotify();
  }

  // ============================================================
  // Note Operations
  // ============================================================

  /**
   * Add a note to pinned items
   */
  addNote(noteText: string): void {
    const noteId = Date.now().toString();
    this.pinnedItems.push({ type: "note", id: noteId, data: noteText });
    this.persistAndNotify();
    log(`Added note: ${noteText}`);
  }

  /**
   * Remove a note from pinned items
   */
  removeNote(noteId: string): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => !(item.type === "note" && item.id === noteId)
    );
    this.persistAndNotify();
    log(`Removed note: ${noteId}`);
  }

  /**
   * Update a note's text
   */
  updateNote(noteId: string, noteText: string): void {
    const item = this.pinnedItems.find(item => item.type === "note" && item.id === noteId);
    if (item) {
      item.data = noteText;
      this.persistAndNotify();
      log(`Updated note: ${noteId}`);
    }
  }

  /**
   * Toggle a note's completed state (for todo-style notes)
   */
  toggleNoteCompleted(noteId: string): void {
    const item = this.pinnedItems.find(item => item.type === "note" && item.id === noteId);
    if (item) {
      item.completed = !(item.completed ?? false);
      this.persistAndNotify();
      log(`Note ${noteId} completed: ${item.completed}`);
    }
  }

  // ============================================================
  // Reordering Operations
  // ============================================================

  /**
   * Reorder pinned items
   */
  reorderPinnedItems(sourceId: string, targetId: string, dropBefore: boolean): void {
    log(`reorderPinnedItems called: sourceId=${sourceId}, targetId=${targetId}, dropBefore=${dropBefore}`);
    
    const normalizedSourceId = normalizeItemId(sourceId, normalizePath);
    const normalizedTargetId = normalizeItemId(targetId, normalizePath);
    
    const sourceIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedSourceId;
    });
    const targetIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedTargetId;
    });

    log(`reorderPinnedItems: sourceIndex=${sourceIndex}, targetIndex=${targetIndex}`);
    log(`reorderPinnedItems: pinnedItems count=${this.pinnedItems.length}`);
    log(`reorderPinnedItems: pinnedItems IDs=${this.pinnedItems.map(item => 
      item.type === "note" ? `note:${item.id}` : `pinned:${item.id}`
    ).join(", ")}`);

    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      log(`reorderPinnedItems: Aborting - invalid indices or same position`);
      return;
    }

    const [movedItem] = this.pinnedItems.splice(sourceIndex, 1);
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex : targetIndex;
    const insertIndex = dropBefore ? newTargetIndex : newTargetIndex + 1;
    this.pinnedItems.splice(insertIndex, 0, movedItem);

    this.persistAndNotify();
    log(`Reordered pinned item from index ${sourceIndex} to ${insertIndex}`);
  }

  /**
   * Move a pinned item to the first position
   */
  movePinnedItemToFirst(sourceId: string): void {
    log(`movePinnedItemToFirst called: sourceId=${sourceId}`);
    
    const normalizedSourceId = normalizeItemId(sourceId, normalizePath);
    
    const sourceIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedSourceId;
    });

    log(`movePinnedItemToFirst: sourceIndex=${sourceIndex}`);

    if (sourceIndex === -1 || sourceIndex === 0) {
      log(`movePinnedItemToFirst: Aborting - item not found or already at first position`);
      return;
    }

    const [movedItem] = this.pinnedItems.splice(sourceIndex, 1);
    this.pinnedItems.unshift(movedItem);

    this.persistAndNotify();
    log(`Moved pinned item from index ${sourceIndex} to first position`);
  }

  // ============================================================
  // Bulk Operations
  // ============================================================

  /**
   * Clear all pinned items (files and notes)
   */
  clearAllPinned(): void {
    this.pinnedItems = [];
    this.persistAndNotify();
    log("Cleared all pinned items");
  }

  /**
   * Clear only completed notes
   */
  clearCompleted(): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => item.type !== "note" || !item.completed
    );
    this.persistAndNotify();
    log("Cleared completed notes");
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  /**
   * Persist pinned items and notify listeners
   */
  private persistAndNotify(): void {
    this.persist();
    this.onChangeCallback?.();
  }

  /**
   * Persist pinned items to workspace state
   */
  private persist(): void {
    WorkspaceStateManager.setPinnedItems(this.pinnedItems);
  }
}
