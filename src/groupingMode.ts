/**
 * Grouping modes for organizing files in the tree view
 */
export type GroupingMode = "fileStructure" | "author";

export interface GroupingModeOption {
  mode: GroupingMode;
  label: string;
  description: string;
  icon: string;
}

export const GROUPING_MODE_OPTIONS: GroupingModeOption[] = [
  {
    mode: "fileStructure",
    label: "File Structure",
    description: "Group by directory hierarchy",
    icon: "$(folder-opened)",
  },
  {
    mode: "author",
    label: "Author",
    description: "Group by commit author",
    icon: "$(person)",
  },
];

export const DEFAULT_GROUPING_MODE: GroupingMode = "fileStructure";
