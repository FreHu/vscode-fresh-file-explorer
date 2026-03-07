/**
 * Grouping modes for organizing files in the tree view
 */
export type GroupingMode = "File Structure" | "Flat List" | "Author" | "Commit Hash" | "Moon Phase" | "Retrograde";

export interface GroupingModeOption {
  mode: GroupingMode;
  label: string;
  description: string;
  icon: string;
}

export const GROUPING_MODE_OPTIONS: GroupingModeOption[] = [
  {
    mode: "File Structure",
    label: "Folder Structure",
    description: `Like the File Explorer`,
    icon: "$(folder-opened)",
  },
  {
    mode: "Flat List",
    label: "Flat List",
    description: "All files in a flat sorted list, no subdirectory nodes",
    icon: "$(list-unordered)",
  },
  {
    mode: "Author",
    label: "Author",
    description: "Group by commit author",
    icon: "$(person)",
  },
  {
    mode: "Commit Hash",
    label: "Commit Hash",
    description: "Group by commit",
    icon: "$(git-commit)",
  },
  {
    mode: "Moon Phase",
    label: "Moon Phase",
    description: "Group by lunar phase at commit time",
    icon: "$(circle-filled)",
  },
  {
    mode: "Retrograde",
    label: "Planetary Retrograde",
    description: "Group by which planets were retrograde",
    icon: "$(globe)",
  },
];

export const DEFAULT_GROUPING_MODE: GroupingMode = "File Structure";

const VALID_GROUPING_MODES = new Set<string>(
  ["File Structure", "Flat List", "Author", "Commit Hash", "Moon Phase", "Retrograde"]);

/** Map from old camelCase values (pre-rename) to the current display-name values. */
const LEGACY_GROUPING_MODE_MAP: Record<string, GroupingMode> = {
  fileStructure: "File Structure",
  flatList: "Flat List",
  author: "Author",
  commitHash: "Commit Hash",
  moonPhase: "Moon Phase",
  retrograde: "Retrograde",
};

/**
 * Coerce a raw persisted value to a valid GroupingMode.
 * Handles the old camelCase enum values and any unrecognized strings.
 */
export function coerceGroupingMode(raw: unknown, fallback: GroupingMode = DEFAULT_GROUPING_MODE): GroupingMode {
  if (typeof raw === "string") {
    if (VALID_GROUPING_MODES.has(raw)) {
      return raw as GroupingMode;
    }
    const mapped = LEGACY_GROUPING_MODE_MAP[raw];
    if (mapped) {
      return mapped;
    }
  }
  return fallback;
}
