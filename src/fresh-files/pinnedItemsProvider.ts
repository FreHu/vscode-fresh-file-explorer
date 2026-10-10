import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { PinnedItemsManager } from "./pinnedItemsManager";
import {
  FreshFileItem,
  FreshFilesTreeItem,
  MarkdownHeadingItem,
  NoteTreeItem,
} from "./freshFileTreeItems";
import { MarkdownHeading, parseMarkdownHeadings } from "./markdownHeadings";
import { PinnedMarkdownSync } from "./pinnedMarkdownSync";
import { ConfigKeys } from "../config/configKeyConstants";
import { log } from "../extension/logger";
import { TreeItemContextValues, createPinnedFileId } from "./treeItemConstants";
import { asAbsolutePath } from "../pathTypes";
import { normalizePath } from "../utils";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";
import { formatFileTooltip } from "../utils/formatUtils";
import { ConfigService } from "../config/configService";
import type { FreshFileProvider } from "./freshFileProvider";

function isMarkdownPath(fsPath: string): boolean {
  return /\.(md|markdown)$/i.test(fsPath);
}

function isDirectory(fsPath: string): boolean {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * TreeDataProvider for the Pinned Items view.
 *
 * Pinned files and notes form a flat list (no folder wrapper — the view title
 * acts as the container label). A pinned markdown file is the exception: its
 * headings render as children, kept in sync with the file.
 */
export class PinnedItemsProvider implements vscode.TreeDataProvider<FreshFilesTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<FreshFilesTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  readonly pinnedItemsManager = new PinnedItemsManager();
  private readonly markdownSync = new PinnedMarkdownSync();
  /** The last-rendered row of each pinned markdown file, keyed by normalized path, for per-file refresh. */
  private markdownItems = new Map<string, FreshFileItem>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly freshFileProvider: FreshFileProvider) {
    this.subscriptions.push(
      this.markdownSync,
      // Refresh only the changed file's subtree; the rest of the view stays as is.
      this.markdownSync.onDidChange(key => this._onDidChangeTreeData.fire(this.markdownItems.get(key))),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration(ConfigKeys.PINNED_MARKDOWN_HEADING_DEPTH) ||
          e.affectsConfiguration(ConfigKeys.PINNED_MARKDOWN_EXPAND_DEPTH)
        ) {
          this._onDidChangeTreeData.fire();
        }
      }),
    );
  }

  /**
   * Wire the manager callback so any change fires a tree refresh.
   * Call this after WorkspaceStateManager.initialize().
   */
  initialize(): void {
    this.pinnedItemsManager.initialize(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    for (const s of this.subscriptions) { s.dispose(); }
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

  async getChildren(element?: FreshFilesTreeItem): Promise<FreshFilesTreeItem[]> {
    if (!element) {
      return this.buildPinnedItems();
    }
    // Only pinned markdown files and their headings have children.
    if (element instanceof MarkdownHeadingItem) {
      return this.headingItems(element.fileUri, element.heading.children, element.treeDepth + 1);
    }
    if (element instanceof FreshFileItem && isMarkdownPath(element.resourceUri.fsPath)) {
      const headings = await this.readHeadings(element.resourceUri);
      return this.headingItems(element.resourceUri, headings, 1);
    }
    return [];
  }

  private headingItems(fileUri: vscode.Uri, headings: MarkdownHeading[], treeDepth: number): MarkdownHeadingItem[] {
    const expandDepth = ConfigService.getPinnedMarkdownExpandDepth();
    return headings.map(h => new MarkdownHeadingItem(fileUri, h, treeDepth, expandDepth));
  }

  /** Headings of a pinned markdown file: the open editor's text (unsaved edits included), else the file on disk. */
  private async readHeadings(uri: vscode.Uri): Promise<MarkdownHeading[]> {
    const depth = ConfigService.getPinnedMarkdownHeadingDepth();
    if (depth <= 0) { return []; }
    const key = normalizePath(uri.fsPath);
    const open = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === key);
    try {
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      return parseMarkdownHeadings(text, depth);
    } catch (err) {
      log(`Pinned markdown: could not read ${uri.fsPath} — ${err instanceof Error ? err.message : String(err)}`, "warn");
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  private buildPinnedItems(): FreshFilesTreeItem[] {
    const items: FreshFilesTreeItem[] = [];
    const { freshFiles, openChangesMode, workspaceFolders } = this.freshFileProvider;
    const showHeadings = ConfigService.getPinnedMarkdownHeadingDepth() > 0;
    const markdownItems = new Map<string, FreshFileItem>();

    for (const pinnedItem of this.pinnedItemsManager.getItems()) {
      if (pinnedItem.type === "note") {
        items.push(new NoteTreeItem(pinnedItem.id, pinnedItem.data, pinnedItem.completed ?? false));
      } else {
        const filePath = asAbsolutePath(pinnedItem.id);
        const uri = vscode.Uri.file(filePath);
        const metadata = freshFiles.get(filePath);
        const listsHeadings = showHeadings && !pinnedItem.suggested && isMarkdownPath(filePath);

        const item = FreshFileItem.forFile(
          uri,
          openChangesMode,
          metadata?.isDeleted ?? false,
          metadata?.commitHash,
          metadata?.isPending ?? false,
          metadata?.status,
          metadata?.renameSource,
          !listsHeadings
            ? vscode.TreeItemCollapsibleState.None
            : ConfigService.getPinnedMarkdownExpandDepth() > 0
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed,
        );

        // Distinct contextValue so the context menu shows "Unpin" rather than "Pin"
        // (and suggestion-specific actions for machine-created entries).
        item.contextValue = pinnedItem.suggested
          ? TreeItemContextValues.SUGGESTED_FILE
          : TreeItemContextValues.PINNED_FILE;

        // Stable ID that differs from the regular view so VS Code can track both independently
        item.id = createPinnedFileId(uri.fsPath);

        item.checkboxState = pinnedItem.completed
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;

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

        if (pinnedItem.suggested) {
          // Suggestions carry their evidence instead of the directory — the
          // "why" is what makes a machine pin trustworthy.
          item.iconPath = new vscode.ThemeIcon("lightbulb");
          item.description = pinnedItem.data;
          item.tooltip = `Suggested: ${pinnedItem.data}\n${filePath}`;
          // Directory targets (e.g. a migrations folder) can't open in an
          // editor — reveal them in the Explorer instead.
          if (isDirectory(filePath)) {
            item.command = { command: "revealInExplorer", title: "Reveal in Explorer", arguments: [uri] };
          }
        }

        if (listsHeadings) { markdownItems.set(normalizePath(filePath), item); }
        items.push(item);
      }
    }

    this.markdownItems = markdownItems;
    this.markdownSync.setWatched([...markdownItems.keys()]);
    return items;
  }

}
