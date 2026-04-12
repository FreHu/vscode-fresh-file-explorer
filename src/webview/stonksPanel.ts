import type { StonksToWebview, StonksFromWebview, StonksDataPoint, StonksConfig } from "./messages";

const vscode = acquireVsCodeApi();

const repoSelect = document.getElementById("repoSelect") as HTMLSelectElement;
const loadingDiv = document.getElementById("loading") as HTMLElement;
const emptyDiv = document.getElementById("empty") as HTMLElement;
const chartContainer = document.getElementById("chartContainer") as HTMLElement;
const svg = document.getElementById("chart") as unknown as SVGSVGElement;
const tooltip = document.getElementById("tooltip") as HTMLElement;

let currentData: StonksDataPoint[] = [];
interface ZoomLevel { start: number; end: number }
const zoomStack: ZoomLevel[] = [];
let panOffset = Number.MAX_SAFE_INTEGER; // index into visible data; MAX = scroll to end
let maxVisibleTicks = 1000;

// Interaction state shared across render cycles
let chartN = 0;
let chartXStep = 0;
let dragStartIdx: number | null = null;
let isDragging = false;

// Per-render data used by mouse handlers (set in render, read by module-level listeners)
let renderVisibleData: StonksDataPoint[] = [];
let renderAuthorCounts: number[] = [];
let renderVelocity: number[] = [];
let renderChurn: number[] = [];

function getVisibleData(): StonksDataPoint[] {
  if (zoomStack.length > 0) {
    const top = zoomStack[zoomStack.length - 1];
    return currentData.slice(top.start, top.end + 1);
  }
  return currentData;
}

function visibleDataLength(): number {
  if (zoomStack.length > 0) {
    const top = zoomStack[zoomStack.length - 1];
    return top.end - top.start + 1;
  }
  return currentData.length;
}

function resetZoom(): void {
  zoomStack.length = 0;
  panOffset = Number.MAX_SAFE_INTEGER;
  updateZoomSelect();
  render();
}

function popZoom(): void {
  if (zoomStack.length > 0) {
    zoomStack.pop();
    panOffset = Number.MAX_SAFE_INTEGER;
    updateZoomSelect();
    render();
  }
}

const zoomSelect = document.getElementById("zoomSelect") as HTMLSelectElement;

function updateZoomSelect(): void {
  if (zoomStack.length === 0) {
    zoomSelect.style.display = "none";
    return;
  }
  zoomSelect.style.display = "";
  zoomSelect.innerHTML = "";
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const allOpt = document.createElement("option");
  allOpt.value = "0";
  allOpt.textContent = `All (${currentData.length} commits)`;
  zoomSelect.appendChild(allOpt);

  for (let i = 0; i < zoomStack.length; i++) {
    const level = zoomStack[i];
    const first = currentData[level.start];
    const last = currentData[level.end];
    const count = level.end - level.start + 1;
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `${fmt(first.date)} – ${fmt(last.date)} (${count})`;
    zoomSelect.appendChild(opt);
  }
  zoomSelect.value = String(zoomStack.length);
}

zoomSelect.addEventListener("change", () => {
  const level = Number(zoomSelect.value);
  if (level === 0) {
    resetZoom();
  } else {
    zoomStack.length = level;
    panOffset = Number.MAX_SAFE_INTEGER;
    updateZoomSelect();
    render();
  }
});

function postMessage(msg: StonksFromWebview): void {
  vscode.postMessage(msg);
}

function buildConfig(): StonksConfig {
  return {
    sections: { ...sections },
    maxVisibleTicks,
    selectedDays: Number(timeWindowSelect.value) || 30,
  };
}

function sendConfig(): void {
  postMessage({ command: "updateConfig", config: buildConfig() });
}

// ── Repo selector ─────────────────────────────────────────────────────────────

repoSelect.addEventListener("change", () => {
  const path = repoSelect.value;
  if (path) {
    postMessage({ command: "selectRepo", repoPath: path });
  }
});

// ── Time window selector ──────────────────────────────────────────────────────

const timeWindowSelect = document.getElementById("timeWindowSelect") as HTMLSelectElement;

timeWindowSelect.addEventListener("change", () => {
  postMessage({ command: "selectTimeWindow", days: Number(timeWindowSelect.value) });
  sendConfig();
});

// ── Max ticks input ───────────────────────────────────────────────────────────

const maxTicksInput = document.getElementById("maxTicks") as HTMLInputElement;
maxTicksInput.addEventListener("change", () => {
  const val = parseInt(maxTicksInput.value, 10);
  if (val >= 100 && val <= 10000) {
    maxVisibleTicks = val;
    sendConfig();
    render();
  }
});

// ── Message handling ──────────────────────────────────────────────────────────

window.addEventListener("message", (event) => {
  const msg = event.data as StonksToWebview;
  switch (msg.command) {
    case "setRepos": {
      repoSelect.innerHTML = "";
      for (const repo of msg.repos) {
        const opt = document.createElement("option");
        opt.value = repo.path;
        opt.textContent = repo.name;
        repoSelect.appendChild(opt);
      }
      repoSelect.disabled = msg.repos.length === 0;
      break;
    }
    case "setTimeWindows": {
      timeWindowSelect.innerHTML = "";
      for (const tw of msg.options) {
        const opt = document.createElement("option");
        opt.value = tw.days === undefined ? "pending" : String(tw.days);
        opt.textContent = tw.label;
        if (tw.days === msg.selectedDays) { opt.selected = true; }
        timeWindowSelect.appendChild(opt);
      }
      break;
    }
    case "setData":
      currentData = msg.data;
      zoomStack.length = 0;
      panOffset = Number.MAX_SAFE_INTEGER;
      updateZoomSelect();
      render();
      break;
    case "setLoading":
      loadingDiv.style.display = msg.loading ? "" : "none";
      if (msg.loading) {
        chartContainer.style.display = "none";
        emptyDiv.style.display = "none";
      }
      break;
    case "setConfig": {
      const c = msg.config;
      // Apply section toggles
      for (const [key, id] of [
        ["fileCount", "toggleFileCount"],
        ["filesChanged", "toggleFilesChanged"],
        ["authors", "toggleAuthors"],
        ["velocity", "toggleVelocity"],
        ["churn", "toggleChurn"],
      ] as const) {
        sections[key] = c.sections[key];
        const cb = document.getElementById(id) as HTMLInputElement | null;
        if (cb) { cb.checked = c.sections[key]; }
      }
      // Apply max ticks
      maxVisibleTicks = c.maxVisibleTicks;
      maxTicksInput.value = String(c.maxVisibleTicks);
      break;
    }
  }
});

// ── SVG Chart Rendering ───────────────────────────────────────────────────────

const PADDING = { top: 36, right: 60, bottom: 32, left: 60 };
const SECTION_GAP = 28; // gap between sections (includes label space)
const SECTION_LABEL_OFFSET = -6; // y offset for section label above its band

// Section visibility state (all default checked)
const sections = {
  fileCount: true,
  filesChanged: true,
  authors: true,
  velocity: true,
  churn: true,
};

// Wire up toggle checkboxes
for (const [key, id] of [
  ["fileCount", "toggleFileCount"],
  ["filesChanged", "toggleFilesChanged"],
  ["authors", "toggleAuthors"],
  ["velocity", "toggleVelocity"],
  ["churn", "toggleChurn"],
] as const) {
  const cb = document.getElementById(id) as HTMLInputElement | null;
  if (cb) {
    cb.addEventListener("change", () => {
      sections[key as keyof typeof sections] = cb.checked;
      sendConfig();
      render();
    });
  }
}

// Section weight config (relative proportions, not fixed pixels)
const SECTION_WEIGHTS: Record<string, number> = {
  fileCount: 3,
  filesChanged: 1.5,
  authors: 1.5,
  velocity: 1.5,
  churn: 1.5,
};

const MIN_BAND_HEIGHT = 60;

interface Band {
  key: string;
  label: string;
  top: number;
  height: number;
}

function computeBands(availableHeight: number): Band[] {
  const defs: { key: keyof typeof sections; label: string }[] = [
    { key: "fileCount", label: "Files in repo" },
    { key: "filesChanged", label: "Files changed" },
    { key: "authors", label: "Unique authors (rolling 10 commits)" },
    { key: "velocity", label: "Commits per day" },
    { key: "churn", label: "Churn rate (changed / repo size)" },
  ];

  const visible = defs.filter(d => sections[d.key]);
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

// ── Shared interaction helpers ─────────────────────────────────────────────────

function xToIdx(clientX: number): number {
  const svgRect = svg.getBoundingClientRect();
  const mx = clientX - svgRect.left;
  return Math.round(Math.max(0, Math.min(chartN - 1, (mx - PADDING.left) / chartXStep)));
}

// Derived series cache — recomputed only when zoom level or data changes, not on pan
let derivedCache: {
  data: StonksDataPoint[];
  zoomKey: string;
  allAuthorCounts: number[];
  allVelocity: number[];
  allChurn: number[];
} | null = null;

function zoomCacheKey(): string {
  if (zoomStack.length === 0) { return ""; }
  const t = zoomStack[zoomStack.length - 1];
  return `${zoomStack.length}:${t.start}:${t.end}`;
}

function render() {
  const allVisible = getVisibleData();
  if (allVisible.length === 0) {
    chartContainer.style.display = "none";
    emptyDiv.style.display = "";
    updatePanScrollbar(0, 0);
    return;
  }
  emptyDiv.style.display = "none";
  chartContainer.style.display = "";

  // ── Page window (limit rendered ticks, rest via horizontal pan) ──────────
  const needsPan = allVisible.length > maxVisibleTicks;
  const maxOffset = Math.max(0, allVisible.length - maxVisibleTicks);
  panOffset = Math.max(0, Math.min(panOffset, maxOffset));
  const pageStart = needsPan ? panOffset : 0;
  const pageEnd = needsPan ? pageStart + maxVisibleTicks : allVisible.length;

  // ── Derived series (cached across pan-only re-renders) ────────────────────
  const zoomKey = zoomCacheKey();
  let allAuthorCounts: number[];
  let allVelocity: number[];
  let allChurn: number[];

  if (derivedCache && derivedCache.data === currentData && derivedCache.zoomKey === zoomKey) {
    allAuthorCounts = derivedCache.allAuthorCounts;
    allVelocity = derivedCache.allVelocity;
    allChurn = derivedCache.allChurn;
  } else {
    const allN = allVisible.length;
    const AUTHOR_WINDOW = 10;
    allAuthorCounts = [];
    for (let i = 0; i < allN; i++) {
      const start = Math.max(0, i - AUTHOR_WINDOW + 1);
      const authors = new Set<string>();
      for (let j = start; j <= i; j++) { authors.add(allVisible[j].author); }
      allAuthorCounts.push(authors.size);
    }

    const dayMap = new Map<string, number>();
    for (const d of allVisible) {
      const dayKey = d.date.substring(0, 10);
      dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + 1);
    }
    allVelocity = allVisible.map(d => dayMap.get(d.date.substring(0, 10)) ?? 0);

    allChurn = allVisible.map(d =>
      d.cumulativeFileCount > 0 ? (d.filesChanged / d.cumulativeFileCount) * 100 : 0,
    );

    derivedCache = { data: currentData, zoomKey, allAuthorCounts, allVelocity, allChurn };
  }

  // ── Slice to page window ──────────────────────────────────────────────────
  const visibleData = allVisible.slice(pageStart, pageEnd);
  const counts = visibleData.map(d => d.cumulativeFileCount);
  const volumes = visibleData.map(d => d.filesChanged);
  const authorCounts = allAuthorCounts.slice(pageStart, pageEnd);
  const velocity = allVelocity.slice(pageStart, pageEnd);
  const churn = allChurn.slice(pageStart, pageEnd);

  // Available height: viewport minus header/toggles/padding above the chart container
  // Reserve space for body bottom padding (20px) and pan scrollbar (16px) so nothing overflows
  const containerTop = chartContainer.getBoundingClientRect().top;
  const scrollbarReserve = allVisible.length > maxVisibleTicks ? 16 : 0;
  const bodyPaddingBottom = 20;
  const availableH = window.innerHeight - containerTop - scrollbarReserve - bodyPaddingBottom;

  const bands = computeBands(availableH);
  if (bands.length === 0) { return; }

  const containerRect = chartContainer.getBoundingClientRect();
  const W = containerRect.width;
  if (W < 10) { return; }

  const totalH = bands[bands.length - 1].top + bands[bands.length - 1].height + PADDING.bottom;
  const plotW = W - PADDING.left - PADDING.right;

  const n = visibleData.length;
  const xStep = n > 1 ? plotW / (n - 1) : plotW / 2;
  chartN = n;
  chartXStep = xStep;

  // ── SVG construction ──────────────────────────────────────────────────────
  let svgContent = "";

  // Gradient def
  svgContent += `
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--vscode-charts-blue, #339af0)" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="var(--vscode-charts-blue, #339af0)" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
  `;

  // X-axis date labels (top of chart)
  svgContent += renderXAxis(visibleData, n, xStep);

  for (const band of bands) {
    const { key, label, top, height: bandH } = band;

    // Section label
    svgContent += `<text x="${PADDING.left}" y="${top + SECTION_LABEL_OFFSET}" fill="var(--vscode-descriptionForeground)" font-size="11" font-weight="600">${label}</text>`;

    // Splitter line above each band (except the first)
    if (band !== bands[0]) {
      const splitterY = top - SECTION_GAP / 2 - 2;
      svgContent += `<line x1="${PADDING.left}" y1="${splitterY}" x2="${PADDING.left + plotW}" y2="${splitterY}" stroke="var(--vscode-editorWidget-border, var(--vscode-widget-border))" stroke-width="1" opacity="0.4"/>`;
    }

    if (key === "fileCount") {
      svgContent += renderLineArea(counts, top, bandH, plotW, n, xStep, "var(--vscode-charts-blue, #339af0)", true);
      svgContent += renderYAxis(counts, top, bandH, plotW, 8, "left");
    } else if (key === "filesChanged") {
      svgContent += renderVolumeBars(visibleData, volumes, top, bandH, plotW, n, xStep);
      const maxVol = Math.max(...volumes, 1);
      svgContent += renderYAxisFromRange(0, maxVol, top, bandH, plotW, 3, "right");
    } else if (key === "authors") {
      svgContent += renderLinePath(authorCounts, top, bandH, plotW, n, xStep, "var(--vscode-charts-orange, #ffa94d)");
      svgContent += renderYAxis(authorCounts, top, bandH, plotW, 3, "left");
    } else if (key === "velocity") {
      svgContent += renderLinePath(velocity, top, bandH, plotW, n, xStep, "var(--vscode-charts-green, #51cf66)");
      svgContent += renderYAxis(velocity, top, bandH, plotW, 3, "left");
    } else if (key === "churn") {
      svgContent += renderLinePath(churn, top, bandH, plotW, n, xStep, "var(--vscode-charts-red, #ff6b6b)");
      // Churn as % — custom labels
      const maxChurn = Math.max(...churn, 0.1);
      const churnLabels = buildYLabels(0, maxChurn, 3);
      let churnAxis = "";
      for (const val of churnLabels) {
        const y = top + bandH - (val / maxChurn) * bandH;
        churnAxis += `<text x="${PADDING.left - 8}" y="${y + 4}" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">${val.toFixed(1)}%</text>`;
        churnAxis += `<line x1="${PADDING.left}" y1="${y}" x2="${PADDING.left + plotW}" y2="${y}" stroke="var(--vscode-editorWidget-border, var(--vscode-widget-border))" stroke-dasharray="2,4" opacity="0.3"/>`;
      }
      svgContent += churnAxis;
    }
  }

  // Commit link icons (below last band)
  const lastBand = bands[bands.length - 1];
  const commitLinksTop = lastBand.top + lastBand.height;
  const COMMIT_ICON_THRESHOLD = 150;
  let commitLinks = "";
  if (n <= COMMIT_ICON_THRESHOLD && xStep >= 8) {
    const iconY = commitLinksTop + 14;
    const iconR = Math.min(4, xStep * 0.25);
    for (let i = 0; i < n; i++) {
      const cx = PADDING.left + i * xStep;
      commitLinks += `<circle class="commit-link" data-hash="${visibleData[i].hash}" cx="${cx}" cy="${iconY}" r="${iconR}" fill="var(--vscode-textLink-foreground)" opacity="0.5" style="cursor:pointer"><title>Open commit ${visibleData[i].hash.substring(0, 7)}</title></circle>`;
    }
  }
  svgContent += commitLinks;

  // Crosshair spanning all bands
  const crosshairBottom = lastBand.top + lastBand.height;
  svgContent += `<line id="crosshair" x1="0" y1="${bands[0].top}" x2="0" y2="${crosshairBottom}" stroke="var(--vscode-foreground)" stroke-width="0.5" opacity="0.5" style="display:none"/>`;

  // Hit area spanning all bands
  const hitTop = bands[0].top;
  const hitH = crosshairBottom - hitTop;
  svgContent += `<rect id="hitArea" x="${PADDING.left}" y="${hitTop}" width="${plotW}" height="${hitH}" fill="transparent" style="cursor:crosshair"/>`;
  svgContent += `<rect id="selectOverlay" x="0" y="${hitTop}" width="0" height="${hitH}" fill="var(--vscode-editor-selectionBackground, rgba(51,154,240,0.2))" style="display:none; pointer-events:none"/>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${totalH}`);
  svg.style.height = `${totalH}px`;
  svg.innerHTML = svgContent;

  // Update module-level data for mouse handlers (registered once, outside render)
  renderVisibleData = visibleData;
  renderAuthorCounts = authorCounts;
  renderVelocity = velocity;
  renderChurn = churn;

  // ── Update pan scrollbar ────────────────────────────────────────────────────
  updatePanScrollbar(allVisible.length, pageStart);
}

// ── Pan scrollbar ─────────────────────────────────────────────────────────────

const panScrollbar = document.getElementById("panScrollbar") as HTMLElement;
const panThumb = document.getElementById("panThumb") as HTMLElement;

function updatePanScrollbar(totalVisible: number, pageStart: number): void {
  const show = totalVisible > maxVisibleTicks;
  panScrollbar.style.display = show ? "block" : "none";
  if (!show) { return; }

  const trackW = panScrollbar.clientWidth;
  if (trackW <= 0) { return; }

  const ratio = maxVisibleTicks / totalVisible;
  const thumbW = Math.max(20, Math.round(ratio * trackW));
  const maxThumbLeft = trackW - thumbW;
  const maxOff = totalVisible - maxVisibleTicks;
  const thumbLeft = maxOff > 0 ? Math.round((pageStart / maxOff) * maxThumbLeft) : 0;

  panThumb.style.width = thumbW + "px";
  panThumb.style.left = thumbLeft + "px";
}

// Thumb drag
let panDragStart: { x: number; offset: number } | null = null;

panThumb.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  panDragStart = { x: e.clientX, offset: panOffset };
});

document.addEventListener("mousemove", (e) => {
  if (!panDragStart) { return; }
  const trackW = panScrollbar.clientWidth;
  const total = visibleDataLength();
  const ratio = maxVisibleTicks / total;
  const thumbW = Math.max(20, Math.round(ratio * trackW));
  const maxThumbLeft = trackW - thumbW;
  const maxOff = total - maxVisibleTicks;
  if (maxOff <= 0 || maxThumbLeft <= 0) { return; }

  const dx = e.clientX - panDragStart.x;
  panOffset = Math.round(panDragStart.offset + (dx / maxThumbLeft) * maxOff);
  render();
});

document.addEventListener("mouseup", () => {
  panDragStart = null;
});

// Track click (jump to position)
panScrollbar.addEventListener("mousedown", (e) => {
  if (e.target === panThumb) { return; }
  const rect = panScrollbar.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const trackW = rect.width;
  const total = visibleDataLength();
  const maxOff = total - maxVisibleTicks;
  if (maxOff <= 0) { return; }

  panOffset = Math.round((clickX / trackW) * maxOff);
  render();
});

// Wheel panning (shift+wheel or trackpad horizontal swipe)
chartContainer.addEventListener("wheel", (e) => {
  if (visibleDataLength() <= maxVisibleTicks) { return; }
  const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
  if (delta === 0) { return; }
  e.preventDefault();
  const step = Math.max(1, Math.round(maxVisibleTicks * 0.05));
  panOffset += delta > 0 ? step : -step;
  render();
}, { passive: false });

// ── Section rendering helpers ─────────────────────────────────────────────────

function renderXAxis(data: StonksDataPoint[], n: number, xStep: number): string {
  if (n < 2) { return ""; }
  const MAX_LABELS = 10;
  const step = Math.max(1, Math.floor((n - 1) / (MAX_LABELS - 1)));
  const indices: number[] = [];
  for (let i = 0; i < n; i += step) { indices.push(i); }
  // Only add the last label if it's at least half a step away from the previous
  const lastIdx = indices[indices.length - 1];
  if (lastIdx !== n - 1 && (n - 1) - lastIdx > step * 0.5) {
    indices.push(n - 1);
  }
  let out = "";
  for (const i of indices) {
    const x = PADDING.left + i * xStep;
    const date = new Date(data[i].date);
    const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    // Anchor first label to start, last to end, rest centered
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    out += `<text x="${x}" y="14" text-anchor="${anchor}" fill="var(--vscode-descriptionForeground)" font-size="10">${label}</text>`;
  }
  return out;
}

function renderLinePath(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string,
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  let path = "";
  for (let i = 0; i < n; i++) {
    const x = PADDING.left + i * xStep;
    const y = top + bandH - ((values[i] - min) / range) * bandH;
    path += (i === 0 ? "M" : "L") + `${x},${y}`;
  }
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}

function renderLineArea(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string, useGradient: boolean,
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  let linePath = "";
  let areaPath = "";
  for (let i = 0; i < n; i++) {
    const x = PADDING.left + i * xStep;
    const y = top + bandH - ((values[i] - min) / range) * bandH;
    linePath += (i === 0 ? "M" : "L") + `${x},${y}`;
    areaPath += (i === 0 ? "M" : "L") + `${x},${y}`;
  }
  areaPath += `L${PADDING.left + (n - 1) * xStep},${top + bandH}`;
  areaPath += `L${PADDING.left},${top + bandH}Z`;
  const fill = useGradient ? "url(#areaGrad)" : "none";
  return `<path d="${areaPath}" fill="${fill}"/><path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}

function renderVolumeBars(
  data: StonksDataPoint[], volumes: number[], top: number, bandH: number,
  plotW: number, n: number, xStep: number,
): string {
  const maxVol = Math.max(...volumes, 1);
  const barWidth = Math.max(1, Math.min(xStep * 0.6, 12));
  let bars = "";
  for (let i = 0; i < n; i++) {
    const x = PADDING.left + i * xStep - barWidth / 2;
    const barH = (volumes[i] / maxVol) * bandH;
    const y = top + bandH - barH;
    const netAdd = data[i].filesAdded - data[i].filesDeleted;
    const fill = netAdd >= 0
      ? "var(--vscode-gitDecoration-addedResourceForeground, #73c991)"
      : "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)";
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${fill}" opacity="0.7"/>`;
  }
  return bars;
}

function renderYAxis(
  values: number[], top: number, bandH: number, plotW: number,
  count: number, side: "left" | "right",
): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return renderYAxisFromRange(min, max, top, bandH, plotW, count, side);
}

function renderYAxisFromRange(
  min: number, max: number, top: number, bandH: number, plotW: number,
  count: number, side: "left" | "right",
): string {
  const range = max - min || 1;
  const labels = buildYLabels(min, max, count);
  let out = "";
  for (const val of labels) {
    const y = top + bandH - ((val - min) / range) * bandH;
    if (side === "left") {
      out += `<text x="${PADDING.left - 8}" y="${y + 4}" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">${val}</text>`;
    } else {
      out += `<text x="${PADDING.left + plotW + 8}" y="${y + 4}" text-anchor="start" fill="var(--vscode-descriptionForeground)" font-size="10">${val}</text>`;
    }
    out += `<line x1="${PADDING.left}" y1="${y}" x2="${PADDING.left + plotW}" y2="${y}" stroke="var(--vscode-editorWidget-border, var(--vscode-widget-border))" stroke-dasharray="2,4" opacity="0.3"/>`;
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildYLabels(min: number, max: number, count: number): number[] {
  if (min === max) { return [min]; }
  const step = niceStep((max - min) / count);
  const start = Math.ceil(min / step) * step;
  const labels: number[] = [];
  for (let v = start; v <= max; v += step) {
    labels.push(Math.round(v));
  }
  // Deduplicate (can happen when step rounds to same value)
  return [...new Set(labels)];
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const frac = raw / Math.pow(10, exp);
  let nice: number;
  if (frac <= 1.5) { nice = 1; }
  else if (frac <= 3) { nice = 2; }
  else if (frac <= 7) { nice = 5; }
  else { nice = 10; }
  return nice * Math.pow(10, exp);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Resize handling ───────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  if (currentData.length > 0) { render(); }
});
ro.observe(chartContainer);

// ── SVG interaction listeners (registered once, read module-level render data) ─

// Commit link click/hover via event delegation on persistent svg element
svg.addEventListener("click", (e: Event) => {
  const target = (e.target as SVGElement).closest?.(".commit-link") as SVGElement | null;
  if (!target) { return; }
  e.stopPropagation();
  const hash = target.getAttribute("data-hash");
  if (hash) { postMessage({ command: "openCommit", hash }); }
});
svg.addEventListener("mouseenter", (e: Event) => {
  const target = (e.target as SVGElement);
  if (target.classList?.contains("commit-link")) { target.setAttribute("opacity", "1"); }
}, true);
svg.addEventListener("mouseleave", (e: Event) => {
  const target = (e.target as SVGElement);
  if (target.classList?.contains("commit-link")) { target.setAttribute("opacity", "0.5"); }
}, true);

// Hit area interactions — delegate via svg, check target id
svg.addEventListener("mousedown", (e: Event) => {
  const me = e as MouseEvent;
  if (me.button !== 0) { return; }
  const target = e.target as SVGElement;
  if (target.id !== "hitArea") { return; }
  me.preventDefault();
  dragStartIdx = xToIdx(me.clientX);
  isDragging = false;
});

svg.addEventListener("mousemove", (e: Event) => {
  const target = e.target as SVGElement;
  if (target.id !== "hitArea" && !isDragging && dragStartIdx === null) { return; }
  const me = e as MouseEvent;
  me.preventDefault();

  if (dragStartIdx !== null) {
    const curIdx = xToIdx(me.clientX);
    if (Math.abs(curIdx - dragStartIdx) >= 2) {
      isDragging = true;
      const lo = Math.min(dragStartIdx, curIdx);
      const hi = Math.max(dragStartIdx, curIdx);
      const x1 = PADDING.left + lo * chartXStep;
      const x2 = PADDING.left + hi * chartXStep;
      const overlay = document.getElementById("selectOverlay");
      if (overlay) {
        overlay.setAttribute("x", String(x1));
        overlay.setAttribute("width", String(x2 - x1));
        overlay.style.display = "";
      }
    }
    return;
  }

  const idx = xToIdx(me.clientX);
  if (idx < 0 || idx >= renderVisibleData.length) { return; }
  const x = PADDING.left + idx * chartXStep;
  const d = renderVisibleData[idx];

  const crosshairLine = document.getElementById("crosshair");
  if (crosshairLine) {
    crosshairLine.setAttribute("x1", String(x));
    crosshairLine.setAttribute("x2", String(x));
    crosshairLine.style.display = "";
  }

  const date = new Date(d.date);
  const dateStr = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  let tooltipHtml = `
    <div class="hash">${d.hash}</div>
    <div class="message">${escapeHtml(d.message)}</div>
    <div class="author">${escapeHtml(d.author)} · ${dateStr}</div>
    <div class="stat">`;
  if (sections.fileCount) { tooltipHtml += `Files in repo: ${d.cumulativeFileCount}<br>`; }
  if (sections.filesChanged) {
    tooltipHtml += `Changed: ${d.filesChanged} (<span class="added">+${d.filesAdded}</span> <span class="deleted">-${d.filesDeleted}</span>)<br>`;
  }
  if (sections.authors) { tooltipHtml += `Authors (10): ${renderAuthorCounts[idx]}<br>`; }
  if (sections.velocity) { tooltipHtml += `Commits/day: ${renderVelocity[idx]}<br>`; }
  if (sections.churn) { tooltipHtml += `Churn: ${renderChurn[idx].toFixed(1)}%<br>`; }
  tooltipHtml += `</div>`;
  tooltip.innerHTML = tooltipHtml;
  tooltip.style.display = "block";

  const cRect = chartContainer.getBoundingClientRect();
  const tooltipW = tooltip.offsetWidth;
  let tooltipX = me.clientX - cRect.left + 12;
  if (tooltipX + tooltipW > cRect.width) {
    tooltipX = me.clientX - cRect.left - tooltipW - 12;
  }
  tooltip.style.left = tooltipX + "px";
  tooltip.style.top = (me.clientY - cRect.top - tooltip.offsetHeight - 8) + "px";
});

svg.addEventListener("mouseleave", () => {
  if (!isDragging) {
    const crosshairLine = document.getElementById("crosshair");
    if (crosshairLine) { crosshairLine.style.display = "none"; }
    tooltip.style.display = "none";
  }
});

svg.addEventListener("dblclick", () => {
  popZoom();
});

// ── Init ──────────────────────────────────────────────────────────────────────

svg.addEventListener("dragstart", (e: Event) => { e.preventDefault(); });

// Zoom-selection mouseup — registered once (was previously stacking inside render)
document.addEventListener("mouseup", (e: Event) => {
  if (dragStartIdx === null) { return; }
  const me = e as MouseEvent;
  const endIdx = xToIdx(me.clientX);
  const lo = Math.min(dragStartIdx, endIdx);
  const hi = Math.max(dragStartIdx, endIdx);
  const overlay = document.getElementById("selectOverlay");
  const crosshair = document.getElementById("crosshair");
  if (overlay) { overlay.style.display = "none"; }
  if (crosshair) { crosshair.style.display = "none"; }
  tooltip.style.display = "none";
  dragStartIdx = null;

  if (!isDragging || hi - lo < 2) {
    isDragging = false;
    return;
  }
  isDragging = false;

  const base = zoomStack.length > 0 ? zoomStack[zoomStack.length - 1].start : 0;
  zoomStack.push({ start: base + panOffset + lo, end: base + panOffset + hi });
  panOffset = 0;
  updateZoomSelect();
  render();
});

postMessage({ command: "ready" });
