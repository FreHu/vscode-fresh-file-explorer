import { html, css, raw } from "../utils/templateHelpers";
import { getNonce } from "../utils/webviewUtils";

export function getWebviewHtml(cspSource: string, scriptUri: string): string {
  const nonce = getNonce();

  const styles = css`
    body {
      padding: 20px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .container {
      max-width: 700px;
    }
    h2 {
      margin-top: 0;
    }
    .form-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    label {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    input[type="text"] {
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      width: 220px;
      box-sizing: border-box;
    }
    input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    select {
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    button {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 600;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .help-text {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin: 0;
    }
    .results {
      margin-top: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95em;
    }
    th {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 2px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      font-weight: 600;
      white-space: nowrap;
    }
    td {
      padding: 5px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, transparent);
      white-space: nowrap;
    }
    tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .num {
      text-align: right;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .error-row td {
      color: var(--vscode-errorForeground);
    }
    .ratio {
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .ratio-expected {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-left: 3px;
    }
    .ratio-sub  { color: #4ec994; }
    .ratio-lin  { color: var(--vscode-foreground); }
    .ratio-sup  { color: #f14c4c; }
    .status {
      margin-top: 12px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .section-divider {
      margin: 32px 0 16px;
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .stats-table td:first-child {
      color: var(--vscode-descriptionForeground);
      padding-right: 20px;
      white-space: nowrap;
    }
    .stats-table td {
      padding: 3px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .stats-table th {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 4px 10px 6px;
      font-size: 0.9em;
    }
    .commit-graph-yes { color: #4ec994; font-weight: 600; }
    .commit-graph-no  { color: var(--vscode-descriptionForeground); }
    .code-hint {
      margin: 6px 0 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      padding: 8px 12px;
      color: var(--vscode-foreground);
      white-space: pre;
      overflow-x: auto;
    }
    .code-hint-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin: 12px 0 2px;
      font-weight: 600;
    }
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
  <title>Fresh File Explorer - Git Performance Benchmark</title>
  <style>${raw(styles)}</style>
</head>
<body>
  <div class="container">
    <h2>Fresh File Explorer - Git Performance Benchmark</h2>

    <div class="form-row">
      <div class="form-group">
        <label for="benchmark">Benchmark</label>
        <select id="benchmark"></select>
      </div>
    </div>
    <div class="form-row" id="inputForm"></div>
    <div class="form-row">
      <div class="form-group">
        <button id="runBtn" disabled>Run</button>
      </div>
    </div>
    <p class="help-text">Select a benchmark, fill in the inputs, and click Run.</p>

    <div class="status" id="status" style="display:none;"></div>

    <div class="results" id="results" style="display:none;"></div>

    <hr class="section-divider">

    <div style="display:flex; align-items:baseline; gap:12px; margin-bottom:12px;">
      <h2 style="margin:0;">Repo Stats</h2>
      <button id="statsBtn">Load Stats</button>
    </div>
    <p class="help-text">Commit count, oldest commit, contributor count, current branch, and commit-graph status for each repository.</p>

    <div class="status" id="statsStatus" style="display:none;"></div>
    <div id="statsSection" style="display:none;"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
