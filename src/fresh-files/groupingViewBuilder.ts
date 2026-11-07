import * as vscode from "vscode";
import * as path from "path";
import { AbsolutePath } from "../pathTypes";
import { DescriptionFormat, FileMetadata, SortOrder } from "../types";
import { ConfigService } from "../config/configService";
import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatRelativeDate, formatGroupDescription, formatTooltipLineChanges, formatCommitGroupHeader } from "../utils/formatUtils";
import { deferCommitTooltip } from "../utils/lazyCommitTooltip";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";
import { getMoonPhase, MOON_PHASE_ORDER, type MoonPhase } from "../fresh-files/moonPhase";
import { type GroupingMode } from "../fresh-files/groupingMode";
import { plural } from "../utils/plural";

/**
 * Calculate total line changes from items with metadata.
 * Returns undefined if the feature is disabled to avoid unnecessary work.
 */
function calculateTotalLineChanges<T extends { metadata: FileMetadata }>(
  items: T[],
): { added: number; deleted: number } | undefined {
  if (!ConfigService.getDescriptionFormat().showLineChanges) {
    return undefined;
  }
  return items.reduce(
    (totals, item) => ({
      added: totals.added + (item.metadata.linesAdded ?? 0),
      deleted: totals.deleted + (item.metadata.linesDeleted ?? 0),
    }),
    { added: 0, deleted: 0 },
  );
}

/** The newest date among a group's files (epoch 0 when none has one). */
function mostRecentDateInGroup<T extends { metadata: FileMetadata }>(group: T[]): Date {
  return group.reduce((max, item) => (item.metadata.date && item.metadata.date > max ? item.metadata.date : max), new Date(0));
}

/**
 * Builds tree views for different grouping modes.
 * Handles author, commit hash, and moon phase grouping.
 */
export class GroupingViewBuilder {
  /**
   * Whether group headers should render expanded by default.
   */
  private static groupsExpandByDefault(): boolean {
    return ConfigService.getAutoExpandDepth() > 1;
  }

  /**
   * Bucket the files that pass `filterPredicate` under a group key.
   * A file whose `keyOf` returns undefined is left out of every group.
   */
  private static groupFilesBy<K>(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    keyOf: (metadata: FileMetadata) => K | undefined,
  ): Map<K, { files: AbsolutePath[]; metadata: FileMetadata }[]> {
    const groups = new Map<K, { files: AbsolutePath[]; metadata: FileMetadata }[]>();
    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) {
        continue;
      }
      const key = keyOf(metadata);
      if (key === undefined) {
        continue;
      }
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push({ files: [filePath], metadata });
    }
    return groups;
  }

  /**
   * Build view grouped by author
   */
  static buildAuthorGroupedView(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
  ): FreshFilesTreeItem[] {
    // Pending changes have no author.
    const authorGroups = GroupingViewBuilder.groupFilesBy(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.author || "(No author)",
    );

    const sortedAuthors = sortOrder === "date"
      ? Array.from(authorGroups.entries())
          .sort((a, b) => {
            const maxA = mostRecentDateInGroup(a[1]);
            const maxB = mostRecentDateInGroup(b[1]);
            return maxB.getTime() - maxA.getTime();
          })
          .map(([name]) => name)
      : Array.from(authorGroups.keys()).sort((a, b) => a.localeCompare(b));

    for (const authorName of sortedAuthors) {
      const group = authorGroups.get(authorName)!;
      const fileCount = group.length;

      const authorUri = vscode.Uri.parse(`freshfiles://author/${encodeURIComponent(authorName)}`);
      
      const mostRecentDate = mostRecentDateInGroup(group);

      // Calculate total line changes for this author
      const totals = calculateTotalLineChanges(group);

      const authorItem = FreshFileItem.forDirectory(
        authorUri,
        openChangesMode,
        fileCount,
        GroupingViewBuilder.groupsExpandByDefault(),
      );

      authorItem.label = authorName;
      authorItem.description = formatGroupDescription(fileCount, totals?.added, totals?.deleted);
      authorItem.tooltip = formatDirectoryTooltip(fileCount, mostRecentDate, totals?.added, totals?.deleted);
      authorItem.iconPath = new vscode.ThemeIcon("person");

      authorItem.contextValue = TreeItemContextValues.AUTHOR_GROUP;

      results.push(authorItem);
    }

    return results;
  }

  /**
   * Build files for a specific author
   */
  static buildAuthorFiles(
    authorName: string,
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
    skipAuthorInDescription: boolean = false,
  ): FreshFileItem[] {
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => (metadata.author || "(No author)") === authorName,
      sortOrder,
      openChangesMode,
      skipAuthorInDescription ? { showAuthor: false } : undefined,
    );
  }

  /**
   * Shared filter → sort → build pipeline behind every per-group file list.
   * `groupPredicate` selects the files belonging to one group (author, commit,
   * moon phase, …); `descriptionFormatOverride` tweaks the per-file description
   * (e.g. hide the author inside an author group).
   */
  private static buildGroupFiles(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    groupPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
    descriptionFormatOverride?: Partial<DescriptionFormat>,
  ): FreshFileItem[] {
    const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];
    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) { continue; }
      if (!groupPredicate(metadata)) { continue; }
      filesList.push({ filePath, metadata });
    }

    GroupingViewBuilder.sortFilesList(filesList, sortOrder);

    const descriptionFormat = descriptionFormatOverride
      ? { ...ConfigService.getDescriptionFormat(), ...descriptionFormatOverride }
      : ConfigService.getDescriptionFormat();

    const items: FreshFileItem[] = [];
    for (const { filePath, metadata } of filesList) {
      const item = FreshFileItem.forFile(
        vscode.Uri.file(filePath),
        openChangesMode,
        metadata.isDeleted ?? false,
        metadata.commitHash,
        metadata.isPending ?? false,
        metadata.status,
        metadata.renameSource,
      );
      item.description = formatFileDescription(metadata, descriptionFormat);
      item.tooltip = formatFileTooltip(metadata, descriptionFormat);
      items.push(item);
    }
    return items;
  }

  /**
   * Build view grouped by commit hash
   */
  static buildCommitHashGroupedView(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
  ): FreshFilesTreeItem[] {
    // Pending files have no commit and get no group.
    const commitGroups = GroupingViewBuilder.groupFilesBy(
      freshFiles,
      filterPredicate,
      (metadata) => (metadata.isPending || !metadata.commitHash ? undefined : metadata.commitHash),
    );

    const sortedCommits = Array.from(commitGroups.entries()).sort((a, b) => {
      const dateA = mostRecentDateInGroup(a[1]);
      const dateB = mostRecentDateInGroup(b[1]);
      return dateB.getTime() - dateA.getTime();
    });

    for (const [commitHash, group] of sortedCommits) {
      const fileCount = group.length;
      const firstFile = group[0];
      // Every file in the group shares this commit, so its newest date is the commit's.
      const commitDate = mostRecentDateInGroup(group);

      // Synthetic URI so file decorations / icons don't attach
      // to the header. The owning repo comes from the group's groupRepoScope.
      const commitUri = vscode.Uri.parse(`freshfiles://commit/${commitHash}`);

      const commitItem = FreshFileItem.forDirectory(
        commitUri,
        openChangesMode,
        fileCount,
        GroupingViewBuilder.groupsExpandByDefault(),
      );

      // The header carries hash / author / time / message for the whole group;
      // the file rows below intentionally omit them (see buildCommitHashFiles)
      // since every file in a commit shares the same values — repeating is noise.
      const header = formatCommitGroupHeader(
        {
          hash: commitHash,
          fileCount,
          author: firstFile.metadata.author,
          date: commitDate,
          aiCoAuthored: firstFile.metadata.aiCoAuthored,
          message: firstFile.metadata.commitMessage,
        },
        ConfigService.getDescriptionFormat(),
      );
      commitItem.label = header.label;
      commitItem.description = header.description;
      
      // Calculate total line changes for this commit
      const totals = calculateTotalLineChanges(group);

      deferCommitTooltip(commitItem, {
        hash: commitHash,
        author: firstFile.metadata.author,
        date: commitDate,
        fileCount,
        lineChanges: formatTooltipLineChanges(totals?.added, totals?.deleted) || undefined,
        aiCoAuthored: firstFile.metadata.aiCoAuthored,
        aiTools: firstFile.metadata.aiTools,
        message: firstFile.metadata.commitMessage,
      });

      commitItem.iconPath = new vscode.ThemeIcon("git-commit");
      commitItem.contextValue = TreeItemContextValues.COMMIT_HASH_GROUP;

      results.push(commitItem);
    }

    return results;
  }

  /**
   * Build files for a specific commit hash
   */
  static buildCommitHashFiles(
    commitHash: string,
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
  ): FreshFileItem[] {
    // Every file in a commit shares the same hash / author / date / message —
    // the commit header already shows them, so the rows carry only name + status.
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.commitHash === commitHash,
      sortOrder,
      openChangesMode,
      { showCommitHash: false, showAuthor: false, showDate: false, showCommitMessage: false },
    );
  }

  /**
   * Build view grouped by moon phase
   */
  static buildMoonPhaseGroupedView(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
  ): FreshFilesTreeItem[] {
    const phaseGroups = GroupingViewBuilder.groupFilesBy(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.date ? getMoonPhase(metadata.date).name : undefined,
    );

    for (const phaseName of MOON_PHASE_ORDER) {
      const group = phaseGroups.get(phaseName);
      if (!group || group.length === 0) {
        continue;
      }

      const fileCount = group.length;
      // Only dated files land in a phase group, so this is one of its dates.
      const mostRecentDate = mostRecentDateInGroup(group);
      const moonPhaseInfo = getMoonPhase(mostRecentDate);

      const phaseUri = vscode.Uri.parse(`freshfiles://moonphase/${encodeURIComponent(phaseName)}`);

      const phaseItem = FreshFileItem.forDirectory(
        phaseUri,
        openChangesMode,
        fileCount,
        GroupingViewBuilder.groupsExpandByDefault(),
      );

      phaseItem.label = `${moonPhaseInfo.emoji} ${phaseName}`;

      // Calculate total line changes for this moon phase
      const totals = calculateTotalLineChanges(group);
      phaseItem.description = formatGroupDescription(fileCount, totals?.added, totals?.deleted);

      const tooltipLines = [
        `Moon Phase: ${phaseName}`,
        `Files: ${fileCount}`,
        `Most recent: ${formatRelativeDate(mostRecentDate)}`,
      ];
      
      const lineChangesLine = formatTooltipLineChanges(totals?.added, totals?.deleted);
      if (lineChangesLine) {
        tooltipLines.push(lineChangesLine);
      }
      
      phaseItem.tooltip = tooltipLines.join("\n");

      phaseItem.iconPath = new vscode.ThemeIcon("circle-filled");
      phaseItem.contextValue = TreeItemContextValues.MOON_PHASE_GROUP;

      results.push(phaseItem);
    }

    return results;
  }

  /**
   * Build files for a specific moon phase
   */
  static buildMoonPhaseFiles(
    moonPhaseName: MoonPhase,
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
  ): FreshFileItem[] {
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.date !== undefined && getMoonPhase(metadata.date).name === moonPhaseName,
      sortOrder,
      openChangesMode,
    );
  }

  /**
   * Sort files according to the specified sort order
   * Used by all grouping modes
   */
  static sortFilesList(
    filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }>,
    sortOrder: SortOrder,
  ): void {
    switch (sortOrder) {
      case "date":
        // Sort by date (most recent first)
        filesList.sort((a, b) => {
          // Undated (pending deletions) sort last.
          const da = a.metadata.date?.getTime() ?? -Infinity;
          const db = b.metadata.date?.getTime() ?? -Infinity;
          return (da === db ? 0 : db > da ? 1 : -1)
            || path.basename(a.filePath).localeCompare(path.basename(b.filePath));
        });
        break;
      case "author":
        // Sort by author alphabetically
        filesList.sort((a, b) => {
          const authorA = a.metadata.author || "";
          const authorB = b.metadata.author || "";
          const authorCompare = authorA.localeCompare(authorB);
          if (authorCompare !== 0) {
            return authorCompare;
          }
          // Tiebreaker: filename
          return path.basename(a.filePath).localeCompare(path.basename(b.filePath));
        });
        break;
      case "name":
      default:
        // Sort alphabetically by filename
        filesList.sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)));
        break;
    }
  }

  /**
   * Dispatch to the appropriate grouped view builder for the given grouping mode.
   * Returns undefined when mode is "File Structure" (caller handles that case).
   */
  static buildForGroupingMode(
    mode: Exclude<GroupingMode, "File Structure" | "Flat List">,
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
    /** Normalized repo path these groups are nested under */
    repoScope?: string,
  ): FreshFilesTreeItem[] {
    // Every non-File-Structure mode buckets uncommitted files into one shared
    // "(Pending)" group at the top — they have no author/commit/phase to group by.
    GroupingViewBuilder.appendPendingGroup(freshFiles, filterPredicate, openChangesMode, results);
    switch (mode) {
      case "Author":      GroupingViewBuilder.buildAuthorGroupedView(freshFiles, filterPredicate, sortOrder, openChangesMode, results); break;
      case "Commit Hash":  GroupingViewBuilder.buildCommitHashGroupedView(freshFiles, filterPredicate, openChangesMode, results); break;
      case "Moon Phase":   GroupingViewBuilder.buildMoonPhaseGroupedView(freshFiles, filterPredicate, openChangesMode, results); break;
    }

    // Scope every group header to its repo: a stable repo-unique id 
    // and the repoScope the provider reads to fetch the
    // right repo's children / route the right "open commit"/"open pending" action.
    if (repoScope) {
      for (const item of results) {
        if (item instanceof FreshFileItem) {
          item.groupRepoScope = repoScope;
          item.id = `${repoScope}::${item.id}`;
        }
      }
    }
    return results;
  }

  /**
   * Prepend the shared "(Pending)" group header when there are uncommitted files.
   */
  private static appendPendingGroup(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
  ): void {
    let count = 0;
    for (const [, metadata] of freshFiles) {
      if (metadata.isPending && filterPredicate(metadata)) { count++; }
    }
    if (count === 0) { return; }

    const pendingUri = vscode.Uri.from({ scheme: "freshfiles", authority: "pending", path: "/" });
    const item = FreshFileItem.forDirectory(pendingUri, openChangesMode, count, GroupingViewBuilder.groupsExpandByDefault());
    item.label = "(Pending)"; // matches Branch Compare's pending bucket label
    item.description = plural(count, "file");
    item.tooltip = `Uncommitted changes\n${plural(count, "file")}`;
    item.iconPath = new vscode.ThemeIcon("edit");
    item.contextValue = TreeItemContextValues.PENDING_GROUP;
    results.push(item);
  }

  /** Build the file rows under the "(Pending)" group — every uncommitted file. */
  static buildPendingFiles(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
  ): FreshFileItem[] {
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.isPending === true,
      sortOrder,
      openChangesMode,
      // Pending rows carry no commit metadata; show status, hide the rest.
      { showCommitHash: false, showAuthor: false, showCommitMessage: false },
    );
  }
}
