import { html, css, raw } from "../utils/templateHelpers";
import { getNonce } from "../utils/webviewUtils";

/**
 * HTML / CSS scaffolding for the Branch Comparisons settings panel. The
 * webview script (`media/branchCompareSettings.js`, bundled from
 * `src/webview/branchCompareSettings.ts`) wires the table behavior and
 * message passing.
 */
export function getBranchCompareSettingsHtml(
  cspSource: string,
  scriptUri: string,
  codiconCssUri: string,
): string {
  const nonce = getNonce();

  const styles = css`
    * { box-sizing: border-box; }
    body {
      padding: 16px 20px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      margin: 0;
    }
    h2 {
      margin: 0;
      font-size: 1.1em;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 4px;
    }
    .header-row .icon-btn {
      width: 28px;
      height: 28px;
      font-size: 1.1em;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin: 0 0 16px 0;
    }

    /* ── table ──────────────────────────────────────── */
    table.cmp {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
    }
    table.cmp th, table.cmp td {
      padding: 6px 8px;
      text-align: left;
      vertical-align: middle;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    table.cmp th {
      font-size: 0.82em;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    table.cmp tbody tr:hover {
      background: var(--vscode-list-hoverBackground);
    }
    table.cmp tbody tr.inactive td {
      opacity: 0.55;
    }
    .col-handle {
      width: 24px;
      text-align: center;
      cursor: grab;
      color: var(--vscode-descriptionForeground);
      user-select: none;
    }
    .col-handle:active { cursor: grabbing; }
    .col-handle.disabled {
      visibility: hidden; /* draft rows reserve the column width but show no grip */
    }
    .col-active { width: 60px; text-align: center; }
    .col-repo { white-space: nowrap; }
    .col-source, .col-target { min-width: 220px; }
    .col-label { min-width: 160px; }
    .col-grouping { width: 150px; }
    .col-heatmap { width: 80px; text-align: center; }
    .col-actions { width: 160px; text-align: right; white-space: nowrap; }
    .icon-btn[disabled] {
      opacity: 0.35;
      cursor: default;
    }
    .icon-btn[disabled]:hover {
      background: transparent;
    }

    /* ── inputs / buttons ──────────────────────────── */
    input[type="text"], select {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    input[type="text"]:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .ref-input-wrapper {
      position: relative;
    }
    .ref-input-wrapper input { padding-right: 28px; }
    .ref-status {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: none;
      pointer-events: none;
      font-size: 14px;
      line-height: 1;
    }
    .ref-status.shown { display: inline-flex; }
    .ref-status.valid { color: var(--vscode-charts-green, #2ea043); }
    .ref-status.invalid { color: var(--vscode-errorForeground, #f85149); pointer-events: auto; cursor: help; }
    .ref-status.checking { color: var(--vscode-descriptionForeground); }
    .suggest-list {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 240px;
      overflow-y: auto;
      background: var(--vscode-quickInput-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
      z-index: 100;
      display: none;
    }
    .suggest-list.open { display: block; }
    .suggest-item {
      padding: 4px 8px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .suggest-item:hover, .suggest-item.focused {
      background: var(--vscode-list-hoverBackground);
    }
    .suggest-item .name { flex: 1; }
    .suggest-item .date {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      flex-shrink: 0;
    }
    .icon-btn {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid transparent;
      width: 26px;
      height: 26px;
      border-radius: 3px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-size: 1em;
      line-height: 1;
    }
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    .icon-btn.danger:hover {
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 80, 80, 0.15));
      color: var(--vscode-errorForeground, #f85149);
    }
    .icon-btn.heatmap-on {
      color: var(--vscode-charts-yellow, #d4a017);
    }
    button.add-btn {
      margin-top: 12px;
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 600;
    }
    button.add-btn:hover { background: var(--vscode-button-hoverBackground); }

    .add-row {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .table-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-bottom: 8px;
    }
    .table-toolbar label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .table-toolbar select { width: auto; min-width: 150px; }
    .dup-warning {
      display: none;
      align-items: center;
      gap: 6px;
      color: var(--vscode-editorWarning-foreground, #d4a017);
      font-size: 0.85em;
    }
    .dup-warning.shown { display: inline-flex; }
    .dup-warning .codicon {
      font-size: 14px;
    }

    /* ── checkbox ──────────────────────────── */
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
    }

    /* ── drag & drop ──────────────────────── */
    .list-dnd-dragging {
      opacity: 0.45;
    }
    .list-dnd-drop-above {
      box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder);
    }
    .list-dnd-drop-below {
      box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder);
    }

    /* ── empty state ──────────────────────── */
    .empty-state {
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state p { margin: 0 0 12px 0; }

    .legend {
      margin-top: 18px;
      padding: 10px 14px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-left: 2px solid var(--vscode-panel-border);
    }
    .legend strong { color: var(--vscode-foreground); }
    .legend ul {
      margin: 0;
      padding-left: 18px;
    }
    .legend li { margin: 4px 0; }
    .legend code {
      background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
    }

    /* ── heatmap section ──────────────────────── */
    .section {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .section h3 {
      margin: 0 0 4px 0;
      font-size: 1em;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .section-header h3 { margin: 0; }
    .section .section-desc {
      margin: 0 0 12px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .field-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0;
    }
    .field-row label {
      cursor: pointer;
      user-select: none;
    }
    .field-help {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-left: 24px;
    }
    .mode-group {
      margin-top: 6px;
      padding-left: 4px;
    }
    .mode-group .field-row { margin: 4px 0; }
    .mode-group[aria-disabled="true"] {
      opacity: 0.5;
      pointer-events: none;
    }
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource};">
  <title>Branch Comparisons</title>
  <link rel="stylesheet" href="${raw(codiconCssUri)}">
  <style>${raw(styles)}</style>
</head>
<body>
  <div class="header-row">
    <h2>Branch Comparisons</h2>
    <button class="icon-btn" id="refreshBtn" title="Re-fetch branches (pick up refs created since the panel was opened)">
      <i class="codicon codicon-refresh"></i>
    </button>
  </div>
  <p class="subtitle">Define which comparisons appear in the Branch Compare tree. Each row is one (source &rarr; target) pair.</p>

  <div class="table-toolbar">
    <label for="batchGrouping">Set grouping for all comparisons:</label>
    <select id="batchGrouping" title="Apply a grouping mode to every comparison at once"></select>
  </div>

  <table class="cmp" id="comparisonsTable">
    <thead>
      <tr>
        <th class="col-handle" title="Drag to reorder"></th>
        <th class="col-active" title="Show this comparison in the tree">Active</th>
        <th class="col-repo">Repo</th>
        <th class="col-source">Source</th>
        <th class="col-target">Target</th>
        <th class="col-label">Name</th>
        <th class="col-grouping" title="How this comparison's files are grouped in the tree">Grouping</th>
        <th class="col-heatmap" title="Drives the blame heatmap (HEAD-source comparisons only, max one per repo)">Heatmap</th>
        <th class="col-actions"></th>
      </tr>
    </thead>
    <tbody id="comparisonsBody">
      <tr class="empty-row"><td colspan="9" class="empty-state"><p>Loading…</p></td></tr>
    </tbody>
  </table>

  <div class="add-row">
    <button class="add-btn" id="addBtn">+ Add comparison</button>
    <span class="dup-warning" id="dupWarning">
      <i class="codicon codicon-warning"></i>
      <span id="dupWarningText">Duplicate active comparisons detected — the tree renders only one.</span>
    </span>
  </div>

  <div class="legend">
    <ul>
      <li><strong>Source</strong> — the branch with the work you want to inspect.</li>
      <li><strong>Target</strong> — the baseline you compare against (the older / reference side).</li>
      <li>The autocomplete lists branches and tags, but the input accepts any ref git understands — commit SHAs, <code>HEAD~N</code>, <code>origin/main^</code>, etc. Type freely; the green check confirms it resolves.</li>
      <li>Use <code>HEAD</code> as source to track your current branch dynamically. Only HEAD-source comparisons can drive the blame heatmap or include working-tree changes.</li>
      <li>Use <code>HEAD~N</code> as target to compare against your last <em>N</em> commits on this branch — e.g. <code>HEAD~5</code> shows what changed in your five most recent first-parent commits.</li>
    </ul>
  </div>

  <section class="section" id="heatmapSection">
    <div class="section-header">
      <h3>Blame Heatmap</h3>
      <button class="icon-btn" id="hmHelpBtn" title="Open heatmap documentation">
        <i class="codicon codicon-question"></i>
      </button>
    </div>
    <p class="section-desc">Tints lines in the editor by age or by diff-vs-baseline. Affects every repo that has a heatmap-baseline starred above.</p>

    <div class="field-row">
      <input type="checkbox" id="hmEnabled">
      <label for="hmEnabled">Show heatmap decorations</label>
    </div>

    <div class="field-row">
      <input type="checkbox" id="hmAutoApply">
      <label for="hmAutoApply">Auto-apply when opening files</label>
    </div>
    <div class="field-help">Without this, run "Blame heatmap…" from the editor's right-click menu per file.</div>

    <div class="mode-group" id="hmModeGroup">
      <div class="field-row">
        <input type="radio" name="hmMode" id="hmModeAbsolute" value="absolute">
        <label for="hmModeAbsolute"><strong>Age</strong> — older lines tinted darker</label>
      </div>
      <div class="field-row">
        <input type="radio" name="hmMode" id="hmModeBranch" value="branch">
        <label for="hmModeBranch"><strong>Branch</strong> — only lines changed since the starred baseline are tinted</label>
      </div>
      <div class="field-help">Branch mode needs a comparison marked with the heatmap star above. Repos without a starred comparison show no heatmap in branch mode.</div>
    </div>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
