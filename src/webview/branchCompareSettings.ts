import type {
  BranchCompareSettingsToWebview,
  BranchCompareSettingsFromWebview,
  RefDTO,
  RefValidationResult,
  RepoDTO,
  SavedComparisonDTO,
} from "./messages";
import { enableListDragDrop } from "./listDragDrop";
import { GROUPING_MODE_OPTIONS } from "../fresh-files/groupingMode";
import type { GroupingMode } from "../fresh-files/groupingMode";

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

let repos: RepoDTO[] = [];
let comparisons: SavedComparisonDTO[] = [];
/** Per-repo cached branches map. Populated on demand from `requestRefs`. */
const refsCache = new Map<string, RefDTO[]>();
/** Repos for which a refs fetch is already in flight. */
const refsPending = new Set<string>();

/**
 * Validation cache keyed by `${repo}::${ref}`. Local-only entries (HEAD,
 * exact branch match) are computed instantly without round-tripping. Async
 * entries (commit hashes, ref expressions, typos) live here as `pending`
 * until the host responds with a `refValidation` message.
 */
type ValidationState =
  | { state: "valid"; resolvedSha?: string }
  | { state: "invalid"; message: string }
  | { state: "checking" };
const validationState = new Map<string, ValidationState>();
/** Refs we've already asked the host to validate this session — avoid duplicate sends. */
const validationRequested = new Set<string>();
/** Pending debounce timers, keyed by input element. */
const validationTimers = new WeakMap<HTMLInputElement, ReturnType<typeof setTimeout>>();
const VALIDATION_DEBOUNCE_MS = 400;

const tableBody = document.getElementById("comparisonsBody") as HTMLTableSectionElement;
const addBtn = document.getElementById("addBtn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
const dupWarning = document.getElementById("dupWarning") as HTMLElement;
const dupWarningText = document.getElementById("dupWarningText") as HTMLElement;
const batchGrouping = document.getElementById("batchGrouping") as HTMLSelectElement;

// Sentinel option value used when comparisons don't all share one grouping mode.
const MIXED_GROUPING = "__mixed__";

// Populate the batch select once: a "(mixed)" placeholder plus one option per
// grouping mode. Labels are plain text — codicon `$(...)` markup doesn't render
// inside <option>.
batchGrouping.appendChild(new Option("(mixed)", MIXED_GROUPING));
for (const opt of GROUPING_MODE_OPTIONS) {
  batchGrouping.appendChild(new Option(opt.label, opt.mode));
}
batchGrouping.addEventListener("change", () => {
  const mode = batchGrouping.value;
  if (mode === MIXED_GROUPING) { return; }
  send({ command: "setAllGroupingMode", mode: mode as GroupingMode });
});

/** Build a per-row grouping <select>, pre-selected to `current`. */
function groupingSelect(current: GroupingMode | undefined, onChange: (mode: GroupingMode) => void): HTMLSelectElement {
  const select = document.createElement("select");
  for (const opt of GROUPING_MODE_OPTIONS) {
    const o = new Option(opt.label, opt.mode);
    if (opt.mode === current) { o.selected = true; }
    select.appendChild(o);
  }
  select.addEventListener("change", () => onChange(select.value as GroupingMode));
  return select;
}

/** Reflect the comparisons' shared grouping mode in the batch select, or "(mixed)". */
function syncBatchGrouping(): void {
  const modes = new Set(comparisons.map(c => c.groupingMode));
  batchGrouping.value = modes.size === 1 ? (comparisons[0]?.groupingMode ?? MIXED_GROUPING) : MIXED_GROUPING;
  batchGrouping.disabled = comparisons.length === 0;
}

// ── Heatmap settings section ──────────────────────────────────────────────
const hmEnabled = document.getElementById("hmEnabled") as HTMLInputElement;
const hmAutoApply = document.getElementById("hmAutoApply") as HTMLInputElement;
const hmModeAbsolute = document.getElementById("hmModeAbsolute") as HTMLInputElement;
const hmModeBranch = document.getElementById("hmModeBranch") as HTMLInputElement;
const hmModeGroup = document.getElementById("hmModeGroup") as HTMLElement;
const hmHelpBtn = document.getElementById("hmHelpBtn") as HTMLButtonElement;

hmHelpBtn.addEventListener("click", () => {
  send({ command: "openHeatmapHelp" });
});

hmEnabled.addEventListener("change", () => {
  send({ command: "updateHeatmap", patch: { enabled: hmEnabled.checked } });
});
hmAutoApply.addEventListener("change", () => {
  send({ command: "updateHeatmap", patch: { autoApply: hmAutoApply.checked } });
});
hmModeAbsolute.addEventListener("change", () => {
  if (hmModeAbsolute.checked) {
    send({ command: "updateHeatmap", patch: { mode: "absolute" } });
  }
});
hmModeBranch.addEventListener("change", () => {
  if (hmModeBranch.checked) {
    send({ command: "updateHeatmap", patch: { mode: "branch" } });
  }
});

// Reusable list drag-and-drop. Rows opt in by setting `data-id` and rendering
// the `.drag-handle` element. Draft rows omit `data-id` so they're ignored.
const dnd = enableListDragDrop(tableBody, {
  rowSelector: "tr[data-id]",
  handleSelector: ".drag-handle",
  getItemId: row => row.dataset.id ?? null,
  onMove: (id, targetIndex) => {
    send({ command: "moveTo", id, targetIndex });
  },
});

// ── Messaging ──────────────────────────────────────────────────────────────

function send(msg: BranchCompareSettingsFromWebview): void {
  vscode.postMessage(msg);
}

window.addEventListener("message", (event: MessageEvent<BranchCompareSettingsToWebview>) => {
  const msg = event.data;
  switch (msg.command) {
    case "state":
      repos = msg.repos;
      comparisons = msg.comparisons;
      render();
      break;
    case "refs":
      refsCache.set(msg.repoFullPath, msg.branches);
      refsPending.delete(msg.repoFullPath);
      // If a suggest list is open for this repo, repopulate.
      const open = document.querySelector<HTMLElement>(".suggest-list.open");
      if (open && open.dataset.repo === msg.repoFullPath) {
        renderSuggestions(open, open.dataset.field as "source" | "target", "", true);
      }
      // Now that we have the ref list, re-evaluate any inputs that were
      // previously "checking" — they may now resolve via the local fast path.
      reevaluateAllValidations();
      break;
    case "refValidation":
      applyValidationResult(msg.repoFullPath, msg.ref, msg.result);
      break;
    case "heatmapState":
      hmEnabled.checked = msg.settings.enabled;
      hmAutoApply.checked = msg.settings.autoApply;
      hmModeAbsolute.checked = msg.settings.mode === "absolute";
      hmModeBranch.checked = msg.settings.mode === "branch";
      // Mode picker is only meaningful when decorations are on — dim it
      // otherwise so the user sees it's not in effect.
      hmModeGroup.setAttribute("aria-disabled", msg.settings.enabled ? "false" : "true");
      break;
  }
});

function applyValidationResult(repoFullPath: string, ref: string, result: RefValidationResult): void {
  const key = `${repoFullPath}::${ref}`;
  validationState.set(key, result.valid
    ? { state: "valid", resolvedSha: result.resolvedSha }
    : { state: "invalid", message: result.message ?? "Invalid ref" });
  validationRequested.delete(key);
  // Update any visible inputs whose value matches.
  for (const input of document.querySelectorAll<HTMLInputElement>(".ref-input")) {
    if (input.dataset.repo === repoFullPath && input.value === ref) {
      updateRefStatus(input);
    }
  }
}

function reevaluateAllValidations(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(".ref-input")) {
    ensureRefValidated(input);
    updateRefStatus(input);
  }
}

/**
 * Ensure validation has been kicked off for the input's current value.
 * Local-resolvable values (HEAD, exact branch match) short-circuit here.
 * Anything else queues an async `validateRef` request — guarded by
 * `validationRequested` so we don't fire twice for the same (repo, ref).
 */
function ensureRefValidated(input: HTMLInputElement): void {
  const ref = input.value.trim();
  if (!ref) { return; }
  if (ref === "HEAD") { return; }
  const repo = input.dataset.repo!;
  const branches = refsCache.get(repo);
  if (branches && branches.some(b => b.name === ref)) { return; }
  const key = `${repo}::${ref}`;
  const cached = validationState.get(key);
  if (cached && cached.state !== "checking") { return; }
  if (validationRequested.has(key)) { return; }
  validationRequested.add(key);
  validationState.set(key, { state: "checking" });
  // Also trigger refs fetch for the repo — once refs arrive a value may
  // resolve locally without needing the host check at all.
  if (!refsCache.has(repo) && !refsPending.has(repo)) {
    refsPending.add(repo);
    send({ command: "requestRefs", repoFullPath: repo });
  }
  send({ command: "validateRef", repoFullPath: repo, ref });
}

refreshBtn.addEventListener("click", () => {
  // Drop every webview-side cache so the next lookups go back to the host.
  refsCache.clear();
  refsPending.clear();
  validationState.clear();
  validationRequested.clear();
  // Host clears its own `_refsCache` / `_validationCache` on this message.
  send({ command: "refreshRefs" });
  // Re-evaluate every visible input — they'll re-request refs and validation
  // as needed via `ensureRefValidated`.
  reevaluateAllValidations();
  // Repopulate any open suggest list with the "Loading refs…" placeholder
  // and kick off a fresh request for that repo.
  for (const open of document.querySelectorAll<HTMLElement>(".suggest-list.open")) {
    const repo = open.dataset.repo;
    if (repo && !refsPending.has(repo)) {
      refsPending.add(repo);
      send({ command: "requestRefs", repoFullPath: repo });
    }
    renderSuggestions(open, open.dataset.field as "source" | "target", "", true);
  }
});

addBtn.addEventListener("click", () => {
  if (repos.length === 0) { return; }
  // Optimistic local row — committed once both source & target are filled.
  const draft: DraftRow = {
    repoFullPath: repos[0].fullPath,
    source: "HEAD",
    target: "",
    label: "",
  };
  drafts.push(draft);
  render();
  // Focus the target input on the new row.
  const lastTargetInput = tableBody.querySelector<HTMLInputElement>(
    "tr.draft-row:last-child .ref-input[data-field='target']",
  );
  lastTargetInput?.focus();
});

send({ command: "ready" });

// ── Rendering ──────────────────────────────────────────────────────────────

interface DraftRow {
  repoFullPath: string;
  source: string;
  target: string;
  label: string;
}
const drafts: DraftRow[] = [];

function render(): void {
  tableBody.innerHTML = "";
  if (comparisons.length === 0 && drafts.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 9;
    td.className = "empty-state";
    td.innerHTML = "<p>No comparisons yet.</p><p>Click <strong>+ Add comparison</strong> below to define one.</p>";
    tr.appendChild(td);
    tableBody.appendChild(tr);
    dnd.refresh();
    return;
  }
  comparisons.forEach((c, idx) => {
    tableBody.appendChild(renderRow(c, idx, comparisons.length));
  });
  for (let i = 0; i < drafts.length; i++) {
    tableBody.appendChild(renderDraftRow(drafts[i], i));
  }
  dnd.refresh();
  updateDuplicateWarning();
  syncBatchGrouping();
}

/**
 * Inspect active comparisons for `(repo, source, target, grouping)` tuples that
 * occur more than once. The tree dedupes only fully-identical comparisons —
 * same triple with a *different* grouping mode renders as its own section, so
 * grouping is part of the key. The warning lets the user clean up true dupes.
 */
function updateDuplicateWarning(): void {
  const buckets = new Map<string, number>();
  for (const c of comparisons) {
    if (!c.active) { continue; }
    const key = `${c.repoFullPath}\0${c.source}\0${c.target}\0${c.groupingMode}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let dupGroups = 0;
  let dupTotal = 0;
  for (const count of buckets.values()) {
    if (count > 1) { dupGroups++; dupTotal += count; }
  }
  if (dupGroups > 0) {
    dupWarningText.textContent =
      `${dupTotal} active comparisons are identical (same repo, source, target and grouping)${dupGroups === 1 ? "" : ` across ${dupGroups} groups`} — the tree only renders one of each.`;
    dupWarning.classList.add("shown");
  } else {
    dupWarning.classList.remove("shown");
  }
}

function renderRow(c: SavedComparisonDTO, idx: number, total: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  if (!c.active) { tr.classList.add("inactive"); }
  tr.dataset.id = c.id;

  // Drag handle — wired by the reusable enableListDragDrop helper at module init.
  const handleTd = document.createElement("td");
  handleTd.className = "col-handle drag-handle";
  handleTd.title = "Drag to reorder";
  handleTd.appendChild(codicon("gripper"));
  tr.appendChild(handleTd);

  // Active checkbox
  const activeTd = document.createElement("td");
  activeTd.className = "col-active";
  const activeCb = document.createElement("input");
  activeCb.type = "checkbox";
  activeCb.checked = c.active;
  activeCb.title = c.active ? "Hide from tree" : "Show in tree";
  activeCb.addEventListener("change", () => {
    send({ command: "update", id: c.id, patch: { active: activeCb.checked } });
  });
  activeTd.appendChild(activeCb);
  tr.appendChild(activeTd);

  // Repo (read-only display — repo can't change after creation; create a new
  // comparison if you need a different repo)
  const repoTd = document.createElement("td");
  repoTd.className = "col-repo";
  repoTd.textContent = repoNameFor(c.repoFullPath);
  tr.appendChild(repoTd);

  // Source ref input (with autocomplete)
  tr.appendChild(refCell(c.repoFullPath, c.source, "source", value => {
    send({ command: "update", id: c.id, patch: { source: value } });
  }));

  // Target ref input
  tr.appendChild(refCell(c.repoFullPath, c.target, "target", value => {
    send({ command: "update", id: c.id, patch: { target: value } });
  }));

  // Label input
  const labelTd = document.createElement("td");
  labelTd.className = "col-label";
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = `${repoNameFor(c.repoFullPath)} · ${displayRef(c.source)}..${displayRef(c.target)}`;
  labelInput.value = c.label ?? "";
  labelInput.addEventListener("change", () => {
    send({ command: "update", id: c.id, patch: { label: labelInput.value } });
  });
  labelTd.appendChild(labelInput);
  tr.appendChild(labelTd);

  // Grouping mode (per-comparison)
  const groupingTd = document.createElement("td");
  groupingTd.className = "col-grouping";
  groupingTd.appendChild(groupingSelect(c.groupingMode, mode => {
    send({ command: "update", id: c.id, patch: { groupingMode: mode } });
  }));
  tr.appendChild(groupingTd);

  // Heatmap toggle (gold star). Only meaningful for HEAD-source comparisons.
  const heatmapTd = document.createElement("td");
  heatmapTd.className = "col-heatmap";
  const heatmapBtn = document.createElement("button");
  heatmapBtn.className = "icon-btn" + (c.isHeatmapBaseline ? " heatmap-on" : "");
  heatmapBtn.appendChild(codicon(c.isHeatmapBaseline ? "star-full" : "star-empty"));
  heatmapBtn.disabled = c.source !== "HEAD";
  heatmapBtn.title = c.source !== "HEAD"
    ? "Heatmap baseline requires source=HEAD"
    : c.isHeatmapBaseline ? "Click to clear heatmap baseline" : "Use as blame heatmap baseline";
  heatmapBtn.addEventListener("click", () => {
    send({ command: "setHeatmapBaseline", id: c.isHeatmapBaseline ? undefined : c.id });
  });
  heatmapTd.appendChild(heatmapBtn);
  tr.appendChild(heatmapTd);

  // Actions: swap sides / move up / down / delete
  const actionsTd = document.createElement("td");
  actionsTd.className = "col-actions";

  const swapBtn = document.createElement("button");
  swapBtn.className = "icon-btn";
  swapBtn.appendChild(codicon("arrow-swap"));
  swapBtn.title = "Swap source and target";
  swapBtn.addEventListener("click", () => {
    send({ command: "update", id: c.id, patch: { source: c.target, target: c.source } });
  });
  actionsTd.appendChild(swapBtn);

  const upBtn = document.createElement("button");
  upBtn.className = "icon-btn";
  upBtn.appendChild(codicon("arrow-up"));
  upBtn.title = "Move up";
  upBtn.disabled = idx === 0;
  upBtn.addEventListener("click", () => {
    send({ command: "move", id: c.id, delta: -1 });
  });
  actionsTd.appendChild(upBtn);

  const downBtn = document.createElement("button");
  downBtn.className = "icon-btn";
  downBtn.appendChild(codicon("arrow-down"));
  downBtn.title = "Move down";
  downBtn.disabled = idx >= total - 1;
  downBtn.addEventListener("click", () => {
    send({ command: "move", id: c.id, delta: 1 });
  });
  actionsTd.appendChild(downBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn danger";
  deleteBtn.appendChild(codicon("trash"));
  deleteBtn.title = "Delete comparison";
  deleteBtn.addEventListener("click", () => {
    send({ command: "delete", id: c.id });
  });
  actionsTd.appendChild(deleteBtn);
  tr.appendChild(actionsTd);

  return tr;
}

/** Build a codicon `<i>` element. */
function codicon(name: string): HTMLElement {
  const el = document.createElement("i");
  el.className = `codicon codicon-${name}`;
  return el;
}

function renderDraftRow(d: DraftRow, idx: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.classList.add("draft-row");

  // Empty handle column — draft rows can't be reordered (no id yet).
  const handleTd = document.createElement("td");
  handleTd.className = "col-handle disabled";
  tr.appendChild(handleTd);

  // Active checkbox — pre-filled true, but only effective once committed
  const activeTd = document.createElement("td");
  activeTd.className = "col-active";
  const activeCb = document.createElement("input");
  activeCb.type = "checkbox";
  activeCb.checked = true;
  activeCb.disabled = true;
  activeCb.title = "Active by default once saved";
  activeTd.appendChild(activeCb);
  tr.appendChild(activeTd);

  // Repo picker
  const repoTd = document.createElement("td");
  repoTd.className = "col-repo";
  if (repos.length <= 1) {
    repoTd.textContent = repoNameFor(d.repoFullPath);
  } else {
    const select = document.createElement("select");
    for (const r of repos) {
      const opt = document.createElement("option");
      opt.value = r.fullPath;
      opt.textContent = r.name;
      if (r.fullPath === d.repoFullPath) { opt.selected = true; }
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      d.repoFullPath = select.value;
      // Clear target since the new repo's refs won't match the prior text.
      d.target = "";
      render();
    });
    repoTd.appendChild(select);
  }
  tr.appendChild(repoTd);

  // Source — defaults to HEAD; user can pick another ref
  tr.appendChild(refCell(d.repoFullPath, d.source, "source", v => {
    d.source = v;
    maybeCommitDraft(idx);
  }));
  // Target
  tr.appendChild(refCell(d.repoFullPath, d.target, "target", v => {
    d.target = v;
    maybeCommitDraft(idx);
  }));

  // Label
  const labelTd = document.createElement("td");
  labelTd.className = "col-label";
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = "(optional)";
  labelInput.value = d.label;
  labelInput.addEventListener("input", () => { d.label = labelInput.value; });
  labelTd.appendChild(labelInput);
  tr.appendChild(labelTd);

  // Grouping (seeded from the workspace default once saved — can't set on a draft)
  const groupingTd = document.createElement("td");
  groupingTd.className = "col-grouping";
  const groupingSel = document.createElement("select");
  groupingSel.disabled = true;
  groupingSel.title = "Set grouping after saving the comparison";
  groupingSel.appendChild(new Option("(default)", ""));
  groupingTd.appendChild(groupingSel);
  tr.appendChild(groupingTd);

  // Heatmap (cannot be set on a draft — needs an id)
  const heatmapTd = document.createElement("td");
  heatmapTd.className = "col-heatmap";
  const heatmapBtn = document.createElement("button");
  heatmapBtn.className = "icon-btn";
  heatmapBtn.appendChild(codicon("star-empty"));
  heatmapBtn.disabled = true;
  heatmapBtn.title = "Save the comparison first, then mark as heatmap baseline";
  heatmapTd.appendChild(heatmapBtn);
  tr.appendChild(heatmapTd);

  // Actions: discard draft
  const actionsTd = document.createElement("td");
  actionsTd.className = "col-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "icon-btn danger";
  cancelBtn.appendChild(codicon("trash"));
  cancelBtn.title = "Discard this draft row";
  cancelBtn.addEventListener("click", () => {
    drafts.splice(idx, 1);
    render();
  });
  actionsTd.appendChild(cancelBtn);
  tr.appendChild(actionsTd);

  return tr;
}

/** When both source and target are non-empty, send `add` and remove the draft. */
function maybeCommitDraft(idx: number): void {
  const d = drafts[idx];
  if (!d) { return; }
  if (!d.source.trim() || !d.target.trim()) { return; }
  send({
    command: "add",
    repoFullPath: d.repoFullPath,
    source: d.source.trim(),
    target: d.target.trim(),
    label: d.label.trim() || undefined,
  });
  drafts.splice(idx, 1);
  // The state push from the host will re-render with the new comparison.
}

// ── Ref input cell with autocomplete ───────────────────────────────────────

function refCell(
  repoFullPath: string,
  initial: string,
  field: "source" | "target",
  onCommit: (value: string) => void,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = field === "source" ? "col-source" : "col-target";

  const wrapper = document.createElement("div");
  wrapper.className = "ref-input-wrapper";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ref-input";
  input.value = initial;
  input.placeholder = field === "source" ? "HEAD or branch / tag" : "branch / tag";
  input.dataset.field = field;
  input.dataset.repo = repoFullPath;
  input.autocomplete = "off";

  // Status indicator (✓ / ⚠ / spinner) sitting at the right edge of the input.
  const status = document.createElement("span");
  status.className = "ref-status";

  const list = document.createElement("div");
  list.className = "suggest-list";
  list.dataset.field = field;
  list.dataset.repo = repoFullPath;

  let focusedIdx = -1;

  function ensureRefs(): void {
    if (refsCache.has(repoFullPath) || refsPending.has(repoFullPath)) { return; }
    refsPending.add(repoFullPath);
    send({ command: "requestRefs", repoFullPath });
  }

  function open(): void {
    ensureRefs();
    list.classList.add("open");
    renderSuggestions(list, field, input.value, true);
    focusedIdx = -1;
  }
  function close(): void {
    list.classList.remove("open");
    focusedIdx = -1;
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => {
    open();
    renderSuggestions(list, field, input.value, true);
    scheduleValidation(input);
  });
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    const items = list.querySelectorAll<HTMLElement>(".suggest-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIdx = Math.min(items.length - 1, focusedIdx + 1);
      updateFocus(items, focusedIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIdx = Math.max(-1, focusedIdx - 1);
      updateFocus(items, focusedIdx);
    } else if (e.key === "Enter") {
      if (focusedIdx >= 0 && items[focusedIdx]) {
        e.preventDefault();
        const value = items[focusedIdx].dataset.value!;
        input.value = value;
        close();
        onCommit(value);
      } else {
        close();
        onCommit(input.value);
      }
    } else if (e.key === "Escape") {
      close();
    } else if (e.key === "Tab") {
      // Commit whatever is typed, then let focus move naturally.
      close();
      onCommit(input.value);
    }
  });
  input.addEventListener("blur", () => {
    // Defer so click on a suggestion still registers before close.
    setTimeout(() => {
      close();
      if (input.value !== initial) { onCommit(input.value); }
    }, 120);
  });

  list.addEventListener("mousedown", e => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".suggest-item");
    if (!item) { return; }
    const value = item.dataset.value!;
    input.value = value;
    onCommit(value);
    close();
  });

  wrapper.appendChild(input);
  wrapper.appendChild(status);
  wrapper.appendChild(list);
  td.appendChild(wrapper);
  // Render initial status synchronously and kick off async validation if needed.
  ensureRefValidated(input);
  updateRefStatus(input);
  return td;
}

// ── Ref validation helpers ─────────────────────────────────────────────────

/**
 * Compute a synchronous validation verdict for the given input value:
 *  - empty / whitespace → no status (input is partially typed)
 *  - HEAD or exact match in cached branches → valid (no round-trip needed)
 *  - cached host result → reuse it
 *  - otherwise → kicks off async validation, returns "checking"
 */
function syncValidationFor(repoFullPath: string, ref: string): ValidationState | undefined {
  const trimmed = ref.trim();
  if (!trimmed) { return undefined; }
  if (trimmed === "HEAD") { return { state: "valid" }; }
  const branches = refsCache.get(repoFullPath);
  if (branches && branches.some(b => b.name === trimmed)) {
    return { state: "valid" };
  }
  const key = `${repoFullPath}::${trimmed}`;
  const cached = validationState.get(key);
  if (cached) { return cached; }
  return { state: "checking" };
}

function scheduleValidation(input: HTMLInputElement): void {
  // Render an immediate status so the icon doesn't lag the cursor by the full
  // debounce when the value is locally classifiable (HEAD / known branch).
  updateRefStatus(input);

  const existing = validationTimers.get(input);
  if (existing) { clearTimeout(existing); }
  const timer = setTimeout(() => {
    validationTimers.delete(input);
    ensureRefValidated(input);
    updateRefStatus(input);
  }, VALIDATION_DEBOUNCE_MS);
  validationTimers.set(input, timer);
}

/**
 * Sync the status icon next to the given input with the current validation
 * verdict. Replaces the icon contents in place — used both for the initial
 * render and for follow-ups when a validation result arrives.
 */
function updateRefStatus(input: HTMLInputElement): void {
  const wrapper = input.parentElement;
  if (!wrapper) { return; }
  const status = wrapper.querySelector<HTMLElement>(".ref-status");
  if (!status) { return; }

  const repo = input.dataset.repo!;
  const verdict = syncValidationFor(repo, input.value);
  status.classList.remove("shown", "valid", "invalid", "checking");
  status.innerHTML = "";
  status.title = "";
  if (!verdict) { return; }

  status.classList.add("shown", verdict.state);
  if (verdict.state === "valid") {
    status.appendChild(codicon("pass"));
    status.title = verdict.resolvedSha
      ? `Resolves to ${verdict.resolvedSha}`
      : "Valid ref";
  } else if (verdict.state === "invalid") {
    status.appendChild(codicon("error"));
    status.title = verdict.message;
  } else {
    // checking
    const spin = codicon("loading");
    spin.classList.add("codicon-modifier-spin");
    status.appendChild(spin);
    status.title = "Validating…";
  }
}

function renderSuggestions(list: HTMLElement, field: "source" | "target", filter: string, includeHEAD: boolean): void {
  list.innerHTML = "";
  const repoPath = list.dataset.repo!;
  const branches = refsCache.get(repoPath) ?? [];

  const items: { name: string; relativeDate: string }[] = [];
  // For source field, always offer HEAD as the first suggestion.
  if (field === "source" && includeHEAD) {
    items.push({ name: "HEAD", relativeDate: "current branch" });
  }
  for (const b of branches) {
    if (b.name === "HEAD") { continue; }
    items.push(b);
  }
  const filterLower = filter.trim().toLowerCase();
  const filtered = filterLower
    ? items.filter(i => i.name.toLowerCase().includes(filterLower))
    : items;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "suggest-item";
    empty.style.opacity = "0.6";
    empty.style.cursor = "default";
    empty.textContent = refsCache.has(repoPath) ? "No matching refs" : "Loading refs…";
    list.appendChild(empty);
    return;
  }

  for (const item of filtered.slice(0, 50)) {
    const div = document.createElement("div");
    div.className = "suggest-item";
    div.dataset.value = item.name;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = item.relativeDate;
    div.appendChild(name);
    div.appendChild(date);
    list.appendChild(div);
  }
}

function updateFocus(items: NodeListOf<HTMLElement>, idx: number): void {
  items.forEach(el => el.classList.remove("focused"));
  if (idx >= 0 && items[idx]) {
    items[idx].classList.add("focused");
    items[idx].scrollIntoView({ block: "nearest" });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function repoNameFor(fullPath: string): string {
  return repos.find(r => r.fullPath === fullPath)?.name ?? fullPath;
}

function displayRef(ref: string): string {
  return ref || "?";
}
