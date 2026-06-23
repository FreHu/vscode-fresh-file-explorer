import { html } from "../utils/templateHelpers";
import { showStatusFor, hideStatusFor } from "./webviewUtils";

const vscode = acquireVsCodeApi();

const benchmarkSelect = document.getElementById("benchmark")   as HTMLSelectElement;
const inputFormDiv    = document.getElementById("inputForm")   as HTMLDivElement;
const runBtn          = document.getElementById("runBtn")      as HTMLButtonElement;
const statusDiv       = document.getElementById("status")      as HTMLDivElement;
const resultsDiv      = document.getElementById("results")     as HTMLDivElement;
const statsBtn        = document.getElementById("statsBtn")    as HTMLButtonElement;
const statsStatus     = document.getElementById("statsStatus") as HTMLDivElement;
const statsSection    = document.getElementById("statsSection") as HTMLDivElement;
const cacheStatsBtn     = document.getElementById("cacheStatsBtn")     as HTMLButtonElement;
const cacheStatsStatus  = document.getElementById("cacheStatsStatus")  as HTMLDivElement;
const cacheStatsSection = document.getElementById("cacheStatsSection") as HTMLDivElement;


import type { 
  BenchmarkColumnSpec, 
  BenchmarkInputSpec, 
  BenchmarkOutputSpec, 
  BenchmarkInputValues, 
  BenchmarkOutputRow 
} from "../benchmark/benchmark";

interface SerializableBenchmark {
  name: string;
  inputSpec:  BenchmarkInputSpec;
  outputSpec: BenchmarkOutputSpec;
}

interface BenchmarksMessage { command: "benchmarks"; benchmarks: SerializableBenchmark[]; }
interface ResultsMessage    { command: "results";    columns: BenchmarkColumnSpec[]; rows: BenchmarkOutputRow[]; }
interface ErrorMessage      { command: "error";      message: string; }
interface StatsMessage      { command: "stats";      stats: RepoStats[]; }
interface StatsErrMessage   { command: "statsError"; message: string; }
interface CacheStatsMessage { command: "cacheStats";      stats: CacheRepoStats[]; }
interface CacheStatsErrMsg  { command: "cacheStatsError"; message: string; }

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

interface CacheRepoStats {
  repoLabel: string;
  repoPath: string;
  entryCount: number;
  sizeBytes: number;
}

let benchmarks: SerializableBenchmark[] = [];

benchmarkSelect.addEventListener("change", () => {
  const bm = benchmarks.find(b => b.name === benchmarkSelect.value);
  if (bm) { renderInputForm(bm); }
});

function renderInputForm(bm: SerializableBenchmark) {
  inputFormDiv.innerHTML = "";
  for (const param of bm.inputSpec.params) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.htmlFor = `param-${param.name}`;
    label.textContent = param.name;
    group.appendChild(label);

    if (param.type === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `param-${param.name}`;
      input.checked = Boolean(param.default ?? false);
      group.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.id = `param-${param.name}`;
      input.value = String(param.default ?? "");
      if (param.multi) { input.placeholder = "comma-separated, e.g. 7,30,90"; }
      group.appendChild(input);
    }

    inputFormDiv.appendChild(group);
  }
}

function collectInputs(bm: SerializableBenchmark): BenchmarkInputValues {
  const inputs: BenchmarkInputValues = {};
  for (const param of bm.inputSpec.params) {
    const el = document.getElementById(`param-${param.name}`);
    if (!el) { continue; }
    if (param.type === "boolean") {
      inputs[param.name] = (el as HTMLInputElement).checked;
    } else if (param.type === "number" && !param.multi) {
      inputs[param.name] = parseFloat((el as HTMLInputElement).value) || 0;
    } else {
      // multi params and string params: pass the raw string so expandMultiParams can split it
      inputs[param.name] = (el as HTMLInputElement).value;
    }
  }
  return inputs;
}

runBtn.addEventListener("click", () => {
  const bm = benchmarks.find(b => b.name === benchmarkSelect.value);
  if (!bm) { return; }
  const inputs = collectInputs(bm);
  runBtn.disabled = true;
  resultsDiv.style.display = "none";
  resultsDiv.innerHTML = "";
  showStatus("Running…", "info");
  vscode.postMessage({ command: "run", benchmarkName: bm.name, inputs });
});

statsBtn.addEventListener("click", () => {
  statsBtn.disabled = true;
  statsSection.style.display = "none";
  statsSection.innerHTML = "";
  showStatsStatus("Loading…", "info");
  vscode.postMessage({ command: "getStats" });
});
cacheStatsBtn.addEventListener("click", () => {
  cacheStatsBtn.disabled = true;
  cacheStatsSection.style.display = "none";
  cacheStatsSection.innerHTML = "";
  showCacheStatsStatus("Loading\u2026", "info");
  vscode.postMessage({ command: "getCacheStats" });
});

window.addEventListener("message", (event: MessageEvent<BenchmarksMessage | ResultsMessage | ErrorMessage | StatsMessage | StatsErrMessage | CacheStatsMessage | CacheStatsErrMsg>) => {
  const msg = event.data;
  if (msg.command === "benchmarks") {
    benchmarks = msg.benchmarks;
    benchmarkSelect.innerHTML = "";
    if (benchmarks.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No benchmarks defined";
      opt.disabled = true;
      opt.selected = true;
      benchmarkSelect.appendChild(opt);
      inputFormDiv.innerHTML = `<p class="help-text" style="font-style:italic;">No benchmarks are currently defined. Add a <code>Benchmark</code> to <code>PerfBenchmarkPanel._initialize()</code> to run one here.</p>`;
    } else {
      for (const bm of benchmarks) {
        const opt = document.createElement("option");
        opt.value = bm.name;
        opt.textContent = bm.name;
        benchmarkSelect.appendChild(opt);
      }
      renderInputForm(benchmarks[0]);
      runBtn.disabled = false;
    }
    return;
  }
  if (msg.command === "error") {
    showStatus(msg.message, "error");
    runBtn.disabled = false;
    return;
  }
  if (msg.command === "results") {
    renderResults(msg.columns, msg.rows);
    runBtn.disabled = false;
    return;
  }
  if (msg.command === "statsError") {
    showStatsStatus(msg.message, "error");
    statsBtn.disabled = false;
    return;
  }
  if (msg.command === "stats") {
    renderStats(msg.stats);
    statsBtn.disabled = false;
  }
  if (msg.command === "cacheStatsError") {
    showCacheStatsStatus(msg.message, "error");
    cacheStatsBtn.disabled = false;
  }
  if (msg.command === "cacheStats") {
    renderCacheStats(msg.stats);
    cacheStatsBtn.disabled = false;
  }
});

// Signal the extension host that the webview is ready to receive messages
vscode.postMessage({ command: "ready" });

function renderResults(columns: BenchmarkColumnSpec[], rows: BenchmarkOutputRow[]) {
  resultsDiv.innerHTML = "";

  const table = document.createElement("table");

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.name;
    if (col.type === "number") { th.className = "num"; }
    headerRow.appendChild(th);
    if (col.comparison) {
      const thCmp = document.createElement("th");
      thCmp.className = "num";
      thCmp.textContent = col.comparison === "ratioWithPrevious" ? `${col.name} ×` : `${col.name} Δ`;
      headerRow.appendChild(thCmp);
    }
  }

  const errorCol = columns.find(c => c.role === "error");
  const prevValues = new Map<string, number>();

  const tbody = table.createTBody();
  for (const row of rows) {
    const tr = tbody.insertRow();
    if (errorCol) {
      const errVal = row[errorCol.name];
      if (typeof errVal === "string" && errVal !== "") { tr.className = "error-row"; }
    }
    for (const col of columns) {
      const td = tr.insertCell();
      const val = row[col.name];
      if (col.type === "number") {
        td.className = "num";
        td.textContent = typeof val === "number" ? formatNumber(val, col.format) : String(val ?? "");
      } else {
        td.textContent = String(val ?? "");
      }
      if (col.comparison && typeof val === "number") {
        const tdCmp = tr.insertCell();
        tdCmp.className = "num";
        const prev = prevValues.get(col.name);
        if (prev === undefined || prev === 0) {
          tdCmp.textContent = "—";
        } else if (col.comparison === "ratioWithPrevious") {
          tdCmp.textContent = `${(val / prev).toFixed(2)}×`;
        } else {
          const diff = val - prev;
          tdCmp.textContent = (diff >= 0 ? "+" : "") + formatNumber(diff, col.format);
        }
        prevValues.set(col.name, val);
      }
    }
  }

  resultsDiv.appendChild(table);
  hideStatus();
  resultsDiv.style.display = "";
}

function formatNumber(val: number, format: BenchmarkColumnSpec["format"]): string {
  if (format === "bytes") {
    if (val < 1024) { return `${val} B`; }
    if (val < 1024 * 1024) { return `${(val / 1024).toFixed(1)} KB`; }
    return `${(val / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (format === "duration-ms") { return `${val.toLocaleString()} ms`; }
  return val.toLocaleString();
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

    const cgDiv = document.createElement("div");
    cgDiv.style.marginTop = "12px";
    cgDiv.innerHTML = html`
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
      <pre class="code-hint">${s.commitGraphPath}</pre>
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

function showStatus(message: string, type: "info" | "error") { showStatusFor(statusDiv, message, type); }
function hideStatus() { hideStatusFor(statusDiv); }

function showStatsStatus(message: string, type: "info" | "error") { showStatusFor(statsStatus, message, type); }
function hideStatsStatus() { hideStatusFor(statsStatus); }

function showCacheStatsStatus(message: string, type: "info" | "error") { showStatusFor(cacheStatsStatus, message, type); }
function hideCacheStatsStatus() { hideStatusFor(cacheStatsStatus); }

function renderCacheStats(stats: CacheRepoStats[]) {
  hideCacheStatsStatus();
  cacheStatsSection.innerHTML = "";

  if (stats.length === 0 || stats.every(s => s.entryCount === 0)) {
    const msg = document.createElement("p");
    msg.style.color = "var(--vscode-descriptionForeground)";
    msg.textContent = "Cache is empty. Load the tree first to populate the cache.";
    cacheStatsSection.appendChild(msg);
    cacheStatsSection.style.display = "";
    return;
  }

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

    const rows: [string, string][] = [
      ["Cached entries", s.entryCount.toLocaleString()],
      ["Cache size",     formatNumber(s.sizeBytes, "bytes")],
    ];

    const table = document.createElement("table");
    table.className = "stats-table";
    const tbody = table.createTBody();
    for (const [label, value] of rows) {
      const tr = tbody.insertRow();
      const tdLabel = tr.insertCell();
      const tdValue = tr.insertCell();
      tdLabel.textContent = label;
      tdValue.textContent = value;
    }
    block.appendChild(table);
    cacheStatsSection.appendChild(block);
  }

  cacheStatsSection.style.display = "";
}
