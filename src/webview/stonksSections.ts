import type { StonksDataPoint } from "./messages";
import {
  renderLinePath,
  renderLinePathScaled,
  renderLineArea,
  renderYAxis,
  renderYAxisFromRange,
  renderDateXAxis,
  renderBar,
  ADDED_FILL,
  DELETED_FILL,
} from "./svgChartPrimitives";
import { Band, CompareLine, PADDING, SECTION_GAP, SECTION_LABEL_OFFSET } from "./stonksLayout";
import { HeatmapOptions, renderActivityHeatmap } from "./stonksHeatmap";

/** Everything the sections draw, already sliced to the visible page. */
export interface SectionInputs {
  visibleData: StonksDataPoint[];
  /** Whole zoom range, not just the page: the heatmap counts all of it. */
  allVisible: StonksDataPoint[];
  counts: number[];
  volumes: number[];
  authorCounts: number[];
  authorConcentration: number[];
  velocity: number[];
  churn: number[];
  commitSize: number[];
  /** Other repos drawn over the file-count band; empty when not comparing. */
  compareLines: CompareLine[];
  colorForRepo: (repoPath: string) => string;
  heatmap: HeatmapOptions;
}

export interface PlotGeometry {
  plotW: number;
  n: number;
  xStep: number;
}

/** Up to 10 date labels along the top of the chart. */
export function renderXAxis(data: StonksDataPoint[], { n, xStep }: PlotGeometry): string {
  if (n < 2) { return ""; }
  const MAX_LABELS = 10;
  const step = Math.max(1, Math.floor((n - 1) / (MAX_LABELS - 1)));
  return renderDateXAxis(data.map(d => d.date), n, xStep, 14, PADDING, step);
}

/** Each band's label, the splitter above all but the first, and its chart. */
export function renderBands(bands: Band[], inputs: SectionInputs, geometry: PlotGeometry): string {
  let out = "";
  for (const band of bands) {
    out += `<text x="${PADDING.left}" y="${band.top + SECTION_LABEL_OFFSET}" fill="var(--vscode-descriptionForeground)" font-size="11" font-weight="600">${band.label}</text>`;
    if (band !== bands[0]) {
      const splitterY = band.top - SECTION_GAP / 2 - 2;
      out += `<line x1="${PADDING.left}" y1="${splitterY}" x2="${PADDING.left + geometry.plotW}" y2="${splitterY}" stroke="var(--vscode-editorWidget-border, var(--vscode-widget-border))" stroke-width="1" opacity="0.4"/>`;
    }
    out += renderSection(band, inputs, geometry);
  }
  return out;
}

function renderSection(band: Band, d: SectionInputs, { plotW, n, xStep }: PlotGeometry): string {
  const { top, height: bandH } = band;
  const line = (values: number[], color: string) => renderLinePath(values, top, bandH, plotW, n, xStep, color, PADDING);
  const axis = (values: number[], count: number, format?: (v: number) => string) =>
    renderYAxis(values, top, bandH, plotW, count, PADDING, format);
  const axisRange = (min: number, max: number, count: number, format?: (v: number) => string) =>
    renderYAxisFromRange(min, max, top, bandH, plotW, count, PADDING, format);

  switch (band.key) {
    case "fileCount": {
      if (d.compareLines.length === 0) {
        return renderLineArea(d.counts, top, bandH, plotW, n, xStep, "var(--vscode-charts-blue, #339af0)", true, PADDING)
          + axis(d.counts, 8);
      }
      // Every repo on one shared Y scale.
      let min = Math.min(...d.counts);
      let max = Math.max(...d.counts);
      for (const s of d.compareLines) {
        min = Math.min(min, ...s.values);
        max = Math.max(max, ...s.values);
      }
      let out = "";
      for (const s of d.compareLines) {
        out += renderLinePathScaled(s.values, top, bandH, plotW, n, xStep, d.colorForRepo(s.repoPath), min, max, PADDING);
      }
      return out + axisRange(min, max, 8);
    }
    case "filesChanged": {
      const maxVol = Math.max(...d.volumes, 1);
      let bars = "";
      for (let i = 0; i < n; i++) {
        const netAdd = d.visibleData[i].filesAdded - d.visibleData[i].filesDeleted;
        bars += renderBar(i, xStep, PADDING, top + bandH, (d.volumes[i] / maxVol) * bandH, netAdd >= 0 ? ADDED_FILL : DELETED_FILL);
      }
      return bars + axisRange(0, maxVol, 3);
    }
    case "authors":
      return line(d.authorCounts, "var(--vscode-charts-orange, #ffa94d)") + axis(d.authorCounts, 3);
    case "authorConcentration":
      return line(d.authorConcentration, "var(--vscode-charts-purple, #b197fc)")
        + axisRange(0, Math.max(...d.authorConcentration, 1), 3, v => `${v.toFixed(0)}%`);
    case "velocity":
      return line(d.velocity, "var(--vscode-charts-green, #51cf66)") + axis(d.velocity, 3);
    case "churn":
      return line(d.churn, "var(--vscode-charts-red, #ff6b6b)")
        + axisRange(0, Math.max(...d.churn, 0.1), 3, v => `${v.toFixed(1)}%`);
    case "commitSize":
      return line(d.commitSize, "var(--vscode-charts-yellow, #ffd43b)") + axis(d.commitSize, 3, v => v.toFixed(1));
    case "activityHeatmap":
      return renderActivityHeatmap(d.allVisible, top, bandH, plotW, PADDING, d.heatmap);
  }
}
