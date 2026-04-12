import type { StonksToWebview, StonksFromWebview, StonksDataPoint, StonksTimeWindowOption } from "./messages";

const vscode = acquireVsCodeApi();

const repoSelect = document.getElementById("repoSelect") as HTMLSelectElement;
const loadingDiv = document.getElementById("loading") as HTMLElement;
const emptyDiv = document.getElementById("empty") as HTMLElement;
const chartContainer = document.getElementById("chartContainer") as HTMLElement;
const svg = document.getElementById("chart") as unknown as SVGSVGElement;
const tooltip = document.getElementById("tooltip") as HTMLElement;

let currentData: StonksDataPoint[] = [];
let zoomStart: number | null = null; // index into currentData
let zoomEnd: number | null = null;   // index into currentData

function getVisibleData(): StonksDataPoint[] {
  if (zoomStart !== null && zoomEnd !== null) {
    return currentData.slice(zoomStart, zoomEnd + 1);
  }
  return currentData;
}

function resetZoom(): void {
  zoomStart = null;
  zoomEnd = null;
  updateResetButton();
  render();
}

function updateResetButton(): void {
  const btn = document.getElementById("resetZoom") as HTMLElement | null;
  const info = document.getElementById("zoomInfo") as HTMLElement | null;
  const zoomed = zoomStart !== null && zoomEnd !== null;
  if (btn) {
    btn.style.display = zoomed ? "inline-block" : "none";
  }
  if (info) {
    if (zoomed) {
      const first = currentData[zoomStart!];
      const last = currentData[zoomEnd!];
      const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      info.textContent = `${first.hash.substring(0, 7)}→${last.hash.substring(0, 7)}  ·  ${fmt(first.date)} – ${fmt(last.date)}`;
      info.style.display = "inline";
    } else {
      info.style.display = "none";
    }
  }
}

function postMessage(msg: StonksFromWebview): void {
  vscode.postMessage(msg);
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
  const raw = timeWindowSelect.value;
  const days = raw === "pending" ? undefined : Number(raw);
  postMessage({ command: "selectTimeWindow", days });
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
      zoomStart = null;
      zoomEnd = null;
      updateResetButton();
      render();
      break;
    case "setLoading":
      loadingDiv.style.display = msg.loading ? "" : "none";
      if (msg.loading) {
        chartContainer.style.display = "none";
        emptyDiv.style.display = "none";
      }
      break;
  }
});

// ── SVG Chart Rendering ───────────────────────────────────────────────────────

const PADDING = { top: 16, right: 60, bottom: 32, left: 60 };
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

function render() {
  const visibleData = getVisibleData();
  if (visibleData.length === 0) {
    chartContainer.style.display = "none";
    emptyDiv.style.display = "";
    return;
  }
  emptyDiv.style.display = "none";
  chartContainer.style.display = "";

  // Available height: viewport minus header/toggles/padding above the chart container
  const containerTop = chartContainer.getBoundingClientRect().top;
  const availableH = window.innerHeight - containerTop;

  const bands = computeBands(availableH);
  if (bands.length === 0) { return; }

  const containerRect = chartContainer.getBoundingClientRect();
  const W = containerRect.width;
  if (W < 10) { return; }

  const totalH = bands[bands.length - 1].top + bands[bands.length - 1].height + PADDING.bottom;
  const plotW = W - PADDING.left - PADDING.right;

  const n = visibleData.length;
  const xStep = n > 1 ? plotW / (n - 1) : plotW / 2;

  // ── Pre-compute derived series ────────────────────────────────────────────
  const counts = visibleData.map(d => d.cumulativeFileCount);
  const volumes = visibleData.map(d => d.filesChanged);

  // Unique authors in rolling window of 10 commits
  const AUTHOR_WINDOW = 10;
  const authorCounts: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - AUTHOR_WINDOW + 1);
    const authors = new Set<string>();
    for (let j = start; j <= i; j++) { authors.add(visibleData[j].author); }
    authorCounts.push(authors.size);
  }

  // Commits per day (group by calendar day, then map back per-commit)
  const dayMap = new Map<string, number>();
  for (const d of visibleData) {
    const dayKey = d.date.substring(0, 10); // YYYY-MM-DD
    dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + 1);
  }
  const velocity: number[] = visibleData.map(d => dayMap.get(d.date.substring(0, 10)) ?? 0);

  // Churn rate: filesChanged / cumulativeFileCount (as percentage)
  const churn: number[] = visibleData.map(d =>
    d.cumulativeFileCount > 0 ? (d.filesChanged / d.cumulativeFileCount) * 100 : 0,
  );

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
      commitLinks += `<circle class="commit-link" data-hash="${visibleData[i].hash}" cx="${cx}" cy="${iconY}" r="${iconR}" fill="var(--vscode-textLink-foreground)" opacity="0.5" style="cursor:pointer"><title>${visibleData[i].hash.substring(0, 7)}</title></circle>`;
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

  // ── Commit link click handler ───────────────────────────────────────────────
  svg.querySelectorAll(".commit-link").forEach((el) => {
    el.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const hash = (el as SVGElement).getAttribute("data-hash");
      if (hash) { postMessage({ command: "openCommit", hash }); }
    });
    el.addEventListener("mouseenter", () => {
      (el as SVGElement).setAttribute("opacity", "1");
    });
    el.addEventListener("mouseleave", () => {
      (el as SVGElement).setAttribute("opacity", "0.5");
    });
  });

  // ── Mouse interaction ───────────────────────────────────────────────────────
  const hitArea = document.getElementById("hitArea")!;
  const crosshairLine = document.getElementById("crosshair")!;
  const selectOverlay = document.getElementById("selectOverlay")!;

  let dragStartIdx: number | null = null;
  let isDragging = false;

  function xToIdx(clientX: number): number {
    const svgRect = svg.getBoundingClientRect();
    const mx = clientX - svgRect.left;
    return Math.round(Math.max(0, Math.min(n - 1, (mx - PADDING.left) / xStep)));
  }

  svg.addEventListener("dragstart", (e: Event) => { e.preventDefault(); });

  hitArea.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.button !== 0) { return; }
    me.preventDefault();
    dragStartIdx = xToIdx(me.clientX);
    isDragging = false;
  });

  hitArea.addEventListener("mousemove", (e: Event) => {
    const me = e as MouseEvent;
    me.preventDefault();

    if (dragStartIdx !== null) {
      const curIdx = xToIdx(me.clientX);
      if (Math.abs(curIdx - dragStartIdx) >= 2) {
        isDragging = true;
        const lo = Math.min(dragStartIdx, curIdx);
        const hi = Math.max(dragStartIdx, curIdx);
        const x1 = PADDING.left + lo * xStep;
        const x2 = PADDING.left + hi * xStep;
        selectOverlay.setAttribute("x", String(x1));
        selectOverlay.setAttribute("width", String(x2 - x1));
        selectOverlay.style.display = "";
      }
      return;
    }

    const idx = xToIdx(me.clientX);
    const x = PADDING.left + idx * xStep;
    const d = visibleData[idx];

    crosshairLine.setAttribute("x1", String(x));
    crosshairLine.setAttribute("x2", String(x));
    crosshairLine.style.display = "";

    const date = new Date(d.date);
    const dateStr = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

    // Build tooltip with values for all visible sections
    let tooltipHtml = `
      <div class="hash">${d.hash}</div>
      <div class="message">${escapeHtml(d.message)}</div>
      <div class="author">${escapeHtml(d.author)} · ${dateStr}</div>
      <div class="stat">`;
    if (sections.fileCount) { tooltipHtml += `Files: ${d.cumulativeFileCount} · `; }
    if (sections.filesChanged) {
      tooltipHtml += `Changed: ${d.filesChanged} (<span class="added">+${d.filesAdded}</span> <span class="deleted">-${d.filesDeleted}</span>) · `;
    }
    if (sections.authors) { tooltipHtml += `Authors(10): ${authorCounts[idx]} · `; }
    if (sections.velocity) { tooltipHtml += `Commits/day: ${velocity[idx]} · `; }
    if (sections.churn) { tooltipHtml += `Churn: ${churn[idx].toFixed(1)}% · `; }
    // Strip trailing " · "
    tooltipHtml = tooltipHtml.replace(/ · $/, "");
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

  hitArea.addEventListener("mouseleave", () => {
    if (!isDragging) {
      crosshairLine.style.display = "none";
      tooltip.style.display = "none";
    }
  });

  document.addEventListener("mouseup", (e: Event) => {
    if (dragStartIdx === null) { return; }
    const me = e as MouseEvent;
    const endIdx = xToIdx(me.clientX);
    const lo = Math.min(dragStartIdx, endIdx);
    const hi = Math.max(dragStartIdx, endIdx);
    selectOverlay.style.display = "none";
    crosshairLine.style.display = "none";
    tooltip.style.display = "none";
    dragStartIdx = null;

    if (!isDragging || hi - lo < 2) {
      isDragging = false;
      return;
    }
    isDragging = false;

    const baseOffset = zoomStart ?? 0;
    zoomStart = baseOffset + lo;
    zoomEnd = baseOffset + hi;
    updateResetButton();
    render();
  });

  hitArea.addEventListener("dblclick", () => {
    if (zoomStart !== null) {
      resetZoom();
    }
  });
}

// ── Section rendering helpers ─────────────────────────────────────────────────

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

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById("resetZoom")?.addEventListener("click", resetZoom);
postMessage({ command: "ready" });
