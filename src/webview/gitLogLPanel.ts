import type { CommitData, GitLogLToWebview, GitLogLFromWebview } from "./messages";
import { renderAddedRemovedBars, renderYAxisFromRange, renderDateXAxis, type ChartPadding } from "./svgChartPrimitives";
import { PanController } from "./panController";

// acquireVsCodeApi is a global injected by VS Code into the webview context.
// @types/vscode-webview provides its declaration via tsconfig.webview.json.
const vscode = acquireVsCodeApi();

let commits: CommitData[] = [];
let selectedA: string | null = null;
let selectedB: string | null = null;
let focusedIndex = -1;

const timelineEl       = document.getElementById("timeline")!;
const compareBtn       = document.getElementById("compareBtn") as HTMLButtonElement;
const clearBtn         = document.getElementById("clearBtn") as HTMLButtonElement;
const prevBtn          = document.getElementById("prevBtn") as HTMLButtonElement;
const nextBtn          = document.getElementById("nextBtn") as HTMLButtonElement;
const expandAllBtn     = document.getElementById("expandAllBtn") as HTMLButtonElement;
const collapseAllBtn   = document.getElementById("collapseAllBtn") as HTMLButtonElement;
const selectionInfoEl  = document.getElementById("selectionInfo")!;
const titleEl          = document.getElementById("title")!;
const subtitleEl       = document.getElementById("subtitle")!;
const gitCommandEl     = document.getElementById("gitCommand")!;
const chartContainer   = document.getElementById("chartContainer")!;
const chartSection     = document.getElementById("chartSection")!;
const chartTooltip     = document.getElementById("chartTooltip")!;
const panScrollbar     = document.getElementById("panScrollbar")!;
const panThumb         = document.getElementById("panThumb")!;

function postMessage(msg: GitLogLFromWebview): void {
  vscode.postMessage(msg);
}

compareBtn.addEventListener("click", () => {
  if (selectedA && selectedB) {
    postMessage({ command: "compare", hashA: selectedA, hashB: selectedB });
  }
});

clearBtn.addEventListener("click", () => {
  selectedA = null;
  selectedB = null;
  updateSelectionInfo();
  refreshBadges();
});

prevBtn.addEventListener("click", () => navigate(-1));
nextBtn.addEventListener("click", () => navigate(1));

expandAllBtn.addEventListener("click", () => {
  timelineEl.querySelectorAll(".commit-row").forEach(r => r.classList.add("expanded"));
});

collapseAllBtn.addEventListener("click", () => {
  timelineEl.querySelectorAll(".commit-row").forEach(r => r.classList.remove("expanded"));
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  // Ignore shortcuts when focus is inside an input/textarea
  const tag = (e.target as Element).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") { return; }

  if (e.ctrlKey && e.key === "ArrowLeft") {
    e.preventDefault();
    navigate(-1);
  } else if (e.ctrlKey && e.key === "ArrowRight") {
    e.preventDefault();
    navigate(1);
  } else if (e.ctrlKey && e.key === "/") {
    e.preventDefault();
    timelineEl.querySelectorAll(".commit-row").forEach(r => {
      r.classList.remove("expanded");
      updateChevron(r);
    });
  } else if (e.ctrlKey && e.key === "*") {
    e.preventDefault();
    timelineEl.querySelectorAll(".commit-row").forEach(r => {
      r.classList.add("expanded");
      updateChevron(r);
    });
  }
});

window.addEventListener("message", (event: MessageEvent<GitLogLToWebview>) => {
  const msg = event.data;
  console.log("[gitLogL] received message:", msg.command, msg);
  if (msg.command === "setCommits") {
    commits = msg.commits;
    focusedIndex = commits.length > 0 ? 0 : -1;
    titleEl.textContent = (msg.mode === "fileHistory" ? "File History: " : "Git Log -L: ") + msg.label;
    subtitleEl.textContent =
      commits.length + " commit" + (commits.length === 1 ? "" : "s") +
      " — click a commit to select A / B for comparison";
    if (msg.gitCommand) { gitCommandEl.textContent = msg.gitCommand; }
    renderTimeline();
    renderChart();
    window.focus();
  }
});

function renderTimeline(): void {
  if (commits.length === 0) {
    timelineEl.innerHTML = '<div class="empty-state">No commits found for this range.</div>';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  prevBtn.disabled = false;
  nextBtn.disabled = false;

  timelineEl.innerHTML = "";
  commits.forEach((commit, idx) => {
    const row = document.createElement("div");
    row.className = "commit-row";
    row.dataset.hash = commit.hash;
    row.dataset.idx = String(idx);

    const date = new Date(commit.date);
    const dateStr =
      date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0");

    const header = document.createElement("div");
    header.className = "commit-header";
    const statHtml = (commit.added || commit.removed)
      ? `<span class="stat"><span class="stat-add">+${commit.added}</span> <span class="stat-del">-${commit.removed}</span></span>`
      : "";
    const renameHtml = commit.filePathAtCommit
      ? `<span class="rename" title="File was at ${escHtml(commit.filePathAtCommit)} in this commit">↪ ${escHtml(commit.filePathAtCommit)}</span>`
      : "";
    const msgTitle = commit.message.length > 60 ? ` title="${escHtml(commit.message)}"` : "";
    header.innerHTML =
      '<button class="ab-btn" data-action="ab" title="Mark as A or B for comparison">·</button>' +
      '<span class="chevron">▶</span>' +
      statHtml +
      '<span class="hash" data-action="openCommit" title="Open commit in multi-diff editor">' + escHtml(commit.shortHash) + "</span>" +
      `<span class="message"${msgTitle}>` + escHtml(commit.message || "(no message)") + "</span>" +
      renameHtml +
      '<span class="meta">' + escHtml(commit.author) + " · " + dateStr + "</span>";

    const hunkEl = document.createElement("div");
    hunkEl.className = "hunk";
    hunkEl.innerHTML = '<pre class="diff">' + renderHunk(commit.hunk) + "</pre>";

    row.appendChild(header);
    row.appendChild(hunkEl);

    header.querySelector<HTMLButtonElement>('[data-action="ab"]')!.addEventListener("click", e => {
      e.stopPropagation();
      onAbClick(commit.hash);
    });

    header.querySelector<HTMLElement>('[data-action="openCommit"]')!.addEventListener("click", e => {
      e.stopPropagation();
      postMessage({ command: "openCommit", hash: commit.hash });
    });

    header.addEventListener("click", (e: MouseEvent) => {
      if ((e.target as Element).closest('[data-action="ab"]')) { return; }
      if ((e.target as Element).closest('[data-action="openCommit"]')) { return; }
      row.classList.toggle("expanded");
      updateChevron(row);
    });

    timelineEl.appendChild(row);
  });

  updateSelectionInfo();
}

function onAbClick(hash: string): void {
  if (selectedA === hash) {
    selectedA = null;
  } else if (selectedB === hash) {
    selectedB = null;
  } else if (!selectedA) {
    selectedA = hash;
  } else if (!selectedB) {
    selectedB = hash;
  } else {
    selectedB = hash;
  }
  updateSelectionInfo();
  refreshBadges();
}

function refreshBadges(): void {
  timelineEl.querySelectorAll(".commit-row").forEach(row => {
    const hash = (row as HTMLElement).dataset.hash;
    const btn = row.querySelector<HTMLButtonElement>('[data-action="ab"]');
    if (!btn) { return; }
    if (hash === selectedA) {
      btn.className = "ab-btn sel-a";
      btn.textContent = "A";
    } else if (hash === selectedB) {
      btn.className = "ab-btn sel-b";
      btn.textContent = "B";
    } else {
      btn.className = "ab-btn";
      btn.textContent = "·";
    }
  });
}

function navigate(dir: number): void {
  const next = focusedIndex + dir;
  if (next < 0 || next >= commits.length) { return; }
  navigateTo(next, true);
}

function navigateTo(idx: number, expand: boolean): void {
  focusedIndex = idx;
  const rows = timelineEl.querySelectorAll(".commit-row");
  rows.forEach((r, i) => {
    r.classList.toggle("focused", i === idx);
    if (i === idx && expand) {
      r.classList.add("expanded");
      updateChevron(r);
      const stickyHeader = document.querySelector(".sticky-header");
      const headerHeight = stickyHeader ? stickyHeader.getBoundingClientRect().height : 0;
      const rowTop = r.getBoundingClientRect().top + window.scrollY;
      const scrollTarget = rowTop - headerHeight - 4;
      window.scrollTo({ top: scrollTarget, behavior: "smooth" });
    }
  });
}

function updateChevron(row: Element): void {
  const ch = row.querySelector(".chevron");
  if (ch) { ch.textContent = row.classList.contains("expanded") ? "▼" : "▶"; }
}

function updateSelectionInfo(): void {
  const a = selectedA ? commits.find(c => c.hash === selectedA) : null;
  const b = selectedB ? commits.find(c => c.hash === selectedB) : null;
  if (a && b) {
    selectionInfoEl.textContent = "A: " + a.shortHash + "  B: " + b.shortHash;
    compareBtn.disabled = false;
  } else if (a) {
    selectionInfoEl.textContent = "A: " + a.shortHash + "  — pick B";
    compareBtn.disabled = true;
  } else {
    selectionInfoEl.textContent = "";
    compareBtn.disabled = true;
  }
}

function renderHunk(hunk: string | null): string {
  if (!hunk) { return '<span style="opacity:0.4">(no diff — file added or rename only)</span>'; }
  return hunk.split("\n").map(line => {
    if (line.startsWith("@@")) { return '<span class="diff-hunk-header">' + escHtml(line) + "</span>"; }
    if (line.startsWith("+"))  { return '<span class="diff-add">' + escHtml(line) + "</span>"; }
    if (line.startsWith("-"))  { return '<span class="diff-del">' + escHtml(line) + "</span>"; }
    return '<span class="diff-ctx">' + escHtml(line) + "</span>";
  }).join("\n");
}

function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Line changes chart ────────────────────────────────────────────────────────

const CHART_PAD: ChartPadding = { top: 20, right: 40, bottom: 20, left: 40 };
const CHART_BAND_H = 100;
const MAX_VISIBLE_TICKS = 100;

// Chart state for tooltip interaction
let chartChronological: CommitData[] = [];  // full chronological array
let chartXStep = 0;
let chartSvgEl: SVGSVGElement | null = null;
let chartPageStart = 0;   // index into chartChronological where visible window starts
let chartPageCount = 0;   // how many ticks are currently rendered
const panCtrl = new PanController(
  panScrollbar, panThumb, chartContainer,
  () => renderChart(),
  () => chartChronological.length,
  () => MAX_VISIBLE_TICKS,
);

function renderChart(): void {
  // Only show in file history mode and when there's data with line changes
  const hasLineData = commits.some(c => c.added > 0 || c.removed > 0);
  if (!hasLineData || commits.length < 2) {
    chartSection.style.display = "none";
    panCtrl.update(0);
    return;
  }
  chartSection.style.display = "";

  // Commits come newest-first; reverse for chronological chart (oldest → newest)
  chartChronological = [...commits].reverse();
  const totalN = chartChronological.length;

  // ── Page window (limit rendered ticks, rest via horizontal pan) ──────────
  chartPageStart = panCtrl.update(totalN);
  chartPageCount = Math.min(MAX_VISIBLE_TICKS, totalN);

  const pageCommits = chartChronological.slice(chartPageStart, chartPageStart + chartPageCount);
  const n = pageCommits.length;

  const containerWidth = chartContainer.clientWidth || 600;
  const svgW = Math.max(containerWidth, 200);
  const plotW = svgW - CHART_PAD.left - CHART_PAD.right;
  chartXStep = n > 1 ? plotW / (n - 1) : plotW;
  const svgH = CHART_PAD.top + CHART_BAND_H + CHART_PAD.bottom;

  const data = pageCommits.map(c => ({ added: c.added, removed: c.removed }));
  const maxTotal = Math.max(...data.map(d => d.added + d.removed), 1);

  let svg = `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">`;

  // Bars: added/removed
  svg += renderAddedRemovedBars(data, CHART_PAD.top, CHART_BAND_H, plotW, n, chartXStep, CHART_PAD);

  // Left Y-axis: bar scale (added+removed)
  svg += renderYAxisFromRange(0, maxTotal, CHART_PAD.top, CHART_BAND_H, plotW, 3, CHART_PAD);

  // X-axis date labels
  svg += renderDateXAxis(
    pageCommits.map(c => c.date), n, chartXStep, svgH, CHART_PAD, 8,
  );

  // Crosshair
  svg += `<line id="chartCrosshair" x1="0" y1="${CHART_PAD.top}" x2="0" y2="${CHART_PAD.top + CHART_BAND_H}" stroke="var(--vscode-foreground)" stroke-width="0.5" opacity="0.5" style="display:none"/>`;

  // Hit area
  svg += `<rect id="chartHitArea" x="${CHART_PAD.left}" y="${CHART_PAD.top}" width="${plotW}" height="${CHART_BAND_H}" fill="transparent" style="cursor:crosshair"/>`;

  svg += "</svg>";
  chartContainer.querySelector("svg")?.remove();
  chartContainer.insertAdjacentHTML("afterbegin", svg);
  chartSvgEl = chartContainer.querySelector("svg");

  // Wire up interactions on current svg
  if (chartSvgEl) {
    chartSvgEl.addEventListener("mousemove", onChartMouseMove);
    chartSvgEl.addEventListener("mouseleave", onChartMouseLeave);
    chartSvgEl.addEventListener("click", onChartClick);
  }
}

function chartXToIdx(clientX: number): number {
  if (!chartSvgEl || chartPageCount === 0) { return -1; }
  const rect = chartSvgEl.getBoundingClientRect();
  const svgX = (clientX - rect.left) / rect.width * (chartSvgEl.viewBox.baseVal.width);
  const dataX = svgX - CHART_PAD.left;
  const localIdx = Math.round(dataX / chartXStep);
  if (localIdx < 0 || localIdx >= chartPageCount) { return -1; }
  return chartPageStart + localIdx;  // return index into full chronological array
}

function onChartMouseMove(e: Event): void {
  const me = e as MouseEvent;
  const target = me.target as SVGElement;
  if (target.id !== "chartHitArea") { return; }

  const idx = chartXToIdx(me.clientX);
  if (idx < 0 || idx >= chartChronological.length) { return; }
  const c = chartChronological[idx];
  const localIdx = idx - chartPageStart;
  const x = CHART_PAD.left + localIdx * chartXStep;

  // Crosshair
  const crosshair = document.getElementById("chartCrosshair");
  if (crosshair) {
    crosshair.setAttribute("x1", String(x));
    crosshair.setAttribute("x2", String(x));
    crosshair.style.display = "";
  }

  // Tooltip
  const date = new Date(c.date);
  const dateStr = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  let html = `<div class="hash">${escHtml(c.shortHash)}</div>`;
  html += `<div class="message">${escHtml(c.message || "(no message)")}</div>`;
  html += `<div class="author">${escHtml(c.author)} · ${dateStr}</div>`;
  html += `<div class="stat"><span class="added">+${c.added}</span> <span class="deleted">-${c.removed}</span></div>`;
  chartTooltip.innerHTML = html;
  chartTooltip.style.display = "block";

  const cRect = chartContainer.getBoundingClientRect();
  const tooltipW = chartTooltip.offsetWidth;
  let tooltipX = me.clientX - cRect.left + 12;
  if (tooltipX + tooltipW > cRect.width) {
    tooltipX = me.clientX - cRect.left - tooltipW - 12;
  }
  chartTooltip.style.left = tooltipX + "px";
  chartTooltip.style.top = (me.clientY - cRect.top - chartTooltip.offsetHeight - 8) + "px";
}

function onChartMouseLeave(): void {
  const crosshair = document.getElementById("chartCrosshair");
  if (crosshair) { crosshair.style.display = "none"; }
  chartTooltip.style.display = "none";
}

function onChartClick(e: Event): void {
  const me = e as MouseEvent;
  const target = me.target as SVGElement;
  if (target.id !== "chartHitArea") { return; }

  const idx = chartXToIdx(me.clientX);
  if (idx < 0 || idx >= chartChronological.length) { return; }

  // Find this commit in the original (newest-first) timeline and navigate to it
  const hash = chartChronological[idx].hash;
  const timelineIdx = commits.findIndex(c => c.hash === hash);
  if (timelineIdx >= 0) { navigateTo(timelineIdx, true); }
}

const chartResizeObserver = new ResizeObserver(() => {
  if (commits.length > 0) { renderChart(); }
});
chartResizeObserver.observe(chartContainer);

postMessage({ command: "ready" });
console.log("[gitLogL] sent ready message");
