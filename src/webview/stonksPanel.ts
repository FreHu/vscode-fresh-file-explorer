import type { StonksToWebview, StonksFromWebview, StonksDataPoint, StonksConfig, XAxisMode, StonksRepoSeries, StonksRepoTicker } from "./messages";
import {
  renderLinePath as _renderLinePath,
  renderLinePathScaled as _renderLinePathScaled,
  renderLineArea as _renderLineArea,
  renderYAxis as _renderYAxis,
  renderYAxisFromRange as _renderYAxisFromRange,
} from "./svgChartPrimitives";
import { PanController } from "./panController";
import { html } from "../utils/templateHelpers";
import { positionTooltip } from "./webviewUtils";
import { aggregateStonksData as aggregateData, bucketKey } from "./stonksBucketing";

const vscode = acquireVsCodeApi();

const watchlistBody = document.getElementById("watchlistBody") as HTMLElement;
const loadingDiv = document.getElementById("loading") as HTMLElement;
const emptyDiv = document.getElementById("empty") as HTMLElement;
const chartContainer = document.getElementById("chartContainer") as HTMLElement;
const svg = document.getElementById("chart") as unknown as SVGSVGElement;
const tooltip = document.getElementById("tooltip") as HTMLElement;
const xAxisSelect = document.getElementById("xAxisSelect") as HTMLSelectElement;

let selectedRepoPath = "";
let repoTickers: StonksRepoTicker[] = [];
let rawData: StonksDataPoint[] = [];   // untouched from extension
let currentData: StonksDataPoint[] = []; // after aggregation
let xAxisMode: XAxisMode = "commit";
interface ZoomLevel { start: number; end: number }
const zoomStack: ZoomLevel[] = [];
let maxVisibleTicks = 1000;

// Interaction state shared across render cycles
let chartN = 0;
let chartXStep = 0;
let dragStartIdx: number | null = null;
let isDragging = false;

// Per-render data used by mouse handlers (set in render, read by module-level listeners)
let renderVisibleData: StonksDataPoint[] = [];
let renderAllVisible: StonksDataPoint[] = [];
let renderAuthorCounts: number[] = [];
let renderAuthorConcentration: number[] = [];
let renderVelocity: number[] = [];
let renderChurn: number[] = [];
let renderCommitSize: number[] = [];

// Compare repos state
let compareRepos = false;
let compareSelectedPaths = new Set<string>();
let compareData: StonksRepoSeries[] = [];
let renderCompareSeries: { repoName: string; repoPath: string; values: number[] }[] = [];

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
  panCtrl.offset = Number.MAX_SAFE_INTEGER;
  updateZoomSelect();
  render();
}

function popZoom(): void {
  if (zoomStack.length > 0) {
    zoomStack.pop();
    panCtrl.offset = Number.MAX_SAFE_INTEGER;
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

  const tickLabel = xAxisMode === "commit" ? "commits" : xAxisMode + "s";

  const allOpt = document.createElement("option");
  allOpt.value = "0";
  allOpt.textContent = `All (${currentData.length} ${tickLabel})`;
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
    panCtrl.offset = Number.MAX_SAFE_INTEGER;
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
    sectionOptions: {
      authors: { windowSize: authorWindowSize },
      authorConcentration: { topX: authorTopX },
      commitSize: { windowSize: commitSizeWindowSize },
      activityHeatmap: {
        workdayStart: heatmapWorkdayStart,
        workdayEnd: heatmapWorkdayEnd,
        selectedAuthors: heatmapSelectedAuthors,
      },
    },
    compareRepos,
    maxVisibleTicks,
    selectedDays: Number(timeWindowSelect.value) || 30,
    xAxisMode,
  };
}

function sendConfig(): void {
  postMessage({ command: "updateConfig", config: buildConfig() });
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

function selectRepo(path: string): void {
  if (path === selectedRepoPath) { return; }
  selectedRepoPath = path;
  // Update selected row styling
  for (const row of Array.from(watchlistBody.querySelectorAll(".watchlist-row"))) {
    row.classList.toggle("selected", (row as HTMLElement).dataset.path === path);
  }
  postMessage({ command: "selectRepo", repoPath: path });
}

function renderWatchlist(): void {
  watchlistBody.innerHTML = "";
  const showCompare = compareRepos && xAxisMode !== "commit";
  for (const repo of repoTickers) {
    const row = document.createElement("div");
    row.className = "watchlist-row" + (repo.path === selectedRepoPath ? " selected" : "");
    row.dataset.path = repo.path;

    // Left cell: repo info
    const infoEl = document.createElement("div");
    infoEl.className = "repo-info";

    const nameEl = document.createElement("div");
    nameEl.className = "repo-name";

    if (showCompare) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "compare-cb";
      cb.checked = compareSelectedPaths.has(repo.path);
      cb.title = "Include in compare overlay";
      cb.addEventListener("click", (e) => { e.stopPropagation(); });
      cb.addEventListener("change", () => {
        if (cb.checked) { compareSelectedPaths.add(repo.path); }
        else { compareSelectedPaths.delete(repo.path); }
        postMessage({ command: "requestCompareData" });
      });
      nameEl.appendChild(cb);

      const swatch = document.createElement("span");
      swatch.style.display = "inline-block";
      swatch.style.width = "8px";
      swatch.style.height = "8px";
      swatch.style.borderRadius = "50%";
      swatch.style.backgroundColor = compareColorForRepo(repo.path);
      swatch.style.flexShrink = "0";
      if (!cb.checked) { swatch.style.opacity = "0.3"; }
      nameEl.appendChild(swatch);
    }

    const nameText = document.createElement("span");
    nameText.textContent = repo.name;
    nameText.title = repo.path;
    nameEl.appendChild(nameText);
    infoEl.appendChild(nameEl);

    // Last commit: hash (clickable) + message
    const commitEl = document.createElement("div");
    commitEl.className = "last-commit";
    if (repo.lastCommitHash) {
      const hashSpan = document.createElement("span");
      hashSpan.className = "commit-hash";
      hashSpan.textContent = repo.lastCommitHash;
      hashSpan.title = "Open commit";
      hashSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedRepoPath !== repo.path) { selectRepo(repo.path); }
        postMessage({ command: "openCommit", hash: repo.lastCommitHash! });
      });
      commitEl.appendChild(hashSpan);

      const msgSpan = document.createElement("span");
      msgSpan.className = "commit-msg";
      msgSpan.textContent = repo.lastCommitMessage ?? "";
      msgSpan.title = repo.lastCommitMessage ?? "";
      commitEl.appendChild(msgSpan);
    }
    infoEl.appendChild(commitEl);
    row.appendChild(infoEl);

    // Files changed in last commit: +added/~modified/-deleted
    const changedEl = document.createElement("div");
    changedEl.className = "files-changed";
    if (repo.lastCommitFilesChanged !== undefined && repo.lastCommitFilesChanged > 0) {
      const added = repo.lastCommitFilesAdded ?? 0;
      const deleted = repo.lastCommitFilesDeleted ?? 0;
      const modified = repo.lastCommitFilesChanged - added - deleted;
      const parts: string[] = [];
      if (added > 0) { parts.push(`<span class="added">+${added}</span>`); }
      if (modified > 0) { parts.push(`<span class="modified">~${modified}</span>`); }
      if (deleted > 0) { parts.push(`<span class="deleted">-${deleted}</span>`); }
      changedEl.innerHTML = parts.join(" ");
    } else {
      changedEl.textContent = "—";
      changedEl.classList.add("zero");
    }
    row.appendChild(changedEl);

    row.addEventListener("click", () => selectRepo(repo.path));
    watchlistBody.appendChild(row);
  }
}

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

function handleSetRepos(repos: StonksRepoTicker[]): void {
  repoTickers = repos;
  // Auto-select first repo if nothing selected yet
  if (repos.length > 0 && !selectedRepoPath) {
    selectedRepoPath = repos[0].path;
  }
  renderWatchlist();
}

function handleSetTimeWindows(options: { label: string; days: number | undefined }[], selectedDays: number | undefined): void {
  timeWindowSelect.innerHTML = "";
  for (const tw of options) {
    const opt = document.createElement("option");
    opt.value = tw.days === undefined ? "pending" : String(tw.days);
    opt.textContent = tw.label;
    if (tw.days === selectedDays) { opt.selected = true; }
    timeWindowSelect.appendChild(opt);
  }
}

function handleSetData(data: StonksDataPoint[]): void {
  rawData = data;
  currentData = aggregateData(rawData, xAxisMode);
  zoomStack.length = 0;
  panCtrl.offset = Number.MAX_SAFE_INTEGER;
  derivedCache = null;
  updateZoomSelect();
  rebuildHeatmapAuthorCheckboxes();
  // Update selected repo's ticker from latest data point
  if (data.length > 0 && selectedRepoPath) {
    const latest = data[data.length - 1];
    const ticker = repoTickers.find(r => r.path === selectedRepoPath);
    if (ticker) {
      ticker.totalFiles = latest.cumulativeFileCount;
      if (latest.hash) { ticker.lastCommitHash = latest.hash.substring(0, 7); }
      if (latest.message) { ticker.lastCommitMessage = latest.message; }
      if (latest.filesChanged !== undefined) { ticker.lastCommitFilesChanged = latest.filesChanged; }
      if (latest.filesAdded !== undefined) { ticker.lastCommitFilesAdded = latest.filesAdded; }
      if (latest.filesDeleted !== undefined) { ticker.lastCommitFilesDeleted = latest.filesDeleted; }
      renderWatchlist();
    }
  }
  if (compareRepos) { postMessage({ command: "requestCompareData" }); }
  render();
}

function handleSetLoading(loading: boolean): void {
  loadingDiv.style.display = loading ? "" : "none";
  if (loading) {
    chartContainer.style.display = "none";
    emptyDiv.style.display = "none";
  }
}

function handleSetConfig(c: StonksConfig): void {
  // Apply section toggles
  const sectionDefaults: Record<keyof typeof sections, boolean> = {
    fileCount: true, filesChanged: true, authors: true, authorConcentration: true,
    velocity: true, churn: true, commitSize: true, activityHeatmap: false,
  };
  for (const { key, toggleId } of SECTION_TOGGLE_DEFS) {
    sections[key] = c.sections[key] ?? sectionDefaults[key];
    const cb = document.getElementById(toggleId) as HTMLInputElement | null;
    if (cb) { cb.checked = sections[key]; }
    // Show/hide per-section options
    const optionsEl = document.getElementById(`options${key.charAt(0).toUpperCase() + key.slice(1)}`);
    if (optionsEl) { optionsEl.classList.toggle("visible", sections[key]); }
  }
  // Apply compare repos
  compareRepos = c.compareRepos ?? false;
  if (compareReposCheckbox) { compareReposCheckbox.checked = compareRepos; }
  // Apply section options
  if (c.sectionOptions?.authors) {
    authorWindowSize = c.sectionOptions.authors.windowSize;
    if (authorWindowSizeInput) { authorWindowSizeInput.value = String(authorWindowSize); }
  }
  if (c.sectionOptions?.authorConcentration) {
    authorTopX = c.sectionOptions.authorConcentration.topX;
    if (authorTopXInput) { authorTopXInput.value = String(authorTopX); }
  }
  if (c.sectionOptions?.commitSize) {
    commitSizeWindowSize = c.sectionOptions.commitSize.windowSize;
    if (commitSizeWindowInput) { commitSizeWindowInput.value = String(commitSizeWindowSize); }
  }
  if (c.sectionOptions?.activityHeatmap) {
    const opts = c.sectionOptions.activityHeatmap;
    heatmapWorkdayStart = opts.workdayStart;
    heatmapWorkdayEnd = opts.workdayEnd;
    heatmapSelectedAuthors = opts.selectedAuthors;
    if (heatmapWorkdayStartInput) { heatmapWorkdayStartInput.value = String(heatmapWorkdayStart); }
    if (heatmapWorkdayEndInput) { heatmapWorkdayEndInput.value = String(heatmapWorkdayEnd); }
    rebuildHeatmapAuthorCheckboxes();
  }
  // Apply max ticks
  maxVisibleTicks = c.maxVisibleTicks;
  maxTicksInput.value = String(c.maxVisibleTicks);
  // Apply x-axis mode
  if (c.xAxisMode) {
    applyXAxisMode(c.xAxisMode);
  }
  updateCommitOnlyToggles();
}

function handleSetCompareData(series: StonksRepoSeries[]): void {
  compareData = series;
  render();
}

window.addEventListener("message", (event) => {
  const msg = event.data as StonksToWebview;
  switch (msg.command) {
    case "setRepos": handleSetRepos(msg.repos); break;
    case "setTimeWindows": handleSetTimeWindows(msg.options, msg.selectedDays); break;
    case "setData": handleSetData(msg.data); break;
    case "setCompareData": handleSetCompareData(msg.series); break;
    case "setLoading": handleSetLoading(msg.loading); break;
    case "setConfig": handleSetConfig(msg.config); break;
  }
});

// ── Help button ───────────────────────────────────────────────────────────────
document.getElementById("helpBtn")?.addEventListener("click", () => {
  postMessage({ command: "openHelp" });
});

// ── Export button ─────────────────────────────────────────────────────────────
document.getElementById("exportBtn")?.addEventListener("click", () => {
  const svgEl = document.getElementById("chart");
  if (!svgEl) { return; }
  // Clone and add xmlns + background for standalone SVG
  const clone = svgEl.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // Get dimensions from viewBox (viewBox="0 0 W H")
  const vb = svgEl.getAttribute("viewBox")?.split(/\s+/) ?? [];
  const width = vb[2] || svgEl.getBoundingClientRect().width.toString();
  const height = vb[3] || svgEl.getBoundingClientRect().height.toString();
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  // Resolve CSS variables to computed values for portability
  const style = getComputedStyle(document.body);
  const bg = style.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";
  const fg = style.getPropertyValue("--vscode-foreground").trim() || "#cccccc";
  const descFg = style.getPropertyValue("--vscode-descriptionForeground").trim() || "#888888";
  const borderColor = style.getPropertyValue("--vscode-editorWidget-border").trim() || "#444444";
  const bgRect = `<rect width="${width}" height="${height}" fill="${bg}"/>`;
  const styleBlock = `<style>text { font-family: sans-serif; } </style>`;
  clone.innerHTML = bgRect + styleBlock + clone.innerHTML;
  // Replace CSS variable references with computed values
  let svgStr = new XMLSerializer().serializeToString(clone);
  svgStr = svgStr.replace(/var\(--vscode-foreground[^)]*\)/g, fg);
  svgStr = svgStr.replace(/var\(--vscode-descriptionForeground[^)]*\)/g, descFg);
  svgStr = svgStr.replace(/var\(--vscode-editorWidget-border[^)]*\)/g, borderColor);
  svgStr = svgStr.replace(/var\(--vscode-editor-background[^)]*\)/g, bg);
  // Replace other common CSS variables with their fallback or computed value
  svgStr = svgStr.replace(/var\(--vscode-[^,)]+,\s*([^)]+)\)/g, "$1");
  svgStr = svgStr.replace(/var\(--vscode-[^)]+\)/g, fg);
  postMessage({ command: "exportSvg", svg: svgStr });
});

// ── SVG Chart Rendering ───────────────────────────────────────────────────────

const PADDING = { top: 36, right: 48, bottom: 32, left: 48 };
const SECTION_GAP = 28; // gap between sections (includes label space)
const SECTION_LABEL_OFFSET = -6; // y offset for section label above its band

// Section visibility state (all default checked)
const sections = {
  fileCount: true,
  filesChanged: true,
  authors: true,
  authorConcentration: true,
  velocity: true,
  churn: true,
  commitSize: true,
  activityHeatmap: false,
};

let authorTopX = 1;
let authorWindowSize = 10;
let commitSizeWindowSize = 10;

// Activity heatmap options
let heatmapWorkdayStart = 8;
let heatmapWorkdayEnd = 16;
/** Author whitelist for the heatmap. `undefined` = no filter (show all). */
let heatmapSelectedAuthors: string[] | undefined = undefined;
/** Transient hover preview — overrides the persisted filter while a chip is hovered. */
let heatmapHoverAuthor: string | undefined = undefined;

// Section toggle definitions — single source of truth for key ↔ DOM id mapping
const SECTION_TOGGLE_DEFS: { key: keyof typeof sections; toggleId: string; sectionId?: string }[] = [
  { key: "fileCount", toggleId: "toggleFileCount" },
  { key: "filesChanged", toggleId: "toggleFilesChanged" },
  { key: "authors", toggleId: "toggleAuthors", sectionId: "sectionAuthors" },
  { key: "authorConcentration", toggleId: "toggleAuthorConcentration", sectionId: "sectionAuthorConcentration" },
  { key: "velocity", toggleId: "toggleVelocity" },
  { key: "churn", toggleId: "toggleChurn" },
  { key: "commitSize", toggleId: "toggleCommitSize" },
  { key: "activityHeatmap", toggleId: "toggleActivityHeatmap", sectionId: "sectionActivityHeatmap" },
];

// Sections that only apply in commit mode
const COMMIT_ONLY_KEYS = new Set<keyof typeof sections>(["authors", "authorConcentration", "activityHeatmap"]);

function updateCommitOnlyToggles(): void {
  const isCommit = xAxisMode === "commit";
  for (const { key, sectionId } of SECTION_TOGGLE_DEFS) {
    if (!COMMIT_ONLY_KEYS.has(key)) { continue; }
    const el = document.getElementById(sectionId ?? "");
    if (el) { el.classList.toggle("disabled", !isCommit); }
  }
  // Compare repos only works in time-based modes
  const compareCb = document.getElementById("toggleCompareRepos") as HTMLInputElement | null;
  const compareContainer = compareCb?.closest(".section-toggle") as HTMLElement | null;
  if (compareContainer) { compareContainer.classList.toggle("disabled", isCommit); }
  if (isCommit && compareCb?.checked) {
    compareCb.checked = false;
    compareRepos = false;
    compareSelectedPaths.clear();
    compareData = [];
    sendConfig();
    renderWatchlist();
  }
}

// Wire up toggle checkboxes
for (const { key, toggleId } of SECTION_TOGGLE_DEFS) {
  const cb = document.getElementById(toggleId) as HTMLInputElement | null;
  if (cb) {
    cb.addEventListener("change", () => {
      sections[key] = cb.checked;
      // Show/hide per-section options
      const optionsEl = document.getElementById(`options${key.charAt(0).toUpperCase() + key.slice(1)}`);
      if (optionsEl) { optionsEl.classList.toggle("visible", cb.checked); }
      sendConfig();
      render();
    });
    // Initialize options visibility
    const optionsEl = document.getElementById(`options${key.charAt(0).toUpperCase() + key.slice(1)}`);
    if (optionsEl) { optionsEl.classList.toggle("visible", cb.checked); }
  }
}

// Wire up author window size input
const authorWindowSizeInput = document.getElementById("authorWindowSize") as HTMLInputElement | null;
if (authorWindowSizeInput) {
  authorWindowSizeInput.addEventListener("change", () => {
    const val = parseInt(authorWindowSizeInput.value, 10);
    if (val >= 2 && val <= 100) {
      authorWindowSize = val;
      derivedCache = null;
      sendConfig();
      render();
    }
  });
}

// Wire up author concentration topX input
const authorTopXInput = document.getElementById("authorTopX") as HTMLInputElement | null;
if (authorTopXInput) {
  authorTopXInput.addEventListener("change", () => {
    const val = parseInt(authorTopXInput.value, 10);
    if (val >= 1 && val <= 10) {
      authorTopX = val;
      derivedCache = null;
      sendConfig();
      render();
    }
  });
}

// Wire up commit size window input
const commitSizeWindowInput = document.getElementById("commitSizeWindowSize") as HTMLInputElement | null;
if (commitSizeWindowInput) {
  commitSizeWindowInput.addEventListener("change", () => {
    const val = parseInt(commitSizeWindowInput.value, 10);
    if (val >= 2 && val <= 100) {
      commitSizeWindowSize = val;
      derivedCache = null;
      sendConfig();
      render();
    }
  });
}

// Wire up activity heatmap workday inputs and author checkbox container
const heatmapWorkdayStartInput = document.getElementById("heatmapWorkdayStart") as HTMLInputElement | null;
const heatmapWorkdayEndInput = document.getElementById("heatmapWorkdayEnd") as HTMLInputElement | null;
const heatmapAuthorsContainer = document.getElementById("heatmapAuthors") as HTMLElement | null;

if (heatmapWorkdayStartInput) {
  heatmapWorkdayStartInput.addEventListener("change", () => {
    const v = parseInt(heatmapWorkdayStartInput.value, 10);
    if (!isNaN(v) && v >= 0 && v <= 23) {
      heatmapWorkdayStart = v;
      sendConfig();
      render();
    }
  });
}
if (heatmapWorkdayEndInput) {
  heatmapWorkdayEndInput.addEventListener("change", () => {
    const v = parseInt(heatmapWorkdayEndInput.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 24) {
      heatmapWorkdayEnd = v;
      sendConfig();
      render();
    }
  });
}

/**
 * Rebuild author checkbox list from current `rawData`.
 *
 * `heatmapSelectedAuthors === undefined` means "no filter" — every checkbox starts
 * checked, including newly-seen authors after a repo switch. Toggling any box
 * commits the filter to an explicit array; toggling back to all-checked normalizes
 * to undefined so the config stays clean.
 *
 * If a persisted filter is fully disjoint from the current author list (e.g. user
 * filtered to "Alice" then switched to a repo without her), we drop the filter
 * rather than render an empty heatmap.
 */
function rebuildHeatmapAuthorCheckboxes(): void {
  if (!heatmapAuthorsContainer) { return; }
  const authors = Array.from(new Set(rawData.map(d => d.author).filter((a): a is string => !!a))).sort();
  // Drop a stale filter only when it's both non-empty AND fully disjoint from current authors
  // (e.g. user filtered to "Alice" then switched to a repo without her). Preserve an explicit
  // empty filter [] — that's the user-chosen "show none" state from the "none" button.
  if (heatmapSelectedAuthors !== undefined && heatmapSelectedAuthors.length > 0 && !heatmapSelectedAuthors.some(a => authors.includes(a))) {
    heatmapSelectedAuthors = undefined;
  }
  heatmapAuthorsContainer.innerHTML = "";
  if (authors.length === 0) { return; }
  const isChecked = (a: string) => heatmapSelectedAuthors === undefined || heatmapSelectedAuthors.includes(a);
  for (const a of authors) {
    const label = document.createElement("label");
    label.className = "heatmap-author";
    label.title = a;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isChecked(a);
    cb.dataset.author = a;
    cb.addEventListener("change", () => {
      const checked = Array.from(heatmapAuthorsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .filter(c => c.checked)
        .map(c => c.dataset.author!);
      heatmapSelectedAuthors = checked.length === authors.length ? undefined : checked;
      sendConfig();
      render();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + a));
    heatmapAuthorsContainer.appendChild(label);
  }
}

// Hover preview: hovering a chip transiently filters the heatmap to that author.
// mouseenter/mouseleave don't bubble, so we attach in capture phase on the container.
heatmapAuthorsContainer?.addEventListener("mouseenter", (e: Event) => {
  const target = e.target as HTMLElement;
  if (!target.classList?.contains("heatmap-author")) { return; }
  const cb = target.querySelector("input") as HTMLInputElement | null;
  const author = cb?.dataset.author;
  if (!author || author === heatmapHoverAuthor) { return; }
  heatmapHoverAuthor = author;
  render();
}, true);
heatmapAuthorsContainer?.addEventListener("mouseleave", (e: Event) => {
  const target = e.target as HTMLElement;
  if (!target.classList?.contains("heatmap-author")) { return; }
  if (heatmapHoverAuthor === undefined) { return; }
  heatmapHoverAuthor = undefined;
  render();
}, true);

// Wire up "all" / "none" shortcuts for the heatmap author list
document.getElementById("heatmapAuthorsAll")?.addEventListener("click", () => {
  heatmapSelectedAuthors = undefined;
  rebuildHeatmapAuthorCheckboxes();
  sendConfig();
  render();
});
document.getElementById("heatmapAuthorsNone")?.addEventListener("click", () => {
  heatmapSelectedAuthors = [];
  rebuildHeatmapAuthorCheckboxes();
  sendConfig();
  render();
});

// Wire up compare repos checkbox
const compareReposCheckbox = document.getElementById("toggleCompareRepos") as HTMLInputElement | null;
if (compareReposCheckbox) {
  compareReposCheckbox.addEventListener("change", () => {
    compareRepos = compareReposCheckbox.checked;
    sendConfig();
    renderWatchlist();
    if (compareRepos) {
      postMessage({ command: "requestCompareData" });
    } else {
      compareSelectedPaths.clear();
      compareData = [];
      render();
    }
  });
}

updateCommitOnlyToggles();

// Section weight config (relative proportions, not fixed pixels)
const SECTION_WEIGHTS: Record<string, number> = {
  fileCount: 3,
  filesChanged: 1.5,
  authors: 1.5,
  authorConcentration: 1.5,
  velocity: 1.5,
  churn: 1.5,
  commitSize: 1.5,
  activityHeatmap: 3,
};

const MIN_BAND_HEIGHT = 60;

interface Band {
  key: string;
  label: string;
  top: number;
  height: number;
}

function computeBands(availableHeight: number): Band[] {
  const modeLabel: Record<XAxisMode, string> = { commit: "day", day: "day", week: "week", month: "month" };
  const defs: { key: keyof typeof sections; label: string }[] = [
    { key: "fileCount", label: "Files in repo" },
    { key: "filesChanged", label: "Files changed" },
    ...(xAxisMode === "commit" ? [{ key: "authors" as const, label: `Unique authors (rolling ${authorWindowSize} commits)` }] : []),
    ...(xAxisMode === "commit" ? [{ key: "authorConcentration" as const, label: `Author concentration (top ${authorTopX})` }] : []),
    { key: "velocity", label: `Commits per ${modeLabel[xAxisMode]}` },
    { key: "churn", label: "Churn rate (changed / repo size)" },
    { key: "commitSize", label: xAxisMode === "commit" ? `Avg commit size (rolling ${commitSizeWindowSize})` : `Avg commit size (files/${modeLabel[xAxisMode]})` },
    ...(xAxisMode === "commit" ? [{ key: "activityHeatmap" as const, label: "Activity heatmap (day × hour, committer-local time)" }] : []),
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

const COMPARE_COLORS = [
  "var(--vscode-charts-blue, #339af0)",
  "var(--vscode-charts-orange, #ffa94d)",
  "var(--vscode-charts-green, #51cf66)",
  "var(--vscode-charts-red, #ff6b6b)",
  "var(--vscode-charts-purple, #b197fc)",
  "var(--vscode-charts-yellow, #ffd43b)",
  "#20c997", "#e599f7", "#74c0fc", "#f06595",
];

function compareColorForRepo(repoPath: string): string {
  const idx = repoTickers.findIndex(t => t.path === repoPath);
  return COMPARE_COLORS[(idx === -1 ? 0 : idx) % COMPARE_COLORS.length];
}

/**
 * Align each compare repo's cumulativeFileCount to the visible date buckets.
 * For dates where a repo has no data, carry the last known value forward.
 */
function buildCompareSeries(visibleData: StonksDataPoint[], mode: XAxisMode): { repoName: string; repoPath: string; values: number[] }[] {
  const visibleKeys = visibleData.map(d => bucketKey(d.date, mode));
  const filtered = compareData.filter(s => compareSelectedPaths.has(s.repoPath));
  return filtered.map(series => {
    const agg = aggregateData(series.data, mode);
    const lookup = new Map<string, number>();
    for (const d of agg) { lookup.set(bucketKey(d.date, mode), d.cumulativeFileCount); }

    const values: number[] = [];
    let lastVal = 0;
    for (const key of visibleKeys) {
      if (lookup.has(key)) { lastVal = lookup.get(key)!; }
      values.push(lastVal);
    }
    return { repoName: series.repoName, repoPath: series.repoPath, values };
  });
}

function xToIdx(clientX: number): number {
  const svgRect = svg.getBoundingClientRect();
  const mx = clientX - svgRect.left;
  return Math.round(Math.max(0, Math.min(chartN - 1, (mx - PADDING.left) / chartXStep)));
}

// Derived series cache — recomputed only when zoom level or data changes, not on pan
let derivedCache: {
  data: StonksDataPoint[];
  zoomKey: string;
  topX: number;
  windowSize: number;
  commitSizeWindow: number;
  allAuthorCounts: number[];
  allAuthorConcentration: number[];
  allVelocity: number[];
  allChurn: number[];
  allCommitSize: number[];
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
    panCtrl.update(0);
    return;
  }
  emptyDiv.style.display = "none";
  chartContainer.style.display = "";

  // ── Page window (limit rendered ticks, rest via horizontal pan) ──────────
  const pageStart = panCtrl.update(allVisible.length);
  const pageEnd = allVisible.length <= maxVisibleTicks ? allVisible.length : pageStart + maxVisibleTicks;

  // ── Derived series (cached across pan-only re-renders) ────────────────────
  const zoomKey = zoomCacheKey();
  let allAuthorCounts: number[];
  let allAuthorConcentration: number[];
  let allVelocity: number[];
  let allChurn: number[];
  let allCommitSize: number[];

  if (derivedCache && derivedCache.data === currentData && derivedCache.zoomKey === zoomKey && derivedCache.topX === authorTopX && derivedCache.windowSize === authorWindowSize && derivedCache.commitSizeWindow === commitSizeWindowSize) {
    allAuthorCounts = derivedCache.allAuthorCounts;
    allAuthorConcentration = derivedCache.allAuthorConcentration;
    allVelocity = derivedCache.allVelocity;
    allChurn = derivedCache.allChurn;
    allCommitSize = derivedCache.allCommitSize;
  } else {
    const allN = allVisible.length;

    // Authors + concentration: both use same rolling window, compute in single pass
    if (xAxisMode === "commit") {
      allAuthorCounts = [];
      allAuthorConcentration = [];
      for (let i = 0; i < allN; i++) {
        const start = Math.max(0, i - authorWindowSize + 1);
        const authorCommits = new Map<string, number>();
        for (let j = start; j <= i; j++) {
          const a = allVisible[j].author!;
          authorCommits.set(a, (authorCommits.get(a) ?? 0) + 1);
        }
        allAuthorCounts.push(authorCommits.size);
        const windowSize = i - start + 1;
        const sorted = [...authorCommits.values()].sort((a, b) => b - a);
        const topXSum = sorted.slice(0, authorTopX).reduce((s, v) => s + v, 0);
        allAuthorConcentration.push((topXSum / windowSize) * 100);
      }
    } else {
      allAuthorCounts = [];
      allAuthorConcentration = [];
    }

    // Velocity: in commit mode = commits sharing same calendar day; in aggregated modes = commitCount
    if (xAxisMode === "commit") {
      const dayMap = new Map<string, number>();
      for (const d of allVisible) {
        const dayKey = d.date.substring(0, 10);
        dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + 1);
      }
      allVelocity = allVisible.map(d => dayMap.get(d.date.substring(0, 10)) ?? 0);
    } else {
      allVelocity = allVisible.map(d => d.commitCount);
    }

    allChurn = allVisible.map(d =>
      d.cumulativeFileCount > 0 ? (d.filesChanged / d.cumulativeFileCount) * 100 : 0,
    );

    // Commit size: rolling average of filesChanged in commit mode, per-bucket average in aggregated
    if (xAxisMode === "commit") {
      allCommitSize = [];
      for (let i = 0; i < allN; i++) {
        const start = Math.max(0, i - commitSizeWindowSize + 1);
        let sum = 0;
        for (let j = start; j <= i; j++) { sum += allVisible[j].filesChanged; }
        allCommitSize.push(sum / (i - start + 1));
      }
    } else {
      allCommitSize = allVisible.map(d => d.commitCount > 0 ? d.filesChanged / d.commitCount : 0);
    }

    derivedCache = { data: currentData, zoomKey, topX: authorTopX, windowSize: authorWindowSize, commitSizeWindow: commitSizeWindowSize, allAuthorCounts, allAuthorConcentration, allVelocity, allChurn, allCommitSize };
  }

  // ── Slice to page window ──────────────────────────────────────────────────
  const visibleData = allVisible.slice(pageStart, pageEnd);
  const counts = visibleData.map(d => d.cumulativeFileCount);
  const volumes = visibleData.map(d => d.filesChanged);
  const authorCounts = allAuthorCounts.slice(pageStart, pageEnd);
  const authorConcentration = allAuthorConcentration.slice(pageStart, pageEnd);
  const velocity = allVelocity.slice(pageStart, pageEnd);
  const churn = allChurn.slice(pageStart, pageEnd);
  const commitSize = allCommitSize.slice(pageStart, pageEnd);

  // ── Compare repos: align other repos' fileCount to visible date buckets ───
  const isCompareActive = compareRepos && xAxisMode !== "commit" && compareData.length > 0;
  let compareSeries: { repoName: string; repoPath: string; values: number[] }[] = [];
  if (isCompareActive) {
    compareSeries = buildCompareSeries(visibleData, xAxisMode);
  }

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
      if (isCompareActive && compareSeries.length > 0) {
        // Multi-repo overlay: find global min/max across all series for shared Y scale
        let globalMin = Math.min(...counts);
        let globalMax = Math.max(...counts);
        for (const s of compareSeries) {
          globalMin = Math.min(globalMin, ...s.values);
          globalMax = Math.max(globalMax, ...s.values);
        }
        // Render each compare repo as a line
        for (let si = 0; si < compareSeries.length; si++) {
          const color = compareColorForRepo(compareSeries[si].repoPath);
          svgContent += renderLinePathScaled(compareSeries[si].values, top, bandH, plotW, n, xStep, color, globalMin, globalMax);
        }
        svgContent += renderYAxisFromRange(globalMin, globalMax, top, bandH, plotW, 8);
      } else {
        svgContent += renderLineArea(counts, top, bandH, plotW, n, xStep, "var(--vscode-charts-blue, #339af0)", true);
        svgContent += renderYAxis(counts, top, bandH, plotW, 8);
      }
    } else if (key === "filesChanged") {
      svgContent += renderVolumeBars(visibleData, volumes, top, bandH, plotW, n, xStep);
      const maxVol = Math.max(...volumes, 1);
      svgContent += renderYAxisFromRange(0, maxVol, top, bandH, plotW, 3);
    } else if (key === "authors") {
      svgContent += renderLinePath(authorCounts, top, bandH, plotW, n, xStep, "var(--vscode-charts-orange, #ffa94d)");
      svgContent += renderYAxis(authorCounts, top, bandH, plotW, 3);
    } else if (key === "authorConcentration") {
      svgContent += renderLinePath(authorConcentration, top, bandH, plotW, n, xStep, "var(--vscode-charts-purple, #b197fc)");
      svgContent += renderYAxisFromRange(0, Math.max(...authorConcentration, 1), top, bandH, plotW, 3, v => `${v.toFixed(0)}%`);
    } else if (key === "velocity") {
      svgContent += renderLinePath(velocity, top, bandH, plotW, n, xStep, "var(--vscode-charts-green, #51cf66)");
      svgContent += renderYAxis(velocity, top, bandH, plotW, 3);
    } else if (key === "churn") {
      svgContent += renderLinePath(churn, top, bandH, plotW, n, xStep, "var(--vscode-charts-red, #ff6b6b)");
      svgContent += renderYAxisFromRange(0, Math.max(...churn, 0.1), top, bandH, plotW, 3, v => `${v.toFixed(1)}%`);
    } else if (key === "commitSize") {
      svgContent += renderLinePath(commitSize, top, bandH, plotW, n, xStep, "var(--vscode-charts-yellow, #ffd43b)");
      svgContent += renderYAxis(commitSize, top, bandH, plotW, 3, v => v.toFixed(1));
    } else if (key === "activityHeatmap") {
      svgContent += renderActivityHeatmap(allVisible, top, bandH, plotW, PADDING);
    }
  }

  // Commit link icons (below last time-series band, excluding heatmap)
  const seriesBands = bands.filter(b => b.key !== "activityHeatmap");
  const lastSeriesBand = seriesBands.length > 0 ? seriesBands[seriesBands.length - 1] : bands[bands.length - 1];
  const commitLinksTop = lastSeriesBand.top + lastSeriesBand.height;
  const COMMIT_ICON_THRESHOLD = 150;
  let commitLinks = "";
  if (xAxisMode === "commit" && n <= COMMIT_ICON_THRESHOLD && xStep >= 8) {
    const iconY = commitLinksTop + 14;
    const iconR = Math.min(4, xStep * 0.25);
    for (let i = 0; i < n; i++) {
      const cx = PADDING.left + i * xStep;
      commitLinks += `<circle class="commit-link" data-hash="${visibleData[i].hash}" cx="${cx}" cy="${iconY}" r="${iconR}" fill="var(--vscode-textLink-foreground)" opacity="0.5" style="cursor:pointer"><title>Open commit ${visibleData[i].hash!.substring(0, 7)}</title></circle>`;
    }
  }
  svgContent += commitLinks;

  // Crosshair + hit area spanning only time-series bands (not the heatmap)
  const firstSeriesBand = seriesBands.length > 0 ? seriesBands[0] : bands[0];
  const crosshairBottom = lastSeriesBand.top + lastSeriesBand.height;
  svgContent += `<line id="crosshair" x1="0" y1="${firstSeriesBand.top}" x2="0" y2="${crosshairBottom}" stroke="var(--vscode-foreground)" stroke-width="0.5" opacity="0.5" style="display:none"/>`;

  // Hit area spanning only time-series bands
  const hitTop = firstSeriesBand.top;
  const hitH = crosshairBottom - hitTop;
  svgContent += `<rect id="hitArea" x="${PADDING.left}" y="${hitTop}" width="${plotW}" height="${hitH}" fill="transparent" style="cursor:crosshair"/>`;
  svgContent += `<rect id="selectOverlay" x="0" y="${hitTop}" width="0" height="${hitH}" fill="var(--vscode-editor-selectionBackground, rgba(51,154,240,0.2))" style="display:none; pointer-events:none"/>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${totalH}`);
  svg.style.height = `${totalH}px`;
  svg.innerHTML = svgContent;

  // Update module-level data for mouse handlers (registered once, outside render)
  renderVisibleData = visibleData;
  renderAllVisible = allVisible;
  renderAuthorCounts = authorCounts;
  renderAuthorConcentration = authorConcentration;
  renderVelocity = velocity;
  renderChurn = churn;
  renderCommitSize = commitSize;
  renderCompareSeries = compareSeries;

  // ── Update pan scrollbar ────────────────────────────────────────────────────
}

// ── Pan scrollbar ─────────────────────────────────────────────────────────────

const panScrollbar = document.getElementById("panScrollbar") as HTMLElement;
const panThumb = document.getElementById("panThumb") as HTMLElement;

const panCtrl = new PanController(
  panScrollbar, panThumb, chartContainer,
  () => render(),
  () => visibleDataLength(),
  () => maxVisibleTicks,
);

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

// ── Section rendering helpers (delegate to shared primitives with local PADDING) ─

function renderLinePath(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string,
): string {
  return _renderLinePath(values, top, bandH, plotW, n, xStep, color, PADDING);
}

function renderLinePathScaled(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string, min: number, max: number,
): string {
  return _renderLinePathScaled(values, top, bandH, plotW, n, xStep, color, min, max, PADDING);
}

function renderLineArea(
  values: number[], top: number, bandH: number, plotW: number,
  n: number, xStep: number, color: string, useGradient: boolean,
): string {
  return _renderLineArea(values, top, bandH, plotW, n, xStep, color, useGradient, PADDING);
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

const HEATMAP_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Resolve a commit's day-of-week and hour-of-day in the *committer's* local time
 * (not the viewer's). `d.date` is a UTC instant; `d.tzOffsetMinutes` carries the
 * original `%aI` offset. Shifting then reading via `getUTCxxx` yields the
 * committer's wall clock without the viewer's TZ leaking back in.
 *
 * Falls back to UTC when the offset is missing (older cached data).
 */
function committerLocalDayHour(d: StonksDataPoint): { day: number; hour: number } {
  const shifted = new Date(new Date(d.date).getTime() + (d.tzOffsetMinutes ?? 0) * 60_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

// ── Toast notification ────────────────────────────────────────────────────────

const toastEl = document.getElementById("stonksToast") as HTMLElement | null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (!toastEl) { return; }
  toastEl.textContent = message;
  toastEl.style.opacity = "1";
  if (toastTimeout !== null) { clearTimeout(toastTimeout); }
  toastTimeout = setTimeout(() => {
    if (toastEl) { toastEl.style.opacity = "0"; }
    toastTimeout = null;
  }, 2500);
}

function heatmapMatchesAuthorFilter(d: StonksDataPoint): boolean {
  // Hover preview wins over the persisted filter — releasing the mouse restores it.
  if (heatmapHoverAuthor !== undefined) {
    return d.author === heatmapHoverAuthor;
  }
  if (heatmapSelectedAuthors === undefined) { return true; }
  return d.author !== undefined && heatmapSelectedAuthors.includes(d.author);
}

function renderActivityHeatmap(
  data: StonksDataPoint[], top: number, bandH: number, plotW: number,
  pad: typeof PADDING,
): string {
  // Build 7x24 grid: [day 0..6][hour 0..23], in committer-local time
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const d of data) {
    if (!heatmapMatchesAuthorFilter(d)) { continue; }
    const { day, hour } = committerLocalDayHour(d);
    grid[day][hour]++;
  }
  const maxCount = Math.max(...grid.flat(), 1);
  const cellW = plotW / 24;
  const cellH = bandH / 7;
  let out = "";
  for (let day = 0; day < 7; day++) {
    const cellY = top + day * cellH;
    out += `<text x="${pad.left - 10}" y="${cellY + cellH / 2 + 4}" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">${HEATMAP_DAY_LABELS[day]}</text>`;
    for (let hour = 0; hour < 24; hour++) {
      const count = grid[day][hour];
      const cellX = pad.left + hour * cellW;
      const opacity = count === 0 ? 0.06 : 0.1 + (count / maxCount) * 0.8;
      const fill = count === 0 ? "var(--vscode-editorWidget-border, #444)" : "var(--vscode-charts-orange, #ffa94d)";
      const clickable = count > 0 ? ` class="heatmap-cell" data-day="${day}" data-hour="${hour}" style="cursor:pointer"` : "";
      out += `<rect${clickable} x="${(cellX + 1).toFixed(1)}" y="${(cellY + 1).toFixed(1)}" width="${(cellW - 2).toFixed(1)}" height="${(cellH - 2).toFixed(1)}" fill="${fill}" opacity="${opacity.toFixed(2)}" rx="1"><title>${HEATMAP_DAY_LABELS[day]} ${hour}:00 \u2014 ${count} commit${count !== 1 ? "s" : ""} (click to copy hashes)</title></rect>`;
    }
  }
  // Working-hours overlay: outline Mon\u2013Fri \u00d7 workdayStart..workdayEnd. Cells outside it visually pop as off-hours.
  // getDay() values: 0=Sun, 1=Mon \u2026 5=Fri, 6=Sat \u2014 so Mon\u2013Fri is rows 1..5.
  if (heatmapWorkdayEnd > heatmapWorkdayStart) {
    const ox = pad.left + heatmapWorkdayStart * cellW;
    const oy = top + 1 * cellH;
    const ow = (heatmapWorkdayEnd - heatmapWorkdayStart) * cellW;
    const oh = 5 * cellH;
    out += `<rect x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${ow.toFixed(1)}" height="${oh.toFixed(1)}" fill="none" stroke="var(--vscode-foreground)" stroke-width="1.5" stroke-dasharray="4 2" opacity="0.55" pointer-events="none"><title>Workday: Mon\u2013Fri ${heatmapWorkdayStart}:00\u2013${heatmapWorkdayEnd}:00</title></rect>`;
  }
  // Hour labels: 0, 6, 12, 18
  for (const h of [0, 6, 12, 18]) {
    const x = pad.left + h * cellW + cellW / 2;
    out += `<text x="${x.toFixed(1)}" y="${(top + bandH + 12).toFixed(1)}" text-anchor="middle" fill="var(--vscode-descriptionForeground)" font-size="9">${h}:00</text>`;
  }
  return out;
}

function renderYAxis(
  values: number[], top: number, bandH: number, plotW: number,
  count: number, format?: (v: number) => string,
): string {
  return _renderYAxis(values, top, bandH, plotW, count, PADDING, format);
}

function renderYAxisFromRange(
  min: number, max: number, top: number, bandH: number, plotW: number,
  count: number, format?: (v: number) => string,
): string {
  return _renderYAxisFromRange(min, max, top, bandH, plotW, count, PADDING, format);
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

// Heatmap cell click — copy commit hashes for that day+hour bucket
svg.addEventListener("click", (e: Event) => {
  const target = (e.target as SVGElement).closest?.(".heatmap-cell") as SVGElement | null;
  if (!target) { return; }
  e.stopPropagation();
  const day = parseInt(target.getAttribute("data-day") ?? "", 10);
  const hour = parseInt(target.getAttribute("data-hour") ?? "", 10);
  if (isNaN(day) || isNaN(hour)) { return; }
  const hashes = renderAllVisible
    .filter(d => {
      if (!d.hash) { return false; }
      if (!heatmapMatchesAuthorFilter(d)) { return false; }
      const local = committerLocalDayHour(d);
      return local.day === day && local.hour === hour;
    })
    .map(d => d.hash!);
  if (hashes.length === 0) { return; }
  navigator.clipboard.writeText(hashes.join("\n")).then(() => {
    showToast(`Copied ${hashes.length} hash${hashes.length !== 1 ? "es" : ""} (${HEATMAP_DAY_LABELS[day]} ${hour}:00)`);
  }).catch(() => { /* clipboard unavailable */ });
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

  let tooltipHtml = "";
  if (xAxisMode === "commit") {
    tooltipHtml += html`<div class="hash">${d.hash}</div>`;
    tooltipHtml += html`<div class="message">${d.message!}</div>`;
    tooltipHtml += html`<div class="author">${d.author!} · ${dateStr}</div>`;
  } else {
    tooltipHtml += `<div class="author">${dateStr} · ${d.commitCount} commit${d.commitCount !== 1 ? "s" : ""}</div>`;
  }
  tooltipHtml += `<div class="stat">`;
  if (sections.fileCount) {
    tooltipHtml += `Files in repo: ${d.cumulativeFileCount}<br>`;
    if (renderCompareSeries.length > 0) {
      for (let si = 0; si < renderCompareSeries.length; si++) {
        const s = renderCompareSeries[si];
        const color = compareColorForRepo(s.repoPath);
        tooltipHtml += html`<span style="color:${color}">● ${s.repoName}: ${s.values[idx]}</span><br>`;
      }
    }
  }
  if (sections.filesChanged) {
    tooltipHtml += `Changed: ${d.filesChanged} (<span class="added">+${d.filesAdded}</span> <span class="deleted">-${d.filesDeleted}</span>)<br>`;
  }
  if (sections.authors && xAxisMode === "commit") { tooltipHtml += `Authors (${authorWindowSize}): ${renderAuthorCounts[idx]}<br>`; }
  if (sections.authorConcentration && xAxisMode === "commit") { tooltipHtml += `Top-${authorTopX}: ${renderAuthorConcentration[idx].toFixed(0)}%<br>`; }
  if (sections.velocity) { tooltipHtml += `Commits/${xAxisMode === "commit" ? "day" : xAxisMode}: ${renderVelocity[idx]}<br>`; }
  if (sections.churn) { tooltipHtml += `Churn: ${renderChurn[idx].toFixed(1)}%<br>`; }
  if (sections.commitSize) { tooltipHtml += `Avg size: ${renderCommitSize[idx].toFixed(1)} files<br>`; }
  tooltipHtml += `</div>`;
  tooltip.innerHTML = tooltipHtml;
  positionTooltip(tooltip, chartContainer, me.clientX, me.clientY);
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

// ── X-axis mode ───────────────────────────────────────────────────────────────

function applyXAxisMode(mode: XAxisMode): void {
  xAxisMode = mode;
  xAxisSelect.value = mode;
  currentData = aggregateData(rawData, mode);
  zoomStack.length = 0;
  panCtrl.offset = Number.MAX_SAFE_INTEGER;
  derivedCache = null;
  updateCommitOnlyToggles();
  updateZoomSelect();
  renderWatchlist();
  render();
}

xAxisSelect.addEventListener("change", () => {
  applyXAxisMode(xAxisSelect.value as XAxisMode);
  sendConfig();
});

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
  zoomStack.push({ start: base + panCtrl.offset + lo, end: base + panCtrl.offset + hi });
  panCtrl.offset = 0;
  updateZoomSelect();
  render();
});

postMessage({ command: "ready" });
