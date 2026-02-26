/**
 * Grouping modes for organizing files in the tree view
 */
export type GroupingMode = "fileStructure" | "author" | "commitHash" | "moonPhase" | "retrograde";

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
    description: `Also known as "no grouping"`,
    icon: "$(folder-opened)",
  },
  {
    mode: "author",
    label: "Author",
    description: "Group by commit author",
    icon: "$(person)",
  },
  {
    mode: "commitHash",
    label: "Commit Hash",
    description: "Group by commit",
    icon: "$(git-commit)",
  },
  {
    mode: "moonPhase",
    label: "Moon Phase",
    description: "Group by lunar phase at commit time",
    icon: "$(circle-filled)",
  },
  {
    mode: "retrograde",
    label: "Planetary Retrograde",
    description: "Group by which planets were retrograde",
    icon: "$(globe)",
  },
];

export const DEFAULT_GROUPING_MODE: GroupingMode = "fileStructure";
