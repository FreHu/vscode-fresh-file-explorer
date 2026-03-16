import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { toRelativePathsWithWorkspaceName } from "../utils/pathUtils";

export interface FreshFileExportItem {
  absolutePath: string;
  relativePath: string;
  workspaceName: string;
  status: string | undefined;
  isPending: boolean;
  author: string | undefined;
  date: string;
  commitMessage: string | undefined;
  commitHash: string | undefined;
}

/**
 * Returns all currently visible fresh files as plain JSON-serializable objects,
 * for consumption by the Code Telescope custom finder.
 */
export async function handleGetFilesForCodeTelescope(
  provider: FreshFileProvider,
): Promise<FreshFileExportItem[] | undefined> {
  const dataAvailable = await provider.ensureDataLoaded();
  if (!dataAvailable) {
    return undefined;
  }

  const filesWithMetadata = provider.getVisibleFilesWithMetadata();
  if (filesWithMetadata.size === 0) {
    return [];
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return [];
  }

  const absPathsArray = Array.from(filesWithMetadata.keys());
  const pathInfo = toRelativePathsWithWorkspaceName(absPathsArray, workspaceFolders);

  return absPathsArray.map((absPath, index) => {
    const metadata = filesWithMetadata.get(absPath)!;
    return {
      absolutePath: absPath,
      relativePath: pathInfo[index].relativePath,
      workspaceName: pathInfo[index].workspaceName,
      status: metadata.status,
      isPending: metadata.isPending ?? false,
      author: metadata.author,
      date: metadata.date.toISOString(),
      commitMessage: metadata.commitMessage,
      commitHash: metadata.commitHash,
    };
  });
}
