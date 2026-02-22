import type { CommitData, GitLogLToWebview, GitLogLFromWebview } from "./messages";

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

postMessage({ command: "ready" });
console.log("[gitLogL] sent ready message");
