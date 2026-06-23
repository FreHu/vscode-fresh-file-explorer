import * as vscode from "vscode";
import * as path from "path";
import { AbsolutePath } from "../pathTypes";
import { DescriptionFormat, FileMetadata, SortOrder } from "../types";
import { ConfigService } from "../config/configService";
import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatRelativeDate, formatGroupDescription, formatTooltipLineChanges } from "../utils/formatUtils";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";
import { getMoonPhase, type MoonPhase } from "../fresh-files/moonPhase";
import { getRetrogradeInfo, getRetrogradeKey, type Planet } from "../fresh-files/planetaryRetrograde";
import { type GroupingMode } from "../fresh-files/groupingMode";

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

/**
 * Builds tree views for different grouping modes.
 * Handles author, commit hash, moon phase, and retrograde grouping.
 */
export class GroupingViewBuilder {
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
    const authorGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) {
        continue;
      }

      // Get author name - use "Unknown" for files without author (pending changes)
      const authorName = metadata.author || "(No author)";

      if (!authorGroups.has(authorName)) {
        authorGroups.set(authorName, []);
      }

      authorGroups.get(authorName)!.push({ files: [filePath], metadata });
    }

    const sortedAuthors = sortOrder === "date"
      ? Array.from(authorGroups.entries())
          .sort((a, b) => {
            const maxA = a[1].reduce((m, i) => (i.metadata.date > m ? i.metadata.date : m), new Date(0));
            const maxB = b[1].reduce((m, i) => (i.metadata.date > m ? i.metadata.date : m), new Date(0));
            return maxB.getTime() - maxA.getTime();
          })
          .map(([name]) => name)
      : Array.from(authorGroups.keys()).sort((a, b) => a.localeCompare(b));

    for (const authorName of sortedAuthors) {
      const group = authorGroups.get(authorName)!;
      const fileCount = group.length;

      const authorUri = vscode.Uri.parse(`freshfiles://author/${encodeURIComponent(authorName)}`);
      
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      // Calculate total line changes for this author
      const totals = calculateTotalLineChanges(group);

      const authorItem = FreshFileItem.forDirectory(
        authorUri,
        openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
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
    const commitGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) {
        continue;
      }

      // Skip pending files (no commit hash)
      if (metadata.isPending || !metadata.commitHash) {
        continue;
      }

      const commitHash = metadata.commitHash;

      if (!commitGroups.has(commitHash)) {
        commitGroups.set(commitHash, []);
      }

      commitGroups.get(commitHash)!.push({ files: [filePath], metadata });
    }

    const sortedCommits = Array.from(commitGroups.entries()).sort((a, b) => {
      const dateA = a[1].reduce((max, item) => (item.metadata.date > max ? item.metadata.date : max), new Date(0));
      const dateB = b[1].reduce((max, item) => (item.metadata.date > max ? item.metadata.date : max), new Date(0));
      return dateB.getTime() - dateA.getTime();
    });

    for (const [commitHash, group] of sortedCommits) {
      const fileCount = group.length;
      const firstFile = group[0];

      const commitUri = vscode.Uri.parse(`freshfiles://commit/${commitHash}`);

      const commitItem = FreshFileItem.forDirectory(
        commitUri,
        openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      commitItem.label = commitHash;
      
      const commitMessageTruncated = firstFile.metadata.commitMessage
        ? firstFile.metadata.commitMessage.length > 40
          ? firstFile.metadata.commitMessage.substring(0, 40) + "..."
          : firstFile.metadata.commitMessage
        : "";

      const descriptionParts = [`${fileCount} file${fileCount === 1 ? "" : "s"}`];
      if (firstFile.metadata.author) {
        descriptionParts.push(firstFile.metadata.author);
      }
      if (commitMessageTruncated) {
        descriptionParts.push(commitMessageTruncated);
      }
      commitItem.description = descriptionParts.join(" • ");
      
      // Calculate total line changes for this commit
      const totals = calculateTotalLineChanges(group);
      
      const tooltipLines = [
        `Commit: ${commitHash}`,
        `Author: ${firstFile.metadata.author || "(No author)"}`,
        `Date: ${formatRelativeDate(firstFile.metadata.date)}`,
        `Files: ${fileCount}`,
      ];
      
      const lineChangesLine = formatTooltipLineChanges(totals?.added, totals?.deleted);
      if (lineChangesLine) {
        tooltipLines.push(lineChangesLine);
      }
      
      if (firstFile.metadata.commitMessage) {
        tooltipLines.push(`\nMessage:\n${firstFile.metadata.commitMessage}`);
      }
      commitItem.tooltip = tooltipLines.join("\n");

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
    // Hide the commit hash in the description — every file here shares it.
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => metadata.commitHash === commitHash,
      sortOrder,
      openChangesMode,
      { showCommitHash: false },
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
    const phaseGroups = new Map<MoonPhase, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) {
        continue;
      }

      // Get moon phase for this file's date
      const moonPhaseInfo = getMoonPhase(metadata.date);
      const phaseName = moonPhaseInfo.name;

      if (!phaseGroups.has(phaseName)) {
        phaseGroups.set(phaseName, []);
      }

      phaseGroups.get(phaseName)!.push({ files: [filePath], metadata });
    }

    // Define phase order (new moon to waning crescent)
    const phaseOrder: MoonPhase[] = [
      "New Moon",
      "Waxing Crescent",
      "First Quarter",
      "Waxing Gibbous",
      "Full Moon",
      "Waning Gibbous",
      "Last Quarter",
      "Waning Crescent",
    ];

    // Create tree items for each phase that has files
    for (const phaseName of phaseOrder) {
      const group = phaseGroups.get(phaseName);
      if (!group || group.length === 0) {
        continue;
      }

      const fileCount = group.length;
      const moonPhaseInfo = getMoonPhase(group[0].metadata.date);

      const phaseUri = vscode.Uri.parse(`freshfiles://moonphase/${encodeURIComponent(phaseName)}`);
      
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      const phaseItem = FreshFileItem.forDirectory(
        phaseUri,
        openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
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
      (metadata) => getMoonPhase(metadata.date).name === moonPhaseName,
      sortOrder,
      openChangesMode,
    );
  }

  /**
   * Build view grouped by planetary retrograde
   */
  static buildRetrogradeGroupedView(
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    openChangesMode: boolean,
    results: FreshFilesTreeItem[],
  ): FreshFilesTreeItem[] {
    const retrogradeGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata; planets: Planet[] }[]>();

    for (const [filePath, metadata] of freshFiles) {
      if (!filterPredicate(metadata)) {
        continue;
      }

      // Get retrograde info for this file's date
      const retrogradeInfo = getRetrogradeInfo(metadata.date);
      const key = getRetrogradeKey(retrogradeInfo.planets);

      if (!retrogradeGroups.has(key)) {
        retrogradeGroups.set(key, []);
      }

      retrogradeGroups.get(key)!.push({ files: [filePath], metadata, planets: retrogradeInfo.planets });
    }

    // Sort groups: "none" first, then by number of planets (more = more chaotic), then alphabetically
    const sortedGroups = Array.from(retrogradeGroups.entries()).sort((a, b) => {
      const keyA = a[0];
      const keyB = b[0];

      // "none" should be first
      if (keyA === "none") {
        return -1;
      }
      if (keyB === "none") {
        return 1;
      }

      // Sort by number of planets (descending - most chaotic first)
      const planetsA = a[1][0].planets.length;
      const planetsB = b[1][0].planets.length;
      if (planetsA !== planetsB) {
        return planetsB - planetsA;
      }

      // Then alphabetically
      return keyA.localeCompare(keyB);
    });

    // Create tree items for each retrograde combination
    for (const [key, group] of sortedGroups) {
      const fileCount = group.length;
      const retrogradeInfo = getRetrogradeInfo(group[0].metadata.date);

      const retrogradeUri = vscode.Uri.parse(`freshfiles://retrograde/${encodeURIComponent(key)}`);
      
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      const retrogradeItem = FreshFileItem.forDirectory(
        retrogradeUri,
        openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      retrogradeItem.label = retrogradeInfo.displayName;

      // Calculate total line changes for this retrograde group
      const totals = calculateTotalLineChanges(group);
      retrogradeItem.description = formatGroupDescription(fileCount, totals?.added, totals?.deleted);

      const tooltipLines = [
        `Retrograde: ${retrogradeInfo.displayName}`,
        `Files: ${fileCount}`,
        `Most recent: ${formatRelativeDate(mostRecentDate)}`,
      ];
      
      const lineChangesLine = formatTooltipLineChanges(totals?.added, totals?.deleted);
      if (lineChangesLine) {
        tooltipLines.push(lineChangesLine);
      }
      
      retrogradeItem.tooltip = tooltipLines.join("\n");

      retrogradeItem.iconPath = new vscode.ThemeIcon(key === "none" ? "check" : "globe");
      retrogradeItem.contextValue = TreeItemContextValues.RETROGRADE_GROUP;

      results.push(retrogradeItem);
    }

    return results;
  }

  /**
   * Build files for a specific retrograde combination
   */
  static buildRetrogradeFiles(
    retrogradeKey: string,
    freshFiles: Map<AbsolutePath, FileMetadata>,
    filterPredicate: (metadata: FileMetadata) => boolean,
    sortOrder: SortOrder,
    openChangesMode: boolean,
  ): FreshFileItem[] {
    return GroupingViewBuilder.buildGroupFiles(
      freshFiles,
      filterPredicate,
      (metadata) => getRetrogradeKey(getRetrogradeInfo(metadata.date).planets) === retrogradeKey,
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
        filesList.sort((a, b) => b.metadata.date.getTime() - a.metadata.date.getTime());
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
  ): FreshFilesTreeItem[] {
    switch (mode) {
      case "Author":      return GroupingViewBuilder.buildAuthorGroupedView(freshFiles, filterPredicate, sortOrder, openChangesMode, results);
      case "Commit Hash":  return GroupingViewBuilder.buildCommitHashGroupedView(freshFiles, filterPredicate, openChangesMode, results);
      case "Moon Phase":   return GroupingViewBuilder.buildMoonPhaseGroupedView(freshFiles, filterPredicate, openChangesMode, results);
      case "Retrograde":  return GroupingViewBuilder.buildRetrogradeGroupedView(freshFiles, filterPredicate, openChangesMode, results);
    }
  }
}
