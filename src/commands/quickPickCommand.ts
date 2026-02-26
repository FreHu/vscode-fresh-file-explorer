import * as vscode from "vscode";
import * as path from "path";
import { FreshFileProvider } from "../freshFileProvider";
import { log } from "../extension/logger";
import { AbsolutePath } from "../pathTypes";
import { FileMetadata } from "../types";
import { isPendingChangesMode } from "../timeWindowUtils";
import { openSearchWithFiles, convertToRelativePaths } from "./searchCommand";
import { openFileWithoutDuplicating } from "../utils";

interface FreshFileQuickPickItem extends vscode.QuickPickItem {
  filePath?: AbsolutePath;
  metadata?: FileMetadata;
  isFilter?: boolean;
  filterFn?: (metadata: FileMetadata) => boolean;
  isSearch?: boolean;
}

/**
 * Gets status icon for a file based on its metadata
 */
function getStatusIcon(metadata: FileMetadata): string {
  if (metadata.isPending) {
    const statusIconMap: Record<string, string> = {
      M: "$(diff-modified)",
      MM: "$(diff-modified)",
      A: "$(diff-added)",
      AM: "$(diff-added)",
      D: "$(diff-removed)",
      "??": "$(question)",
      U: "$(warning)",
      UU: "$(warning)",
    };
    return statusIconMap[metadata.status ?? ""] ?? "$(circle-filled)";
  }
  return "$(git-commit)";
}

const statusTagMap: Record<string, string> = {
  M: "M",
  MM: "M",
  A: "A",
  AM: "A",
  D: "D",
  "??": "?",
  U: "U",
  UU: "U",
};

/**
 * Creates filter quick pick items for common status combinations
 */
const allFilterQuickPickItems: FreshFileQuickPickItem[] =
  [
    {
      label: "$(filter) All Historical",
      description: "Files from git history",
      isFilter: true,
      filterFn: (m) => !(m.isPending ?? false),
    },
    {
      label: "$(filter) All Pending",
      description: "Uncommitted changes",
      isFilter: true,
      filterFn: (m) => m.isPending ?? false,
    },
    {
      label: "$(filter) All Modified",
      description: "Files that have been modified (pending or historical)",
      isFilter: true,
      filterFn: (m) => m.status === "M" || m.status === "MM",
    },
    {
      label: "$(filter) All Added",
      description: "Files that have been added (pending or historical)",
      isFilter: true,
      filterFn: (m) => m.status === "A" || m.status === "AM",
    },
    {
      label: "$(filter) Historical Modified",
      description: "Modified files from git history",
      isFilter: true,
      filterFn: (m) => !(m.isPending ?? false) && (m.status === "M" || m.status === "MM"),
    },
    {
      label: "$(filter) Pending Modified",
      description: "Uncommitted modified files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "M" || m.status === "MM"),
    },
    {
      label: "$(filter) Pending Added",
      description: "Uncommitted new files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "A" || m.status === "AM"),
    },
    {
      label: "$(filter) Untracked",
      description: "Untracked files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "??"),
    },
  ];

/**
* Creates filter quick pick items for pending changes mode (no need for historical options)
*/
const filterQuickPickItemsForPendingChangesMode: FreshFileQuickPickItem[] =
  [
    {
      label: "$(filter) Pending Modified",
      description: "Uncommitted modified files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "M" || m.status === "MM"),
    },
    {
      label: "$(filter) Pending Added",
      description: "Uncommitted new files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "A" || m.status === "AM"),
    },
    {
      label: "$(filter) Untracked",
      description: "Untracked files",
      isFilter: true,
      filterFn: (m) => (m.isPending ?? false) && (m.status === "??"),
    },
  ];

const searchItem: FreshFileQuickPickItem = {
  label: "$(search) Open search across filtered files",
  isSearch: true,
};

const filesSeparator = { label: "Files", kind: vscode.QuickPickItemKind.Separator };

const filtersSeparator = { label: "Filters", kind: vscode.QuickPickItemKind.Separator };
/**
 * Shows a second-level quick pick with filtered files (no status tags in labels)
 */
function showFilteredQuickPick(
  filterLabel: string,
  filteredFiles: Array<{
    absPath: AbsolutePath;
    metadata: FileMetadata;
    relativePath: string;
    workspaceName: string;
  }>,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  onBack: () => void,
): void {
  const items: FreshFileQuickPickItem[] = filteredFiles.map(({ absPath, metadata, relativePath, workspaceName }) => {
    const fileName = path.basename(absPath);
    const dirPath = path.dirname(relativePath);
    const statusIcon = getStatusIcon(metadata);

    return {
      label: `${statusIcon} ${fileName}`,
      description: dirPath !== "." ? dirPath : "",
      detail: workspaceFolders.length > 1 ? workspaceName : undefined,
      filePath: absPath,
      metadata,
    };
  });

  // Sort by file name
  items.sort((a, b) => {
    const nameA = path.basename(a.filePath!).toLowerCase();
    const nameB = path.basename(b.filePath!).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  // Add search action at the top
  const filePaths = filteredFiles.map(f => f.absPath);
  const allItems: FreshFileQuickPickItem[] = [
    searchItem,
    filesSeparator,
    ...items,
  ];

  const filteredQuickPick = vscode.window.createQuickPick<FreshFileQuickPickItem>();
  filteredQuickPick.title = filterLabel;
  filteredQuickPick.items = allItems;
  filteredQuickPick.placeholder = `Search in ${items.length} filtered files (Esc to go back)`;
  filteredQuickPick.matchOnDescription = true;
  filteredQuickPick.matchOnDetail = true;

  let actionTaken = false;

  filteredQuickPick.onDidAccept(async () => {
    const selected = filteredQuickPick.selectedItems[0];
    if (selected?.isSearch) {
      actionTaken = true;
      filteredQuickPick.hide();
      await openSearchWithFiles(filePaths, workspaceFolders);
    } else if (selected?.filePath) {
      log(`Quick pick: Opening file ${selected.filePath}`);
      const uri = vscode.Uri.file(selected.filePath);
      await openFileWithoutDuplicating(uri);
      actionTaken = true;
      filteredQuickPick.hide();
    }
  });

  filteredQuickPick.onDidHide(() => {
    filteredQuickPick.dispose();
    // If no action was taken, go back to the main quick pick
    if (!actionTaken) {
      onBack();
    }
  });

  filteredQuickPick.show();
}

/**
 * Shows the main quick pick with all files and filters
 */
function showMainQuickPick(
  fileData: Array<{
    absPath: AbsolutePath;
    metadata: FileMetadata;
    relativePath: string;
    workspaceName: string;
  }>,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  isPendingMode: boolean,
): void {

  const filterItems = isPendingMode
    ? filterQuickPickItemsForPendingChangesMode
    : allFilterQuickPickItems;

  // Create file items with status tags in description
  const fileItems: FreshFileQuickPickItem[] = fileData.map(({ absPath, metadata, relativePath, workspaceName }) => {
    const fileName = path.basename(absPath);
    const dirPath = path.dirname(relativePath);
    const statusIcon = getStatusIcon(metadata);

    // Status tags: P/H + M/A/D/etc
    const categoryTag = metadata.isPending ? "P" : "H";
    const statusTag = statusTagMap[metadata.status ?? ""] ?? "";
    const statusTags = `(${categoryTag}-${statusTag})`;
    const pathPart = dirPath !== "." ? dirPath : "";
    const descParts = [pathPart, statusTags].filter(Boolean);

    return {
      label: `${statusIcon} ${fileName}`,
      description: descParts.join(" · "),
      detail: workspaceFolders.length > 1 ? workspaceName : undefined,
      filePath: absPath,
      metadata,
    };
  });

  // Sort file items by name
  fileItems.sort((a, b) => {
    const nameA = path.basename(a.filePath!).toLowerCase();
    const nameB = path.basename(b.filePath!).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  // Add search action and combine all items
  const filePaths = fileData.map(f => f.absPath);
  const allItems: FreshFileQuickPickItem[] = [
    searchItem,
    filtersSeparator,
    ...filterItems,
    filesSeparator,
    ...fileItems,
  ];

  // Create main quick pick
  const mainQuickPick = vscode.window.createQuickPick<FreshFileQuickPickItem>();
  mainQuickPick.items = allItems;
  mainQuickPick.placeholder = `Search ${fileItems.length} files or select a filter`;
  mainQuickPick.matchOnDescription = true;
  mainQuickPick.matchOnDetail = true;

  // Handle selection
  mainQuickPick.onDidAccept(async () => {
    const selected = mainQuickPick.selectedItems[0];
    if (!selected) {
      return;
    }

    mainQuickPick.hide();

    if (selected.isSearch) {
      // Search action selected
      await openSearchWithFiles(filePaths, workspaceFolders);
    } else if (selected.isFilter && selected.filterFn) {
      // Filter selected - show second quick pick with filtered files
      const filtered = fileData.filter(({ metadata }) => selected.filterFn!(metadata));
      const onBack = () => {
        // On back, recreate and show the main quick pick
        showMainQuickPick(fileData, workspaceFolders, isPendingMode);
      };
      showFilteredQuickPick(selected.label.replace("$(filter) ", ""), filtered, workspaceFolders, onBack);
    } else if (selected.filePath) {
      // File selected - open it
      log(`Quick pick: Opening file ${selected.filePath}`);
      const uri = vscode.Uri.file(selected.filePath);
      await openFileWithoutDuplicating(uri);
    }
  });

  // Handle dismiss
  mainQuickPick.onDidHide(() => {
    mainQuickPick.dispose();
  });

  mainQuickPick.show();
}

/**
 * Opens a searchable quick pick showing all visible files in the Fresh File Explorer view.
 * Filter items at the top allow narrowing by file status. Selecting a filter shows a
 * second quick pick with only matching files. Files can also be opened directly.
 */
export async function handleQuickPickFile(
  provider: FreshFileProvider,
): Promise<void> {
  // Ensure data is loaded (this handles the case where the view hasn't been opened yet)
  const dataAvailable = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Loading fresh files...",
    },
    async () => {
      return await provider.ensureDataLoaded();
    },
  );

  if (!dataAvailable) {
    vscode.window.showInformationMessage("No Git repositories found in workspace");
    log("Quick pick: No Git repositories available");
    return;
  }

  const filesWithMetadata = provider.getVisibleFilesWithMetadata();

  if (filesWithMetadata.size === 0) {
    vscode.window.showInformationMessage("No files available in Fresh File Explorer");
    log("Quick pick: No files available");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showWarningMessage("No workspace folder open");
    return;
  }

  // Collect file data for later use
  const absPathsArray = Array.from(filesWithMetadata.keys());
  const pathInfo = convertToRelativePaths(absPathsArray, workspaceFolders, true);
  
  const fileData: Array<{
    absPath: AbsolutePath;
    metadata: FileMetadata;
    relativePath: string;
    workspaceName: string;
  }> = absPathsArray.map((absPath, index) => ({
    absPath,
    metadata: filesWithMetadata.get(absPath)!,
    relativePath: pathInfo[index].relativePath,
    workspaceName: pathInfo[index].workspaceName,
  }));

  // Check if we're in pending changes mode
  const isPendingMode = isPendingChangesMode(provider.currentTimeWindow);

  // Show the main quick pick
  showMainQuickPick(fileData, workspaceFolders, isPendingMode);
}
