import type { DiffSearchToWebview, DiffSearchFromWebview, DiffSearchHistoryEntry } from "./messages";

// acquireVsCodeApi is a global injected by VS Code into the webview context.
// @types/vscode-webview provides its declaration via tsconfig.webview.json.
const vscode = acquireVsCodeApi();

const form                 = document.getElementById("searchForm") as HTMLFormElement;
const patternInput         = document.getElementById("pattern") as HTMLInputElement;
const isRegexCheckbox      = document.getElementById("isRegex") as HTMLInputElement;
const caseInsensitiveCheckbox = document.getElementById("caseInsensitive") as HTMLInputElement;
const includePatternInput  = document.getElementById("includePattern") as HTMLInputElement;
const excludePatternInput  = document.getElementById("excludePattern") as HTMLInputElement;
const daysInput            = document.getElementById("daysInput") as HTMLInputElement;
const pendingOnlyCheckbox  = document.getElementById("pendingOnly") as HTMLInputElement;
const searchBtn            = document.getElementById("searchBtn") as HTMLButtonElement;
const statusDiv            = document.getElementById("status") as HTMLElement;
const batchProgressDiv     = document.getElementById("batchProgress") as HTMLElement;
const batchBarsDiv         = document.getElementById("batchBars") as HTMLElement;
const aggregateStatsDiv    = document.getElementById("aggregateStats") as HTMLElement;
const daysRow              = document.getElementById("daysRow") as HTMLElement;
const historySection       = document.getElementById("historySection") as HTMLElement;
const historyList          = document.getElementById("historyList") as HTMLElement;
const historyClearBtn      = document.getElementById("historyClearBtn") as HTMLButtonElement;

interface RepoState {
  commits: number;
  matches: number;
  pendingMatches: number;
  status: string;
}

const repoStates: Record<number, RepoState> = {};

function postMessage(msg: DiffSearchFromWebview): void {
  vscode.postMessage(msg);
}

// Validate regex on checkbox change
isRegexCheckbox.addEventListener("change", () => {
  if (isRegexCheckbox.checked) {
    validateRegex();
  } else {
    hideStatus();
  }
});

patternInput.addEventListener("input", () => {
  if (isRegexCheckbox.checked) {
    validateRegex();
  }
});

// Toggle days row when pending only checkbox changes
pendingOnlyCheckbox.addEventListener("change", () => {
  daysRow.style.display = pendingOnlyCheckbox.checked ? "none" : "";
  if (pendingOnlyCheckbox.checked) {
    hideStatus();
  } else if (!daysInput.value) {
    warnAboutFullHistory();
  }
});

// Show warning when days is cleared (unlimited)
daysInput.addEventListener("input", () => {
  if (!daysInput.value && !pendingOnlyCheckbox.checked) {
    warnAboutFullHistory();
  } else if (statusDiv.textContent?.includes("all history")) {
    hideStatus();
  }
});

function warnAboutFullHistory(){
  showStatus(
      "⚠️ Full history search is slow on large repos. Ballpark metrics - a minute per 1GB of .git folder size. The search will not die midway or eat all your RAM. Multiple repos run in parallel. ",
      "warning",
  );
}

function validateRegex(): void {
  try {
    new RegExp(patternInput.value);
    hideStatus();
    searchBtn.disabled = false;
  } catch (e) {
    showStatus("Invalid regex: " + (e as Error).message, "error");
    searchBtn.disabled = true;
  }
}

function showStatus(message: string, type = "info"): void {
  statusDiv.textContent = message;
  statusDiv.className = "status " + type;
  statusDiv.style.display = "block";
}

function hideStatus(): void {
  statusDiv.style.display = "none";
}

// Handle form submission
form.addEventListener("submit", (e: SubmitEvent) => {
  e.preventDefault();

  const pattern = patternInput.value.trim();
  if (!pattern) {
    showStatus("Please enter a search pattern", "error");
    return;
  }

  searchBtn.disabled = true;
  showStatus("Searching...", "info");
  const gitCommandEl = document.getElementById("gitCommand") as HTMLElement | null;
  if (gitCommandEl) { gitCommandEl.style.display = "none"; }

  postMessage({
    command: "search",
    pattern,
    isRegex: isRegexCheckbox.checked,
    caseInsensitive: caseInsensitiveCheckbox.checked,
    includePattern: includePatternInput.value.trim(),
    excludePattern: excludePatternInput.value.trim(),
    pendingOnly: pendingOnlyCheckbox.checked,
    days: pendingOnlyCheckbox.checked
      ? null
      : daysInput.value
        ? parseInt(daysInput.value)
        : null,
  });
});

// Handle messages from extension
window.addEventListener("message", (event: MessageEvent<DiffSearchToWebview>) => {
  const message = event.data;
  switch (message.command) {
    case "setHistory": {
      renderHistory(message.entries);
      break;
    }

    case "prefillParams": {
      const p = message.params;
      applyParams(p);
      break;
    }

    case "prefill":
      patternInput.value = message.pattern;
      patternInput.select();
      patternInput.focus();
      break;

    case "reposStarted": {
      // Initialize per-repo progress display
      for (const key in repoStates) { delete repoStates[Number(key)]; }
      batchBarsDiv.innerHTML = "";
      batchProgressDiv.style.display = "block";
      statusDiv.style.display = "none";

      for (let i = 0; i < message.repoCount; i++) {
        const repoName = message.repoNames[i];
        repoStates[i + 1] = { commits: 0, matches: 0, pendingMatches: 0, status: "Waiting" };

        const repoDiv = document.createElement("div");
        repoDiv.className = "batch-bar";
        repoDiv.id = "repo-" + (i + 1);
        repoDiv.innerHTML =
          '<div class="batch-bar-label">' +
            "<span>" + repoName + "</span>" +
            '<span id="repo-' + (i + 1) + '-stats" style="font-style: italic; color: var(--vscode-descriptionForeground);">Waiting...</span>' +
          "</div>";
        batchBarsDiv.appendChild(repoDiv);
      }

      aggregateStatsDiv.textContent = "Waiting...";
      break;
    }

    case "repoProgress":
      if (repoStates[message.repoIndex]) {
        repoStates[message.repoIndex].status = message.status;
        const statsSpan = document.getElementById("repo-" + message.repoIndex + "-stats");
        if (statsSpan) { statsSpan.textContent = message.status; }
      }
      break;

    case "repoComplete": {
      if (repoStates[message.repoIndex]) {
        repoStates[message.repoIndex] = {
          commits: message.commits,
          matches: message.matches,
          pendingMatches: message.pendingMatches,
          status: "Complete",
        };

        const statsSpan = document.getElementById("repo-" + message.repoIndex + "-stats");
        if (statsSpan) {
          const elapsed = message.elapsedMs !== null && message.elapsedMs !== undefined ? " — " + formatElapsed(message.elapsedMs) : "";
          const commitMatches = message.matches - message.pendingMatches;
          if (message.commits === 0 && message.pendingMatches === 0) {
            statsSpan.textContent = "No matches" + elapsed;
          } else {
            statsSpan.textContent =
              message.commits + " commits (" + commitMatches + " matches), " +
              message.pendingMatches + " pending" + elapsed;
          }
        }

        // Update aggregate stats
        let totalCommits = 0;
        let totalMatches = 0;
        let totalPending = 0;
        for (const repoIndex in repoStates) {
          totalCommits += repoStates[repoIndex].commits;
          totalMatches += repoStates[repoIndex].matches;
          totalPending += repoStates[repoIndex].pendingMatches;
        }

        if (totalCommits === 0 && totalPending === 0) {
          aggregateStatsDiv.textContent = "Total: No matches";
        } else {
          const totalCommitMatches = totalMatches - totalPending;
          aggregateStatsDiv.textContent =
            "Total: " + totalCommits + " commits (" + totalCommitMatches + " matches), " +
            totalPending + " pending";
        }
      }
      break;
    }

    case "searchComplete":
      searchBtn.disabled = false;
      showStatus(message.message, message.count > 0 ? "info" : "error");
      if (message.gitCommand) {
        const gitCommandEl = document.getElementById("gitCommand") as HTMLElement | null;
        if (gitCommandEl) {
          gitCommandEl.textContent = message.gitCommand;
          gitCommandEl.style.display = "block";
        }
      }
      break;
  }
});

historyClearBtn.addEventListener("click", () => {
  postMessage({ command: "clearHistory" });
});

function applyParams(p: import("./messages").DiffSearchParams): void {
  patternInput.value = p.pattern;
  isRegexCheckbox.checked = p.isRegex;
  caseInsensitiveCheckbox.checked = p.caseInsensitive;
  includePatternInput.value = p.includePattern;
  excludePatternInput.value = p.excludePattern;
  pendingOnlyCheckbox.checked = p.pendingOnly;
  daysRow.style.display = p.pendingOnly ? "none" : "";
  daysInput.value = p.days !== null ? String(p.days) : "";
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const m = Math.floor(diff / 60000);
  if (m < 1) { return "just now"; }
  if (m < 60) { return m + "m ago"; }
  const h = Math.floor(m / 60);
  if (h < 24) { return h + "h ago"; }
  return Math.floor(h / 24) + "d ago";
}

function renderHistory(entries: DiffSearchHistoryEntry[]): void {
  historyList.innerHTML = "";
  if (entries.length === 0) {
    historySection.style.display = "none";
    return;
  }
  historySection.style.display = "block";
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "history-entry";
    li.title = entry.label;

    const labelSpan = document.createElement("span");
    labelSpan.className = "history-label";
    labelSpan.textContent = entry.label;

    const timeSpan = document.createElement("span");
    timeSpan.className = "history-time";
    timeSpan.textContent = formatRelativeTime(entry.timestamp);

    li.appendChild(labelSpan);
    li.appendChild(timeSpan);
    li.addEventListener("click", () => {
      applyParams(entry.params);
      patternInput.focus();
    });
    historyList.appendChild(li);
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) { return ms + "ms"; }
  return (ms / 1000).toFixed(1) + "s";
}

postMessage({ command: "ready" });

patternInput.focus();
