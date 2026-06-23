/**
 * Context values for tree items in the Fresh File Explorer.
 * These control which context menu items are visible for each item type.
 */
export const TreeItemContextValues = {
  FILE: "file",
  PENDING_FILE: "pendingFile",
  DELETED_FILE: "deletedFile",
  FOLDER: "folder",
  WORKSPACE_FOLDER: "workspaceFolder",
  REPO_FOLDER: "repoFolder",
  PINNED_FILE: "pinnedFile",
  PINNED_FOLDER: "pinnedFolder",
  PINNED_NOTE: "pinnedNote",
  AUTHOR_GROUP: "authorGroup",
  COMMIT_HASH_GROUP: "commitHashGroup",
  MOON_PHASE_GROUP: "moonPhaseGroup",
  RETROGRADE_GROUP: "retrogradeGroup",
  UNINITIALIZED_SUBMODULE_GROUP: "uninitializedSubmoduleGroup",
  UNINITIALIZED_SUBMODULE: "uninitializedSubmodule",
  MESSAGE: "message",
  SUBMODULE_ENTRY: "submoduleEntry",
} as const;

/**
 * Prefixes for generating unique item IDs.
 */
export const ItemIdPrefixes = {
  PINNED: "pinned:",
  NOTE: "note:",
} as const;

/**
 * Creates an item ID for a pinned file.
 */
export function createPinnedFileId(normalizedPath: string): string {
  return `${ItemIdPrefixes.PINNED}${normalizedPath}`;
}

/**
 * Creates an item ID for a note.
 */
export function createNoteId(noteId: string): string {
  return `${ItemIdPrefixes.NOTE}${noteId}`;
}

/**
 * Normalizes an ID for comparison, handling path separators.
 * @param id The ID to normalize (may have "pinned:" or "note:" prefix)
 * @param normalizePath Function to normalize the path part
 */
export function normalizeItemId(id: string, normalizePath: (path: string) => string): string {
  if (id.startsWith(ItemIdPrefixes.PINNED)) {
    return createPinnedFileId(normalizePath(id.substring(ItemIdPrefixes.PINNED.length)));
  }
  // Notes don't need path normalization
  return id;
}

/**
 * Gets the full item ID with prefix for a PinnedItem, with normalized path.
 */
export function getItemIdWithNormalizedPath(item: { type: "file" | "note"; id: string }, normalizePath: (path: string) => string): string {
  if (item.type === "note") {
    return createNoteId(item.id);
  }
  return createPinnedFileId(normalizePath(item.id));
}
