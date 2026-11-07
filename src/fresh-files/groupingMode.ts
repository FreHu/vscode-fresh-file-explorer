/**
 * Grouping modes for organizing files in the tree view
 */
export type GroupingMode = "File Structure" | "Flat List" | "Author" | "Commit Hash" | "Moon Phase";

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
    // Matches the Moon Phase group headers in the trees; `color-mode` is the heatmap's icon.
    icon: "$(circle-filled)",
  },
];

export const DEFAULT_GROUPING_MODE: GroupingMode = "File Structure";

const VALID_GROUPING_MODES = new Set<string>(
  ["File Structure", "Flat List", "Author", "Commit Hash", "Moon Phase"]);

/** Map from old camelCase values (pre-rename) to the current display-name values. */
const LEGACY_GROUPING_MODE_MAP: Record<string, GroupingMode> = {
  fileStructure: "File Structure",
  flatList: "Flat List",
  author: "Author",
  commitHash: "Commit Hash",
  moonPhase: "Moon Phase",
};

/**
 * Coerce a raw persisted value to a valid GroupingMode.
 * Handles the old camelCase enum values, the retired "Retrograde" mode
 * (falls back to the default), and any unrecognized strings.
 */
export function coerceGroupingMode(raw: unknown, fallback: GroupingMode = DEFAULT_GROUPING_MODE): GroupingMode {
  return parseGroupingMode(raw) ?? fallback;
}

/** Like {@link coerceGroupingMode}, but undefined for values it can't map. */
export function parseGroupingMode(raw: unknown): GroupingMode | undefined {
  if (typeof raw !== "string") { return undefined; }
  if (VALID_GROUPING_MODES.has(raw)) { return raw as GroupingMode; }
  return Object.prototype.hasOwnProperty.call(LEGACY_GROUPING_MODE_MAP, raw) ? LEGACY_GROUPING_MODE_MAP[raw] : undefined;
}
