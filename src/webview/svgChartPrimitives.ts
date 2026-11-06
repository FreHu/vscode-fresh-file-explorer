/**
 * Shared SVG chart rendering primitives.
 * Pure functions — no DOM access, no side effects.
 * Used by both stonksPanel and gitLogLPanel webviews.
 */

import { html } from "../utils/templateHelpers";

export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ── Y-axis helpers ────────────────────────────────────────────────────────────

export function buildYLabels(min: number, max: number, count: number): number[] {
  if (min === max) { return [min]; }
  const step = niceStep((max - min) / count);
  const start = Math.ceil(min / step) * step;
  const labels: number[] = [];
  for (let v = start; v <= max; v += step) {
    labels.push(Math.round(v));
  }
  return [...new Set(labels)];
}

export function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const frac = raw / Math.pow(10, exp);
  let nice: number;
  if (frac <= 1.5) { nice = 1; }
  else if (frac <= 3) { nice = 2; }
  else if (frac <= 7) { nice = 5; }
  else { nice = 10; }
  return nice * Math.pow(10, exp);
}

export function renderYAxisFromRange(
  min: number, max: number, top: number, bandH: number, plotW: number,
  count: number, pad: ChartPadding, format?: (v: number) => string,
): string {
  const range = max - min || 1;
  const labels = buildYLabels(min, max, count);
  const fmt = format ?? ((v: number) => String(v));
  let out = "";
  for (const val of labels) {
    const y = top + bandH - ((val - min) / range) * bandH;
    out += `<text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">${fmt(val)}</text>`;
    out += `<text x="${pad.left + plotW + 10}" y="${y + 4}" text-anchor="start" fill="var(--vscode-descriptionForeground)" font-size="10">${fmt(val)}</text>`;
    out += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="var(--vscode-editorWidget-border, var(--vscode-widget-border))" stroke-dasharray="2,4" opacity="0.3"/>`;
  }
  return out;
}

export function renderYAxis(
  values: number[], top: number, bandH: number, plotW: number,
  count: number, pad: ChartPadding, format?: (v: number) => string,
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return renderYAxisFromRange(min, max, top, bandH, plotW, count, pad, format);
}

// ── Line / area paths ─────────────────────────────────────────────────────────

export function renderLinePathScaled(
  values: number[], top: number, bandH: number, _plotW: number,
  n: number, xStep: number, color: string, min: number, max: number,
  pad: ChartPadding,
): string {
  const range = max - min || 1;
  let path = "";
  for (let i = 0; i < n; i++) {
    const x = pad.left + i * xStep;
    const y = top + bandH - ((values[i] - min) / range) * bandH;
    path += (i === 0 ? "M" : "L") + `${x},${y}`;
  }
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}

export function renderLinePath(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string, pad: ChartPadding,
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return renderLinePathScaled(values, top, bandH, plotW, n, xStep, color, min, max, pad);
}

export function renderLineArea(
  values: number[], top: number, bandH: number, _plotW: number,
  n: number, xStep: number, color: string, useGradient: boolean,
  pad: ChartPadding,
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  let linePath = "";
  let areaPath = "";
  for (let i = 0; i < n; i++) {
    const x = pad.left + i * xStep;
    const y = top + bandH - ((values[i] - min) / range) * bandH;
    linePath += (i === 0 ? "M" : "L") + `${x},${y}`;
    areaPath += (i === 0 ? "M" : "L") + `${x},${y}`;
  }
  areaPath += `L${pad.left + (n - 1) * xStep},${top + bandH}`;
  areaPath += `L${pad.left},${top + bandH}Z`;
  const fill = useGradient ? "url(#areaGrad)" : "none";
  return `<path d="${areaPath}" fill="${fill}"/><path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}

// ── Stacked added/removed bar chart ──────────────────────────────────────────

export interface AddedRemovedPoint {
  added: number;
  removed: number;
}

export const ADDED_FILL = "var(--vscode-gitDecoration-addedResourceForeground, #73c991)";
export const DELETED_FILL = "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)";

/** One translucent bar centred on point `i`, standing on `baseY`; 60% of the point spacing wide, 1–12px. */
export function renderBar(
  i: number, xStep: number, pad: ChartPadding, baseY: number, height: number, fill: string,
): string {
  const width = Math.max(1, Math.min(xStep * 0.6, 12));
  const x = pad.left + i * xStep - width / 2;
  return `<rect x="${x}" y="${baseY - height}" width="${width}" height="${height}" fill="${fill}" opacity="0.7"/>`;
}

/**
 * Render stacked bars: green (added) grows up from baseline,
 * red (removed) also grows up stacked behind it (total height = added + removed).
 */
export function renderAddedRemovedBars(
  data: AddedRemovedPoint[], top: number, bandH: number,
  _plotW: number, n: number, xStep: number, pad: ChartPadding,
): string {
  const maxTotal = Math.max(...data.map(d => d.added + d.removed), 1);
  let bars = "";
  for (let i = 0; i < n; i++) {
    const total = data[i].added + data[i].removed;
    // Total bar (removed = red behind)
    if (data[i].removed > 0) {
      bars += renderBar(i, xStep, pad, top + bandH, (total / maxTotal) * bandH, DELETED_FILL);
    }
    // Added bar (green in front, stacked from bottom)
    if (data[i].added > 0) {
      bars += renderBar(i, xStep, pad, top + bandH, (data[i].added / maxTotal) * bandH, ADDED_FILL);
    }
  }
  return bars;
}

// ── X-axis labels ─────────────────────────────────────────────────────────────

/**
 * Which of `n` points get an x-axis label: every `step`th from the first,
 * plus the last when it is more than half a step past the previous label.
 */
export function xAxisLabelIndices(n: number, step: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < n; i += step) { indices.push(i); }
  const lastIdx = indices[indices.length - 1];
  if (lastIdx !== n - 1 && (n - 1) - lastIdx > step * 0.5) {
    indices.push(n - 1);
  }
  return indices;
}

/**
 * Short date labels at height `labelY` for the points {@link xAxisLabelIndices}
 * picks; the first label is anchored at its start, the last at its end.
 */
export function renderDateXAxis(
  dates: string[], n: number, xStep: number, labelY: number,
  pad: ChartPadding, step: number,
): string {
  let out = "";
  for (const i of xAxisLabelIndices(n, step)) {
    const x = pad.left + i * xStep;
    const date = new Date(dates[i]);
    const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    out += `<text x="${x}" y="${labelY}" text-anchor="${anchor}" fill="var(--vscode-descriptionForeground)" font-size="10">${label}</text>`;
  }
  return out;
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────

/** Date as shown in chart tooltips, e.g. "Mar 5, 2026". */
export function formatTooltipDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The hash, message and "author · date" lines that open a commit's tooltip. */
export function renderCommitTooltipHeader(hash: string, message: string, author: string, dateStr: string): string {
  return html`<div class="hash">${hash}</div>` +
    html`<div class="message">${message}</div>` +
    html`<div class="author">${author} · ${dateStr}</div>`;
}
