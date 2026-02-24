const vscode = acquireVsCodeApi();

const rangesInput   = document.getElementById("ranges")       as HTMLInputElement;
const modeSelect    = document.getElementById("mode")         as HTMLSelectElement;
const pathspecInput = document.getElementById("pathspec")     as HTMLInputElement;
const runBtn        = document.getElementById("runBtn")       as HTMLButtonElement;
const statusDiv     = document.getElementById("status")       as HTMLDivElement;
const resultsDiv    = document.getElementById("results")      as HTMLDivElement;
const statsBtn      = document.getElementById("statsBtn")     as HTMLButtonElement;
const statsStatus   = document.getElementById("statsStatus")  as HTMLDivElement;
const statsSection  = document.getElementById("statsSection") as HTMLDivElement;

interface BenchmarkResult {
  days: number;
  mode: "log" | "numstat";
  repoLabel: string;
  elapsedMs: number;
  lines: number;
  bytes: number;
  error?: string;
}

interface RepoStats {
  repoLabel: string;
  repoPath: string;
  commitCount: number | null;
  oldestCommitDate: string | null;
  authorCount: number | null;
  currentBranch: string | null;
  hasCommitGraph: boolean;
  commitGraphPath: string;
  error?: string;
}

interface ResultsMessage  { command: "results";    results: BenchmarkResult[]; }
interface ErrorMessage    { command: "error";      message: string; }
interface StatsMessage    { command: "stats";      stats: RepoStats[]; }
interface StatsErrMessage { command: "statsError"; message: string; }

statsBtn.addEventListener("click", () => {
  statsBtn.disabled = true;
  statsSection.style.display = "none";
  statsSection.innerHTML = "";
  showStatsStatus("Loading…", "info");
  vscode.postMessage({ command: "getStats" });
});

runBtn.addEventListener("click", () => {
  const raw = rangesInput.value.trim();
  if (!raw) {
    showStatus("Enter at least one day range.", "error");
    return;
  }

  const ranges = raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  if (ranges.length === 0) {
    showStatus("No valid day ranges found. Use comma-separated numbers like: 1,3,7,30", "error");
    return;
  }

  runBtn.disabled = true;
  resultsDiv.style.display = "none";
  resultsDiv.innerHTML = "";
  showStatus(`Running ${ranges.length} range(s)…`, "info");

  vscode.postMessage({ command: "run", ranges, mode: modeSelect.value, pathspec: pathspecInput.value.trim() });
});

window.addEventListener("message", (event: MessageEvent<ResultsMessage | ErrorMessage | StatsMessage | StatsErrMessage>) => {
  const msg = event.data;
  if (msg.command === "error") {
    showStatus(msg.message, "error");
    runBtn.disabled = false;
    return;
  }
  if (msg.command === "results") {
    renderResults(msg.results);
    runBtn.disabled = false;
  }
  if (msg.command === "statsError") {
    showStatsStatus(msg.message, "error");
    statsBtn.disabled = false;
  }
  if (msg.command === "stats") {
    renderStats(msg.stats);
    statsBtn.disabled = false;
  }
});

function renderResults(results: BenchmarkResult[]) {
  resultsDiv.innerHTML = "";

  // Group results by repo, preserving insertion order
  const repoOrder: string[] = [];
  const byRepo = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    if (!byRepo.has(r.repoLabel)) {
      repoOrder.push(r.repoLabel);
      byRepo.set(r.repoLabel, []);
    }
    byRepo.get(r.repoLabel)!.push(r);
  }

  const multiRepo = repoOrder.length > 1;

  for (const repoLabel of repoOrder) {
    const repoResults = byRepo.get(repoLabel)!;

    if (multiRepo) {
      const h3 = document.createElement("h3");
      h3.style.cssText = "margin: 20px 0 6px; font-size: 1em;";
      h3.textContent = repoLabel;
      resultsDiv.appendChild(h3);
    }

    const table = document.createElement("table");
    table.innerHTML = `
      <thead><tr>
        <th>Days</th>
        <th>Mode</th>
        <th class="num">Elapsed (ms)</th>
        <th class="num">Time ×</th>
        <th class="num">Lines</th>
        <th class="num">Size</th>
        <th class="num">Size ×</th>
      </tr></thead>`;
    const tbody = table.createTBody();

    const prevByMode = new Map<string, BenchmarkResult>();

    for (const r of repoResults) {
      const tr = tbody.insertRow();
      if (r.error) {
        tr.className = "error-row";
        tr.innerHTML = `
          <td>${r.days}d</td>
          <td>${r.mode}</td>
          <td class="num" colspan="5">${escHtml(r.error)}</td>
        `;
      } else {
        const prev = prevByMode.get(r.mode);
        const timeRatioCell = prev ? ratioCell(r.elapsedMs, prev.elapsedMs, r.days, prev.days) : `<td class="num">—</td>`;
        const sizeRatioCell = prev ? ratioCell(r.bytes,     prev.bytes,     r.days, prev.days) : `<td class="num">—</td>`;
        prevByMode.set(r.mode, r);
        tr.innerHTML = `
          <td>${r.days}d</td>
          <td>${r.mode}</td>
          <td class="num">${r.elapsedMs.toLocaleString()}</td>
          ${timeRatioCell}
          <td class="num">${r.lines.toLocaleString()}</td>
          <td class="num">${formatSize(r.bytes)}</td>
          ${sizeRatioCell}
        `;
      }
    }

    resultsDiv.appendChild(table);
  }

  hideStatus();
  resultsDiv.style.display = "";
}

/**
 * Build a colored ratio cell.
 * actual / prev compared to expectedNumerator / expectedDenominator (the range ratio).
 * Sub-linear → green, ~linear ±20% → neutral, super-linear → red.
 */
function ratioCell(actual: number, prev: number, days: number, prevDays: number): string {
  if (prev === 0) { return `<td class="num">—</td>`; }
  const rangeRatio = days / prevDays;
  const actualRatio = actual / prev;
  const relative = actualRatio / rangeRatio; // 1.0 = perfectly linear
  const cls = relative < 0.85 ? "ratio-sub" : relative > 1.2 ? "ratio-sup" : "ratio-lin";
  const label = actualRatio.toFixed(2) + "×";
  const expected = `<span class="ratio-expected">(exp ${rangeRatio.toFixed(2)}×)</span>`;
  return `<td class="num ratio ${cls}">${label}${expected}</td>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderStats(stats: RepoStats[]) {
  hideStatsStatus();
  statsSection.innerHTML = "";

  for (const s of stats) {
    const block = document.createElement("div");
    block.style.marginBottom = "24px";

    if (stats.length > 1) {
      const heading = document.createElement("h3");
      heading.style.margin = "0 0 8px";
      heading.style.fontSize = "1em";
      heading.textContent = s.repoLabel;
      block.appendChild(heading);
    }

    if (s.error) {
      const err = document.createElement("p");
      err.style.color = "var(--vscode-errorForeground)";
      err.textContent = s.error;
      block.appendChild(err);
      statsSection.appendChild(block);
      continue;
    }

    const rows: [string, string][] = [
      ["Branch",          s.currentBranch  ?? "—"],
      ["Total commits",   s.commitCount !== null ? s.commitCount.toLocaleString() : "—"],
      ["Contributors",    s.authorCount !== null ? s.authorCount.toLocaleString() : "—"],
      ["Oldest commit",   s.oldestCommitDate ? formatDate(s.oldestCommitDate) : "—"],
      ["Commit-graph",    s.hasCommitGraph ? "✔ present" : "✘ not found"],
    ];

    const table = document.createElement("table");
    table.className = "stats-table";
    const tbody = table.createTBody();
    for (const [label, value] of rows) {
      const tr = tbody.insertRow();
      const tdLabel = tr.insertCell();
      const tdValue = tr.insertCell();
      tdLabel.textContent = label;
      if (label === "Commit-graph") {
        tdValue.className = s.hasCommitGraph ? "commit-graph-yes" : "commit-graph-no";
      }
      tdValue.textContent = value;
    }
    block.appendChild(table);

    // Commit-graph hints
    const cgDiv = document.createElement("div");
    cgDiv.style.marginTop = "12px";
    cgDiv.innerHTML = `
      <p class="code-hint-label">Build / refresh commit-graph:</p>
      <pre class="code-hint">git commit-graph write --reachable --changed-paths</pre>
      <p class="code-hint-label">Enable automatic background maintenance:</p>
      <pre class="code-hint">git maintenance start</pre>
      <p class="code-hint-label" style="font-weight:normal;font-size:0.82em;">Registers a scheduled task (cron / Windows Task Scheduler) that runs hourly, daily, and weekly jobs.
The commit-graph is kept up to date as part of those jobs. The schedule persists across reboots.
Note: this only registers the schedule — nothing runs immediately.</p>
      <p class="code-hint-label">Schedule + run everything immediately:</p>
      <pre class="code-hint">git maintenance start
git maintenance run --task=commit-graph --task=loose-objects --task=incremental-repack</pre>
      <p class="code-hint-label" style="font-weight:normal;font-size:0.82em;">Runs the same jobs the scheduler would eventually trigger, without waiting.</p>
      <p class="code-hint-label">Stop automatic maintenance (does NOT delete the commit-graph):</p>
      <pre class="code-hint">git maintenance stop</pre>
      <p class="code-hint-label" style="font-weight:normal;font-size:0.82em;">Only unregisters the scheduled tasks. The commit-graph file stays on disk and git keeps using it.</p>
      <p class="code-hint-label">Manually delete the commit-graph file:</p>
      <pre class="code-hint">${escHtml(s.commitGraphPath)}</pre>
    `;
    block.appendChild(cgDiv);
    statsSection.appendChild(block);
  }

  statsSection.style.display = "";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

function showStatus(message: string, type: "info" | "error") {
  statusDiv.textContent = message;
  statusDiv.style.color = type === "error" ? "var(--vscode-errorForeground)" : "var(--vscode-descriptionForeground)";
  statusDiv.style.display = "";
}

function hideStatus() { statusDiv.style.display = "none"; }

function showStatsStatus(message: string, type: "info" | "error") {
  statsStatus.textContent = message;
  statsStatus.style.color = type === "error" ? "var(--vscode-errorForeground)" : "var(--vscode-descriptionForeground)";
  statsStatus.style.display = "";
}

function hideStatsStatus() { statsStatus.style.display = "none"; }
