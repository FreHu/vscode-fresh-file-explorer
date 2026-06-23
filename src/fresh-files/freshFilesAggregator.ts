import {
  WorkspaceFolderInfo,
  FileMetadata,
  AuthorData,
  CommitHash,
  CommitAuthor,
  CommitDataWithFileCount,
  asCommitAuthor,
  asCommitMessage,
} from "../types";
import { AbsolutePath } from "../pathTypes";

/**
 * Pure aggregations over the flat fresh-files map, used to populate the
 * filter quick-picks. Extracted from FreshFileProvider so they're testable in
 * isolation (no tree/provider state involved).
 */

/** Unique authors with their file counts, sorted by count descending. */
export function aggregateAuthors(freshFiles: Map<AbsolutePath, FileMetadata>): AuthorData[] {
  const authorCounts = new Map<CommitAuthor, number>();
  for (const metadata of freshFiles.values()) {
    const author = asCommitAuthor(metadata.author || "(unknown)");
    authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
  }
  return Array.from(authorCounts.entries())
    .map(([author, fileCount]) => ({ author, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount); // Sort by file count descending
}

/**
 * Unique commits among the current files (pending files, which have no commit
 * hash, are skipped), each with its file count and owning repo name, sorted
 * newest-first.
 */
export function aggregateCommits(
  freshFiles: Map<AbsolutePath, FileMetadata>,
  workspaceFolders: WorkspaceFolderInfo[],
): CommitDataWithFileCount[] {
  const commitInfo = new Map<CommitHash, CommitDataWithFileCount>();
  for (const [filePath, metadata] of freshFiles.entries()) {
    const hash = metadata.commitHash;
    if (!hash) {
      continue;
    }

    if (commitInfo.has(hash)) {
      commitInfo.get(hash)!.fileCount++;
    } else {
      // Find which repo this file belongs to
      let repoName: string | undefined;
      for (const folder of workspaceFolders) {
        if (filePath.startsWith(folder.path)) {
          // For multi-repo workspaces, find the specific repo
          if (folder.gitRepos.length > 1) {
            const relativePath = filePath.substring(folder.path.length + 1);
            for (const repoRelPath of folder.gitRepos) {
              if (repoRelPath === "" || relativePath.startsWith(repoRelPath + "/")) {
                repoName = repoRelPath === "" ? folder.name : repoRelPath.split("/").pop();
                break;
              }
            }
          } else {
            repoName = folder.name;
          }
          break;
        }
      }

      commitInfo.set(hash, {
        message: asCommitMessage(metadata.commitMessage || "(no message)"),
        author: asCommitAuthor(metadata.author || "(unknown)"),
        date: metadata.date,
        fileCount: 1,
        hash: hash,
        repoName,
      });
    }
  }
  return Array.from(commitInfo.entries())
    .map(([_, info]) => ({ ...info }))
    .sort((a, b) => b.date.getTime() - a.date.getTime()); // Sort by date descending (newest first)
}
