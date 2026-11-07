import type { StonksDataPoint, StonksRepoSeries, XAxisMode } from "./messages";
import { aggregateStonksData, bucketKey } from "./stonksBucketing";

export const PADDING = { top: 36, right: 48, bottom: 32, left: 48 };
/** Gap between sections, label space included. */
export const SECTION_GAP = 28;
/** Y offset of a section's label above its band. */
export const SECTION_LABEL_OFFSET = -6;
const MIN_BAND_HEIGHT = 60;

export type SectionKey =
  | "fileCount" | "filesChanged" | "authors" | "authorConcentration"
  | "velocity" | "churn" | "commitSize" | "activityHeatmap";

/** Share of the height each section gets, relative to the others shown. */
const SECTION_WEIGHTS: Record<SectionKey, number> = {
  fileCount: 3,
  filesChanged: 1.5,
  authors: 1.5,
  authorConcentration: 1.5,
  velocity: 1.5,
  churn: 1.5,
  commitSize: 1.5,
  activityHeatmap: 3,
};

export interface Band {
  key: SectionKey;
  label: string;
  top: number;
  height: number;
}

export interface BandLabelOptions {
  authorWindow: number;
  topX: number;
  commitSizeWindow: number;
}

/**
 * Vertical layout of the enabled sections, top to bottom. Author and heatmap
 * sections exist only per commit. Bands share the height by weight but never
 * drop below a minimum, so the chart grows taller instead.
 */
export function computeBands(
  availableHeight: number,
  enabled: Record<SectionKey, boolean>,
  mode: XAxisMode,
  labels: BandLabelOptions,
): Band[] {
  const modeLabel: Record<XAxisMode, string> = { commit: "day", day: "day", week: "week", month: "month" };
  const perCommit = mode === "commit";
  const defs: { key: SectionKey; label: string }[] = [
    { key: "fileCount", label: "Files in repo" },
    { key: "filesChanged", label: "Files changed" },
    ...(perCommit ? [{ key: "authors" as const, label: `Unique authors (rolling ${labels.authorWindow} commits)` }] : []),
    ...(perCommit ? [{ key: "authorConcentration" as const, label: `Author concentration (top ${labels.topX})` }] : []),
    { key: "velocity", label: `Commits per ${modeLabel[mode]}` },
    { key: "churn", label: "Churn rate (changed / repo size)" },
    { key: "commitSize", label: perCommit ? `Avg commit size (rolling ${labels.commitSizeWindow})` : `Avg commit size (files/${modeLabel[mode]})` },
    ...(perCommit ? [{ key: "activityHeatmap" as const, label: "Activity heatmap (day × hour, committer-local time)" }] : []),
  ];

  const visible = defs.filter(d => enabled[d.key]);
  if (visible.length === 0) { return []; }

  const totalWeight = visible.reduce((s, d) => s + SECTION_WEIGHTS[d.key], 0);
  const gapSpace = (visible.length - 1) * SECTION_GAP;
  const usable = Math.max(visible.length * MIN_BAND_HEIGHT, availableHeight - PADDING.top - PADDING.bottom - gapSpace);

  const bands: Band[] = [];
  let y = PADDING.top;
  for (const def of visible) {
    const h = Math.max(MIN_BAND_HEIGHT, Math.round((SECTION_WEIGHTS[def.key] / totalWeight) * usable));
    bands.push({ key: def.key, label: def.label, top: y, height: h });
    y += h + SECTION_GAP;
  }
  return bands;
}

export interface CompareLine {
  repoName: string;
  repoPath: string;
  values: number[];
}

/**
 * Each compare repo's file count at the visible buckets. A bucket where a repo
 * has no data carries its last known value forward (0 before its first).
 */
export function alignCompareSeries(visibleData: StonksDataPoint[], series: StonksRepoSeries[], mode: XAxisMode): CompareLine[] {
  const visibleKeys = visibleData.map(d => bucketKey(d.date, mode));
  return series.map(s => {
    const lookup = new Map<string, number>();
    for (const d of aggregateStonksData(s.data, mode)) { lookup.set(bucketKey(d.date, mode), d.cumulativeFileCount); }
    const values: number[] = [];
    let lastVal = 0;
    for (const key of visibleKeys) {
      if (lookup.has(key)) { lastVal = lookup.get(key)!; }
      values.push(lastVal);
    }
    return { repoName: s.repoName, repoPath: s.repoPath, values };
  });
}
