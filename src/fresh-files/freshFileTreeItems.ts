import * as vscode from "vscode";
import * as path from "path";
import { Commands } from "../commands/commandConstants";
import { formatRepoDescription, formatRepoTooltip } from "../utils/formatUtils";
import { RepoKind, repoKindIcon, repoKindLabel } from "../git/repoKind";
import { CommitHash } from "../types";
import { TreeItemContextValues, createNoteId } from "./treeItemConstants";
import { OutlineHeading } from "./outline/headingTree";
import { normalizePath } from "../utils";

/**
 * Tree item representing a file or directory in the Fresh File Explorer
 */
export class FreshFileItem extends vscode.TreeItem {
  /**
   * For group-header items in a non-File-Structure grouping mode: the normalized
   * path of the repo this group is nested under.
   */
  groupRepoScope?: string;

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
    kind: RepoKind = "repo",
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
      item.iconPath = new vscode.ThemeIcon(repoKindIcon(kind));
      const kindLabel = repoKindLabel(kind);
      item.tooltip = formatRepoTooltip(repoName, branchName, fileCount, pathspec, folderScope)
        + (kindLabel ? `\n${kindLabel}` : "");
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
    /** Files are leaves, except a pinned outline file that lists its headings. */
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
  ): FreshFileItem {
    return new FreshFileItem(
      uri,
      false,
      collapsibleState,
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
    this.contextValue = TreeItemContextValues.MESSAGE;
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
    this.iconPath = new vscode.ThemeIcon("note");
    this.checkboxState = completed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.tooltip = noteText;
  }
}

/**
 * A heading of a pinned outline file (markdown, Org-mode, AsciiDoc). Its
 * `tag` (an Org-mode TODO keyword) shows as the description.
 * `treeDepth` is 1 for the file's top-level headings; it decides the default
 * expansion together with `expandDepth`, which is also part of the id so a
 * changed setting re-applies (VS Code pins collapse state to an id).
 */
export class OutlineHeadingItem extends vscode.TreeItem {
  constructor(
    public readonly fileUri: vscode.Uri,
    public readonly heading: OutlineHeading,
    public readonly treeDepth: number,
    expandDepth: number,
  ) {
    super(
      heading.text,
      heading.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : treeDepth < expandDepth
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `heading:${normalizePath(fileUri.fsPath)}#${heading.key}@e${expandDepth}`;
    this.iconPath = new vscode.ThemeIcon("symbol-string");
    this.description = heading.tag;
    this.tooltip = `${heading.tag ? `${heading.tag} ` : ""}${heading.text}\nLevel ${heading.level}, line ${heading.line + 1}`;
    // A tree item with a command runs it on click instead of toggling, so
    // only leaves navigate on click; parents get an inline Go to Heading button.
    if (heading.children.length > 0) {
      this.contextValue = TreeItemContextValues.OUTLINE_HEADING_PARENT;
    } else {
      this.contextValue = TreeItemContextValues.OUTLINE_HEADING;
      this.command = { command: Commands.GO_TO_HEADING, title: "Go to Heading", arguments: [this] };
    }
  }

  /** Open the file with the cursor on this heading. */
  async goTo(): Promise<void> {
    const position = new vscode.Position(this.heading.line, 0);
    await vscode.commands.executeCommand("vscode.open", this.fileUri, {
      selection: new vscode.Range(position, position),
    });
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
    this.iconPath = new vscode.ThemeIcon(repoKindIcon("submodule"));
    this.contextValue = TreeItemContextValues.SUBMODULE_ENTRY;
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
  | OutlineHeadingItem
  | SubmoduleEntryItem
  | UninitializedSubmodulesGroupItem
  | UninitializedSubmoduleItem;

/** Type guards for specific FreshFileItem contextValue variants */
export function isAuthorGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.AUTHOR_GROUP;
}
export function isCommitHashGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.COMMIT_HASH_GROUP;
}
/** The hash of a commit group header, from its `freshfiles://commit/<hash>` URI (the label is the commit subject). */
export function commitHashOfGroup(item: FreshFileItem): string {
  return item.resourceUri.path.replace(/^\//, "");
}
export function isPendingGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.PENDING_GROUP;
}
export function isMoonPhaseGroup(el: FreshFilesTreeItem): el is FreshFileItem {
  return el instanceof FreshFileItem && el.contextValue === TreeItemContextValues.MOON_PHASE_GROUP;
}
