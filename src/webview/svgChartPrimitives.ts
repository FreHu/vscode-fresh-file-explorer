/**
 * Shared SVG chart rendering primitives.
 * Pure functions — no DOM access, no side effects.
 * Used by both stonksPanel and gitLogLPanel webviews.
 */

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

/**
 * Render stacked bars: green (added) grows up from baseline,
 * red (removed) also grows up stacked behind it (total height = added + removed).
 */
export function renderAddedRemovedBars(
  data: AddedRemovedPoint[], top: number, bandH: number,
  _plotW: number, n: number, xStep: number, pad: ChartPadding,
): string {
  const maxTotal = Math.max(...data.map(d => d.added + d.removed), 1);
  const barWidth = Math.max(1, Math.min(xStep * 0.6, 12));
  let bars = "";
  for (let i = 0; i < n; i++) {
    const x = pad.left + i * xStep - barWidth / 2;
    const total = data[i].added + data[i].removed;
    // Total bar (removed = red behind)
    const totalH = (total / maxTotal) * bandH;
    const totalY = top + bandH - totalH;
    if (data[i].removed > 0) {
      bars += `<rect x="${x}" y="${totalY}" width="${barWidth}" height="${totalH}" fill="var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)" opacity="0.7"/>`;
    }
    // Added bar (green in front, stacked from bottom)
    const addedH = (data[i].added / maxTotal) * bandH;
    if (data[i].added > 0) {
      const addedY = top + bandH - addedH;
      bars += `<rect x="${x}" y="${addedY}" width="${barWidth}" height="${addedH}" fill="var(--vscode-gitDecoration-addedResourceForeground, #73c991)" opacity="0.7"/>`;
    }
  }
  return bars;
}

// ── X-axis labels ─────────────────────────────────────────────────────────────

export function renderDateXAxis(
  dates: string[], n: number, xStep: number, svgHeight: number,
  pad: ChartPadding, maxLabels = 8,
): string {
  const step = Math.max(1, Math.floor(n / maxLabels));
  const indices: number[] = [];
  for (let i = 0; i < n; i += step) { indices.push(i); }
  const lastIdx = indices[indices.length - 1];
  if (lastIdx !== n - 1 && (n - 1) - lastIdx > step * 0.5) {
    indices.push(n - 1);
  }
  let out = "";
  for (const i of indices) {
    const x = pad.left + i * xStep;
    const date = new Date(dates[i]);
    const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    out += `<text x="${x}" y="${svgHeight - 4}" text-anchor="${anchor}" fill="var(--vscode-descriptionForeground)" font-size="10">${label}</text>`;
  }
  return out;
}
