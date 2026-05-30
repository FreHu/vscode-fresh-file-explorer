import * as vscode from "vscode";
import * as path from "path";
import { Commands } from "../commands/commandConstants";
import { formatRepoDescription, formatRepoTooltip } from "../utils/formatUtils";
import { CommitHash } from "../types";
import { TreeItemContextValues, createNoteId } from "./treeItemConstants";

/**
 * Tree item representing a file or directory in the Fresh File Explorer
 */
export class FreshFileItem extends vscode.TreeItem {
constructor(
    public override readonly resourceUri: vscode.Uri,
    public readonly isDirectory: boolean,
    public override readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly openChangesMode: boolean = false,
    public readonly fileCount?: number,
    public readonly isDeleted: boolean = false,
    public readonly commitHash?: CommitHash,
    public readonly isPending: boolean = false,
    public readonly status?: string,
    public readonly renameSource?: string,
  ) {
    super(resourceUri, collapsibleState);

    // Set stable ID for tree item identity - VS Code uses this to track items across refreshes
    this.id = resourceUri.fsPath;

    if (isDeleted) {
      this.contextValue = TreeItemContextValues.DELETED_FILE;
      // Use a custom label with trash icon
      const fileName = path.basename(resourceUri.fsPath);
      this.label = `${fileName}`;
      // Use a red/gray color via theme icon
      this.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("errorForeground"));
      // Exhume command for deleted files
      this.command = {
        command: Commands.EXHUME,
        title: "Exhume (View Deleted File)",
        arguments: [this],
      };
    } else {
      // Set context value based on type and pending status
      if (isDirectory) {
        this.contextValue = TreeItemContextValues.FOLDER;
      } else if (isPending) {
        this.contextValue = TreeItemContextValues.PENDING_FILE;
      } else {
        this.contextValue = TreeItemContextValues.FILE;
      }

      if (!isDirectory) {
        // Use openChangesMode to determine which command to use
        // These commands use preserveFocus to keep focus on the tree (like native explorer)
        if (openChangesMode) {
          this.command = {
            command: Commands.OPEN_CHANGES,
            title: "Open Changes",
            arguments: [this, undefined, { preserveFocus: true }],
          };
        } else {
          this.command = {
            command: Commands.OPEN_FILE,
            title: "Open File",
            arguments: [this, undefined, { preserveFocus: true }],
          };
        }
      }
    }

    // Add file count badge for directories
    if (isDirectory && fileCount !== undefined && fileCount > 0) {
      this.description = `(${fileCount})`;
    }
  }

  /**
   * Create a FreshFileItem representing a git repository
   */
  static forRepository(
    uri: vscode.Uri,
    openChangesMode: boolean,
    fileCount: number,
    repoName: string,
    branchName: string | undefined,
    contextValue: string,
    expanded: boolean = true,
    isLoading: boolean = false,
    pathspec?: string,
    folderScope?: string,
    isLoadingHistorical: boolean = false,
  ): FreshFileItem {
    // VS Code's TreeView locks in the *initial* collapsibleState the first time
    // an item id is shown. Any later change to collapsibleState on the same id
    // is silently ignored — the item keeps its first-seen state. So we have to
    // honor the user's `expanded` preference from the very first render, even
    // while loading.
    const collapsibleState = isLoading || isLoadingHistorical
      ? expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : fileCount > 0
        ? expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    const item = new FreshFileItem(
      uri,
      true,
      collapsibleState,
      openChangesMode,
      fileCount,
    );

    // Use a distinct id prefix so repo-root nodes never clash with directory nodes
    // that share the same path (e.g. a submodule directory inside the parent repo tree).
    item.id = "repo:" + uri.fsPath;

    item.label = repoName;
    if (isLoading) {
      item.description = "loading…";
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      item.tooltip = `Loading ${repoName}…`;
    } else {
      item.description = formatRepoDescription(branchName, fileCount, pathspec, folderScope);
      item.iconPath = new vscode.ThemeIcon("repo");
      item.tooltip = formatRepoTooltip(repoName, branchName, fileCount, pathspec, folderScope);
    }
    item.contextValue = contextValue;

    return item;
  }

  /**
   * Create a FreshFileItem representing a directory
   */
  static forDirectory(
    uri: vscode.Uri,
    openChangesMode: boolean,
    fileCount: number,
    expanded: boolean = false,
  ): FreshFileItem {
    return new FreshFileItem(
      uri,
      true,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      openChangesMode,
      fileCount,
    );
  }

  /**
   * Create a FreshFileItem representing the pinned items folder
   */
  static forPinnedFolder(
    uri: vscode.Uri,
    openChangesMode: boolean,
    fileCount: number,
    expanded: boolean = true,
  ): FreshFileItem {
    const item = new FreshFileItem(
      uri,
      true,
      fileCount > 0
        ? expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      openChangesMode,
      fileCount,
    );

    item.label = "Pinned Items";
    item.description = fileCount > 0 ? `(${fileCount})` : undefined;
    item.contextValue = TreeItemContextValues.PINNED_FOLDER;
    item.iconPath = new vscode.ThemeIcon("pinned");
    item.tooltip = `Pinned items (${fileCount})`;

    return item;
  }

  /**
   * Create a FreshFileItem representing a file with git metadata
   */
  static forFile(
    uri: vscode.Uri,
    openChangesMode: boolean,
    isDeleted: boolean = false,
    commitHash?: CommitHash,
    isPending: boolean = false,
    status?: string,
    renameSource?: string,
  ): FreshFileItem {
    return new FreshFileItem(
      uri,
      false,
      vscode.TreeItemCollapsibleState.None,
      openChangesMode,
      undefined,
      isDeleted,
      commitHash,
      isPending,
      status,
      renameSource,
    );
  }
}

/**
 * Tree item for displaying info/error messages in the tree view
 */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string, icon?: string, action?: { command: string; title: string; args?: any[] }) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "message";
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    if (action) {
      this.command = {
        command: action.command,
        title: action.title,
        arguments: action.args,
      };
    }
  }
}

/**
 * Tree item for displaying pinned notes (optionally as todo items with completed state)
 */
export class NoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly noteId: string,
    public readonly noteText: string,
    public readonly completed: boolean = false,
  ) {
    super(noteText, vscode.TreeItemCollapsibleState.None);
    this.id = createNoteId(noteId);
    this.contextValue = TreeItemContextValues.PINNED_NOTE;
    this.iconPath = new vscode.ThemeIcon(completed ? "pass" : "circle-outline");
    this.tooltip = noteText;
  }
}

/**
 * Tree item representing a submodule directory entry inside a parent repo's tree.
 * Uses a plain string label (no file URI)
 */
export class SubmoduleEntryItem extends vscode.TreeItem {
  readonly isDirectory = false;
  constructor(
    public readonly submoduleFsPath: string,
    parentPath: string,
  ) {
    const name = path.basename(submoduleFsPath);
    super(name, vscode.TreeItemCollapsibleState.None);
    // ID must be unique across the whole tree — include parent path to distinguish
    // the same submodule appearing under multiple parent repos.
    this.id = `submodule-entry:${parentPath}/${name}`;
    this.description = "submodule";
    this.tooltip = `Submodule: ${submoduleFsPath}`;
    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = "submoduleEntry";
    this.command = {
      command: Commands.FOCUS_SUBMODULE_REPO,
      title: "Focus Submodule",
      arguments: [submoduleFsPath],
    };
  }
}

/**
 * Collapsible top-level node grouping all uninitialized submodules so the user
 * knows they exist without the extension scanning them (an uninitialized
 * submodule dir resolves to the superproject — scanning it is both wrong and slow).
 */
export class UninitializedSubmodulesGroupItem extends vscode.TreeItem {
  constructor(count: number) {
    super(`Uninitialized submodules (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "uninitialized-submodules";
    this.contextValue = TreeItemContextValues.UNINITIALIZED_SUBMODULE_GROUP;
    this.iconPath = new vscode.ThemeIcon("archive");
    this.tooltip = "Submodules declared in .gitmodules but not checked out. Run `git submodule update --init` to populate them.";
  }
}

/**
 * Leaf entry for a single uninitialized submodule. Carries no command — there is
 * no repo node to focus — and no file URI.
 */
export class UninitializedSubmoduleItem extends vscode.TreeItem {
  readonly isDirectory = false;
  constructor(
    public readonly repoRelPath: string,
    public readonly repoFullPath: string,
  ) {
    super(repoRelPath, vscode.TreeItemCollapsibleState.None);
    this.id = `uninitialized-submodule:${repoFullPath}`;
    this.description = "not checked out";
    this.tooltip = `Uninitialized submodule: ${repoFullPath}\nRun \`git submodule update --init -- ${repoRelPath}\` to populate it.`;
    this.iconPath = new vscode.ThemeIcon("circle-slash");
    this.contextValue = TreeItemContextValues.UNINITIALIZED_SUBMODULE;
  }
}

export type FreshFilesTreeItem =
  | FreshFileItem
  | MessageTreeItem
  | NoteTreeItem
  | SubmoduleEntryItem
  | UninitializedSubmodulesGroupItem
  | UninitializedSubmoduleItem;

/** Type guards for specific FreshFileItem contextValue variants */
export function isPinnedFolder(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.PINNED_FOLDER;
}
export function isAuthorGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.AUTHOR_GROUP;
}
export function isCommitHashGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.COMMIT_HASH_GROUP;
}
export function isMoonPhaseGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.MOON_PHASE_GROUP;
}
export function isRetrogradeGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.RETROGRADE_GROUP;
}
