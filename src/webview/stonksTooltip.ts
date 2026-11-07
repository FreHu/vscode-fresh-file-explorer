import type { StonksDataPoint, XAxisMode } from "./messages";
import { formatTooltipDate, renderCommitTooltipHeader } from "./svgChartPrimitives";
import type { CompareLine, SectionKey } from "./stonksLayout";
import { html } from "../utils/templateHelpers";
import { plural } from "../utils/plural";

/** What the last render drew, sliced to the visible page; the mouse handlers read it. */
export interface RenderedFrame {
  visibleData: StonksDataPoint[];
  /** Whole zoom range, for the heatmap's copy-hashes click. */
  allVisible: StonksDataPoint[];
  authorCounts: number[];
  authorConcentration: number[];
  velocity: number[];
  churn: number[];
  commitSize: number[];
  compareLines: CompareLine[];
}

export const EMPTY_FRAME: RenderedFrame = {
  visibleData: [], allVisible: [], authorCounts: [], authorConcentration: [],
  velocity: [], churn: [], commitSize: [], compareLines: [],
};

export interface TooltipSettings {
  mode: XAxisMode;
  sections: Record<SectionKey, boolean>;
  authorWindow: number;
  topX: number;
  colorForRepo: (repoPath: string) => string;
}

/** Hover tooltip for point `idx`: the commit (or bucket) header, then one line per enabled section. */
export function renderStonksTooltip(frame: RenderedFrame, idx: number, s: TooltipSettings): string {
  const d = frame.visibleData[idx];
  const dateStr = formatTooltipDate(d.date);
  const perCommit = s.mode === "commit";

  let out = perCommit
    ? renderCommitTooltipHeader(d.hash!, d.message!, d.author!, dateStr)
    : `<div class="author">${dateStr} · ${plural(d.commitCount, "commit")}</div>`;
  out += `<div class="stat">`;
  if (s.sections.fileCount) {
    out += `Files in repo: ${d.cumulativeFileCount}<br>`;
    for (const line of frame.compareLines) {
      out += html`<span style="color:${s.colorForRepo(line.repoPath)}">● ${line.repoName}: ${line.values[idx]}</span><br>`;
    }
  }
  if (s.sections.filesChanged) {
    out += `Changed: ${d.filesChanged} (<span class="added">+${d.filesAdded}</span> <span class="deleted">-${d.filesDeleted}</span>)<br>`;
  }
  if (s.sections.authors && perCommit) { out += `Authors (${s.authorWindow}): ${frame.authorCounts[idx]}<br>`; }
  if (s.sections.authorConcentration && perCommit) { out += `Top-${s.topX}: ${frame.authorConcentration[idx].toFixed(0)}%<br>`; }
  if (s.sections.velocity) { out += `Commits/${perCommit ? "day" : s.mode}: ${frame.velocity[idx]}<br>`; }
  if (s.sections.churn) { out += `Churn: ${frame.churn[idx].toFixed(1)}%<br>`; }
  if (s.sections.commitSize) { out += `Avg size: ${frame.commitSize[idx].toFixed(1)} files<br>`; }
  return out + `</div>`;
}
