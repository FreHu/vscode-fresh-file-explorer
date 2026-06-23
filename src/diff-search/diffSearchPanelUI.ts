import { html, css, raw } from "../utils/templateHelpers";
import { getNonce } from "../utils/webviewUtils";

export function getWebviewHtml(cspSource: string, scriptUri: string): string {
  const nonce = getNonce();

  const styles = css`
    body {
      padding-left: 20px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .search-container {
      max-width: 600px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    input[type="text"] {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      box-sizing: border-box;
    }
    input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    select {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      box-sizing: border-box;
    }
    input[type="number"] {
      width: 80px;
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      box-sizing: border-box;
    }
    input[type="number"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    input[type="number"]:disabled {
      opacity: 0.4;
    }
    .days-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .days-row .help-text {
      margin: 0;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    input[type="checkbox"] {
      margin: 0;
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
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .status {
      margin-top: 16px;
      padding: 8px 12px;
      border-radius: 4px;
      display: none;
    }
    .status.info {
      background: var(--vscode-inputValidation-infoBorder);
      color: var(--vscode-input-foreground);
    }
    .status.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-input-foreground);
    }
    .help-text {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .multi-select {
      max-height: 150px;
      overflow-y: auto;
      border: 1px solid var(--vscode-input-border);
      padding: 8px;
      background: var(--vscode-input-background);
    }
    .compact-input-group {
      margin-bottom: 4px;
    }
    .compact-input-group label {
      display: block;
      margin-bottom: 2px;
      font-weight: normal;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      text-transform: lowercase;
    }
    .compact-input-group input[type="text"] {
      padding: 3px 6px;
    }
    .path-filters {
      margin-bottom: 16px;
    }
    .batch-progress {
      margin-top: 24px;
      padding: 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .batch-bar {
      margin-bottom: 12px;
      font-size: 0.9em;
    }
    .batch-bar-label {
      display: flex;
      justify-content: space-between;
      color: var(--vscode-foreground);
    }
    .git-command {
      display: block;
      margin: 4px 0 16px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
    }
    .history-section {
      margin-top: 24px;
      max-width: 600px;
    }
    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .history-header h3 {
      margin: 0;
      font-size: 0.9em;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .history-clear-btn {
      padding: 2px 8px;
      font-size: 0.8em;
      font-weight: normal;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border);
      cursor: pointer;
    }
    .history-clear-btn:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .history-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .history-entry {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-widget-border, transparent);
      cursor: pointer;
    }
    .history-entry:hover .history-label {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .history-label {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-time {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
    }
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
  <title>Diff Search</title>
  <style>${raw(styles)}</style>
</head>
<body>
  <div class="search-container">
    <h2>Search in Diffs</h2>
    <code class="git-command" id="gitCommand" style="display:none;"></code>
    
    <form id="searchForm">
      <div class="form-group">
        <label for="pattern">Search Pattern</label>
        <input type="text" id="pattern" name="pattern" placeholder="Enter text or regex..." autofocus>
      </div>

      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="isRegex" name="isRegex">
          <label for="isRegex" style="margin-bottom: 0;">Regex</label>
        </div>
        <div class="checkbox-group">
          <input type="checkbox" id="caseInsensitive" name="caseInsensitive">
          <label for="caseInsensitive" style="margin-bottom: 0;">Case Insensitive</label>
        </div>
      </div>

      <div class="form-group">
        <div class="checkbox-group" style="margin-bottom: 8px;">
          <input type="checkbox" id="pendingOnly" name="pendingOnly">
          <label for="pendingOnly" style="margin-bottom: 0; font-weight: normal;">Pending changes only (skip history)</label>
        </div>
        <div id="historyOptions">
          <label for="windowInput">Time window</label>
          <div class="days-row">
            <input type="text" id="windowInput" name="windowInput" placeholder="e.g. 6h, 2w, 1mo, 30" value="7d" style="width: 150px;">
            <span class="help-text">duration token or day count (empty = full history)</span>
          </div>
          <div class="checkbox-group" style="margin-top: 8px; margin-bottom: 0;">
            <input type="checkbox" id="includeMerges" name="includeMerges">
            <label for="includeMerges" style="margin-bottom: 0; font-weight: normal;">Include merge commits</label>
          </div>
        </div>
      </div>

      <div class="path-filters">
        <div class="compact-input-group">
          <label for="includePattern">files to include</label>
          <input type="text" id="includePattern" name="includePattern" placeholder="e.g. *.ts, src/**">
        </div>
        <div class="compact-input-group">
          <label for="excludePattern">files to exclude</label>
          <input type="text" id="excludePattern" name="excludePattern" placeholder="e.g. *.test.ts, dist/**">
        </div>
      </div>

      <div class="form-group">
        <button type="submit" id="searchBtn">Search</button>
      </div>
    </form>

    <div id="batchProgress" class="batch-progress" style="display: none;">
      <h3>Results</h3>
      <div id="batchBars"></div>
      <div id="aggregateStats" style="margin-top: 12px; font-weight: 600;"></div>
    </div>

    <div id="status" class="status"></div>
  </div>

  <div class="history-section" id="historySection">
    <div class="history-header">
      <h3>Recent Searches</h3>
      <button type="button" class="history-clear-btn" id="historyClearBtn">Clear</button>
    </div>
    <ul class="history-list" id="historyList"></ul>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
