import type { StonksToWebview, StonksFromWebview, StonksDataPoint, StonksConfig, XAxisMode, StonksRepoSeries, StonksRepoTicker } from "./messages";
import { EMPTY_FRAME, RenderedFrame, renderStonksTooltip } from "./stonksTooltip";
import { renderBands, renderXAxis } from "./stonksSections";
import { committerLocalDayHour, DAY_LABELS, heatmapAuthorFilter, HeatmapOptions } from "./stonksHeatmap";
import { PanController } from "./panController";
import { hideCrosshair, positionTooltip, showCrosshair } from "./webviewUtils";
import { aggregateStonksData as aggregateData } from "./stonksBucketing";
import { alignCompareSeries, computeBands, CompareLine, PADDING, SectionKey } from "./stonksLayout";
import { plural } from "../utils/plural";
import { computeDerivedSeries, DerivedSeries } from "./stonksDerivedSeries";

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

// What the last render drew (set in render, read by the module-level mouse handlers)
let frame: RenderedFrame = EMPTY_FRAME;

// Compare repos state
let compareRepos = false;
let compareSelectedPaths = new Set<string>();
let compareData: StonksRepoSeries[] = [];

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

const maxTicksInput = bindNumberInput("maxTicks", 100, 10000, v => { maxVisibleTicks = v; });

// ── Message handling ──────────────────────────────────────────────────────────

function handleSetRepos(repos: StonksRepoTicker[], selectedPath?: string): void {
  repoTickers = repos;
  // Adopt the host's selection — it survives webview recreation, ours doesn't.
  if (selectedPath && repos.some(r => r.path === selectedPath)) {
    selectedRepoPath = selectedPath;
  } else if (repos.length > 0 && !selectedRepoPath) {
    // Auto-select first repo if nothing selected yet
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
  const sectionDefaults: Record<SectionKey, boolean> = {
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
  if (maxTicksInput) { maxTicksInput.value = String(c.maxVisibleTicks); }
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

window.addEventListener("message", (event: MessageEvent<StonksToWebview>) => {
  const msg = event.data;
  switch (msg.command) {
    case "setRepos": handleSetRepos(msg.repos, msg.selectedPath); break;
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


// Section visibility state (all default checked)
const sections: Record<SectionKey, boolean> = {
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
const SECTION_TOGGLE_DEFS: { key: SectionKey; toggleId: string; sectionId?: string }[] = [
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
const COMMIT_ONLY_KEYS = new Set<SectionKey>(["authors", "authorConcentration", "activityHeatmap"]);

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

/** Wires a numeric input: a value in [min, max] goes to `apply`, then the config is saved and the chart re-rendered. */
function bindNumberInput(id: string, min: number, max: number, apply: (value: number) => void): HTMLInputElement | null {
  const input = document.getElementById(id) as HTMLInputElement | null;
  input?.addEventListener("change", () => {
    const value = parseInt(input.value, 10);
    if (value >= min && value <= max) {
      apply(value);
      sendConfig();
      render();
    }
  });
  return input;
}

const authorWindowSizeInput = bindNumberInput("authorWindowSize", 2, 100, v => { authorWindowSize = v; derivedCache = null; });
const authorTopXInput = bindNumberInput("authorTopX", 1, 10, v => { authorTopX = v; derivedCache = null; });
const commitSizeWindowInput = bindNumberInput("commitSizeWindowSize", 2, 100, v => { commitSizeWindowSize = v; derivedCache = null; });
const heatmapWorkdayStartInput = bindNumberInput("heatmapWorkdayStart", 0, 23, v => { heatmapWorkdayStart = v; });
const heatmapWorkdayEndInput = bindNumberInput("heatmapWorkdayEnd", 1, 24, v => { heatmapWorkdayEnd = v; });
const heatmapAuthorsContainer = document.getElementById("heatmapAuthors") as HTMLElement | null;

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
  series: DerivedSeries;
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
  if (!(derivedCache && derivedCache.data === currentData && derivedCache.zoomKey === zoomKey && derivedCache.topX === authorTopX && derivedCache.windowSize === authorWindowSize && derivedCache.commitSizeWindow === commitSizeWindowSize)) {
    const series = computeDerivedSeries(allVisible, xAxisMode, { authorWindow: authorWindowSize, topX: authorTopX, commitSizeWindow: commitSizeWindowSize });
    derivedCache = { data: currentData, zoomKey, topX: authorTopX, windowSize: authorWindowSize, commitSizeWindow: commitSizeWindowSize, series };
  }
  const derived = derivedCache.series;

  // ── Slice to page window ──────────────────────────────────────────────────
  const visibleData = allVisible.slice(pageStart, pageEnd);
  const counts = visibleData.map(d => d.cumulativeFileCount);
  const volumes = visibleData.map(d => d.filesChanged);
  const authorCounts = derived.authorCounts.slice(pageStart, pageEnd);
  const authorConcentration = derived.authorConcentration.slice(pageStart, pageEnd);
  const velocity = derived.velocity.slice(pageStart, pageEnd);
  const churn = derived.churn.slice(pageStart, pageEnd);
  const commitSize = derived.commitSize.slice(pageStart, pageEnd);

  // ── Compare repos: align other repos' fileCount to visible date buckets ───
  const isCompareActive = compareRepos && xAxisMode !== "commit" && compareData.length > 0;
  let compareSeries: CompareLine[] = [];
  if (isCompareActive) {
    compareSeries = alignCompareSeries(visibleData, compareData.filter(c => compareSelectedPaths.has(c.repoPath)), xAxisMode);
  }

  // Available height: viewport minus header/toggles/padding above the chart container
  // Reserve space for body bottom padding (20px) and pan scrollbar (16px) so nothing overflows
  const containerTop = chartContainer.getBoundingClientRect().top;
  const scrollbarReserve = allVisible.length > maxVisibleTicks ? 16 : 0;
  const bodyPaddingBottom = 20;
  const availableH = window.innerHeight - containerTop - scrollbarReserve - bodyPaddingBottom;

  const bands = computeBands(availableH, sections, xAxisMode, { authorWindow: authorWindowSize, topX: authorTopX, commitSizeWindow: commitSizeWindowSize });
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

  const geometry = { plotW, n, xStep };
  svgContent += renderXAxis(visibleData, geometry);
  svgContent += renderBands(bands, {
    visibleData, allVisible, counts, volumes, authorCounts, authorConcentration, velocity, churn, commitSize,
    compareLines: compareSeries, colorForRepo: compareColorForRepo, heatmap: heatmapOptions(),
  }, geometry);

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
  frame = { visibleData, allVisible, authorCounts, authorConcentration, velocity, churn, commitSize, compareLines: compareSeries };

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

/** The heatmap's author filter and workday outline from the current settings. */
function heatmapOptions(): HeatmapOptions {
  return { matches: heatmapAuthorFilter(heatmapSelectedAuthors, heatmapHoverAuthor), workdayStart: heatmapWorkdayStart, workdayEnd: heatmapWorkdayEnd };
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
  const { matches } = heatmapOptions();
  const hashes = frame.allVisible
    .filter(d => {
      if (!d.hash) { return false; }
      if (!matches(d)) { return false; }
      const local = committerLocalDayHour(d);
      return local.day === day && local.hour === hour;
    })
    .map(d => d.hash!);
  if (hashes.length === 0) { return; }
  navigator.clipboard.writeText(hashes.join("\n")).then(() => {
    showToast(`Copied ${plural(hashes.length, "hash", "hashes")} (${DAY_LABELS[day]} ${hour}:00)`);
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
  if (idx < 0 || idx >= frame.visibleData.length) { return; }
  const x = PADDING.left + idx * chartXStep;

  showCrosshair("crosshair", x);
  tooltip.innerHTML = renderStonksTooltip(frame, idx, {
    mode: xAxisMode, sections, authorWindow: authorWindowSize, topX: authorTopX, colorForRepo: compareColorForRepo,
  });
  positionTooltip(tooltip, chartContainer, me.clientX, me.clientY);
});

svg.addEventListener("mouseleave", () => {
  if (!isDragging) {
    hideCrosshair("crosshair");
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
  if (overlay) { overlay.style.display = "none"; }
  hideCrosshair("crosshair");
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
