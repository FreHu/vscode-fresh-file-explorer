import * as vscode from "vscode";

import { FreshFileItem, FreshFilesTreeItem, MessageTreeItem } from "./freshFileTreeItems";
import { FilesExcludeFilter } from "./filesExcludeFilter";
import { listPinnedFolder } from "./pinnedFolderListing";
import { TreeItemContextValues, createPinnedFileId } from "./treeItemConstants";
import { ConfigKeys } from "../config/configKeyConstants";
import { ConfigService } from "../config/configService";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { normalizePath } from "../utils";
import { FileMetadata, WorkspaceFolderInfo } from "../types";
import { log } from "../extension/logger";

export interface PinnedFolderContext {
  freshFiles: ReadonlyMap<AbsolutePath, FileMetadata>;
  openChangesMode: boolean;
  workspaceFolders: readonly WorkspaceFolderInfo[];
}

/**
 * What an expanded pinned folder lists: its entries read from disk, minus
 * `files.exclude`, with one non-recursive watcher per listed folder so adds and
 * deletes show up. Watchers are dropped on every full re-render; VS Code asks
 * again for the folders that are still expanded, which re-creates them.
 */
export class PinnedFolderContents implements vscode.Disposable {
  /** Pinned folder each child folder row sits under, for child ids and re-listing. */
  private readonly rootOf = new WeakMap<FreshFileItem, string>();
  private readonly watchers = new Map<string, { watcher: vscode.Disposable; item: FreshFileItem; timer?: NodeJS.Timeout }>();
  private readonly excludeFilter = new FilesExcludeFilter(
    () => ConfigService.getRespectFilesExclude(),
    (folderPath) => ConfigService.getFilesExcludeExpression(vscode.Uri.file(folderPath)),
  );
  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly context: () => PinnedFolderContext,
    /** Re-render one folder row's children. */
    private readonly onFolderChanged: (item: FreshFileItem) => void,
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("files.exclude") || e.affectsConfiguration(ConfigKeys.RESPECT_FILES_EXCLUDE)) {
        this.excludeFilter.invalidate();
      }
    });
  }

  /** True for rows whose twistie lists folder contents. */
  expands(item: FreshFileItem): boolean {
    return item.contextValue === TreeItemContextValues.PINNED_DIRECTORY || this.rootOf.has(item);
  }

  async childrenOf(item: FreshFileItem): Promise<FreshFilesTreeItem[]> {
    const dirPath = normalizePath(item.resourceUri.fsPath);
    const rootPath = this.rootOf.get(item) ?? dirPath;
    this.watch(dirPath, item);

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(item.resourceUri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Pinned folder: could not read ${dirPath}: ${message}`, "warn");
      return [new MessageTreeItem(`Can't read this folder: ${message}`, "warning")];
    }

    const { freshFiles, openChangesMode, workspaceFolders } = this.context();
    const rows = listPinnedFolder(
      dirPath,
      entries.map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0] as const),
      p => this.excludeFilter.isExcludedByOwner(p, workspaceFolders),
    );
    if (rows.length === 0) {
      return [new MessageTreeItem("Empty folder")];
    }

    return rows.map(row => {
      const uri = vscode.Uri.file(row.path);
      let child: FreshFileItem;
      if (row.isDirectory) {
        child = FreshFileItem.forDirectory(uri, openChangesMode, 0);
        child.contextValue = TreeItemContextValues.PINNED_CHILD_DIRECTORY;
        this.rootOf.set(child, rootPath);
      } else {
        const metadata = freshFiles.get(asAbsolutePath(row.path));
        child = FreshFileItem.forFile(
          uri, openChangesMode, false, metadata?.commitHash, metadata?.isPending ?? false,
          metadata?.status, metadata?.renameSource, vscode.TreeItemCollapsibleState.None,
        );
        child.contextValue = TreeItemContextValues.PINNED_CHILD_FILE;
      }
      // Scoped to the pinned folder: the same file can also be pinned on its own,
      // or sit under two pinned folders when one is inside the other.
      child.id = `${createPinnedFileId(rootPath)}::${row.path}`;
      return child;
    });
  }

  /** Drop every watcher; the next render re-creates them for folders still expanded. */
  reset(): void {
    for (const { watcher, timer } of this.watchers.values()) {
      watcher.dispose();
      clearTimeout(timer);
    }
    this.watchers.clear();
  }

  dispose(): void {
    this.reset();
    this.configListener.dispose();
  }

  private watch(dirPath: string, item: FreshFileItem): void {
    const existing = this.watchers.get(dirPath);
    if (existing) {
      existing.item = item;
      return;
    }
    // Non-recursive: only this folder's own entries decide what it lists.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirPath), "*"), false, true, false,
    );
    const entry: { watcher: vscode.Disposable; item: FreshFileItem; timer?: NodeJS.Timeout } = { watcher, item };
    const changed = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onFolderChanged(entry.item), 200);
    };
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.watchers.set(dirPath, entry);
  }
}
