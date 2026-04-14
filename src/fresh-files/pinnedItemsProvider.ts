import * as vscode from "vscode";
import * as path from "path";

import { PinnedItemsManager } from "./pinnedItemsManager";
import {
  FreshFileItem,
  FreshFilesTreeItem,
  NoteTreeItem,
} from "./freshFileTreeItems";
import { TreeItemContextValues, createPinnedFileId } from "./treeItemConstants";
import { asAbsolutePath } from "../pathTypes";
import { normalizePath } from "../utils";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";
import { formatFileTooltip } from "../utils/formatUtils";
import { ConfigService } from "../config/configService";
import type { FreshFileProvider } from "./freshFileProvider";

/**
 * TreeDataProvider for the Pinned Items view.
 *
 * Renders pinned files and notes as a flat list (no folder wrapper — the
 * view title acts as the container label).  All management operations
 * (pin, unpin, notes, reorder, …) are exposed here so commands can target
 * this provider directly.
 */
export class PinnedItemsProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<FreshFilesTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  readonly pinnedItemsManager = new PinnedItemsManager();

  constructor(private readonly freshFileProvider: FreshFileProvider) {}

  /**
   * Wire the manager callback so any change fires a tree refresh.
   * Call this after WorkspaceStateManager.initialize().
   */
  initialize(): void {
    this.pinnedItemsManager.initialize(() => this._onDidChangeTreeData.fire());
  }

  /** Force a tree refresh without reloading data (e.g. after openChangesMode toggle). */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ---------------------------------------------------------------------------
  // TreeDataProvider
  // ---------------------------------------------------------------------------

  getTreeItem(element: FreshFilesTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FreshFilesTreeItem): FreshFilesTreeItem[] {
    if (element) {
      // Pinned items are a flat list — no children
      return [];
    }
    return this.buildPinnedItems();
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  private buildPinnedItems(): FreshFilesTreeItem[] {
    const items: FreshFilesTreeItem[] = [];
    const { freshFiles, openChangesMode, workspaceFolders } = this.freshFileProvider;

    for (const pinnedItem of this.pinnedItemsManager.getItems()) {
      if (pinnedItem.type === "note") {
        items.push(new NoteTreeItem(pinnedItem.id, pinnedItem.data, pinnedItem.completed ?? false));
      } else {
        const filePath = asAbsolutePath(pinnedItem.id);
        const uri = vscode.Uri.file(filePath);
        const metadata = freshFiles.get(filePath);

        const item = FreshFileItem.forFile(
          uri,
          openChangesMode,
          metadata?.isDeleted ?? false,
          metadata?.commitHash,
          metadata?.isPending ?? false,
          metadata?.status,
          metadata?.renameSource,
        );

        // Distinct contextValue so the context menu shows "Unpin" rather than "Pin"
        item.contextValue = TreeItemContextValues.PINNED_FILE;

        // Stable ID that differs from the regular view so VS Code can track both independently
        item.id = createPinnedFileId(uri.fsPath);

        // Always show the directory in description (the filename is already the label)
        const folder = findWorkspaceFolderForPath(filePath, workspaceFolders);
        if (folder) {
          const relativePath = path.relative(folder.path, filePath);
          const dirPath = path.dirname(relativePath);
          item.description = dirPath === "." ? "" : normalizePath(dirPath);
        } else {
          item.description = normalizePath(path.dirname(filePath));
        }

        item.tooltip = metadata ? formatFileTooltip(metadata, ConfigService.getDescriptionFormat()) : filePath;

        items.push(item);
      }
    }

    return items;
  }

}
