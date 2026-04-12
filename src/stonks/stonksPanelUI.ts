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
      overflow-y: auto;
      overflow-x: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .header h2 {
      margin: 0;
      font-size: 1.2em;
      white-space: nowrap;
    }
    select {
      padding: 4px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      min-width: 160px;
    }
    .reset-zoom {
      display: none;
      padding: 3px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      cursor: pointer;
    }
    .reset-zoom:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .zoom-info {
      display: none;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
    }
    .toggles {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .toggles label {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .toggles input[type="checkbox"] {
      accent-color: var(--vscode-focusBorder);
    }
    .loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 40px 0;
    }
    .chart-container {
      position: relative;
      width: 100%;
      user-select: none;
    }
    svg {
      width: 100%;
      display: block;
    }
    .tooltip {
      display: none;
      position: absolute;
      pointer-events: none;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border));
      padding: 8px 12px;
      font-size: 12px;
      line-height: 1.5;
      z-index: 10;
      max-width: 350px;
      white-space: nowrap;
    }
    .tooltip .hash {
      color: var(--vscode-textLink-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tooltip .author {
      color: var(--vscode-descriptionForeground);
    }
    .tooltip .message {
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 320px;
    }
    .tooltip .stat {
      color: var(--vscode-descriptionForeground);
    }
    .tooltip .stat .added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .tooltip .stat .deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 40px 0;
      text-align: center;
    }
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${raw(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">${raw(styles)}</style>
</head>
<body>
  <div class="header">
    <h2>📈 CodeStonks</h2>
    <select id="repoSelect" disabled>
      <option>Loading repos…</option>
    </select>
    <select id="timeWindowSelect">
      <option>Loading…</option>
    </select>
    <button id="resetZoom" class="reset-zoom">Reset Zoom</button>
    <span id="zoomInfo" class="zoom-info"></span>
  </div>
  <div class="toggles">
    <label title="Cumulative number of files in the repository at each commit"><input type="checkbox" id="toggleFileCount" checked> Files in repo</label>
    <label title="Files added, modified, or deleted per commit. Green = net additions, red = net deletions"><input type="checkbox" id="toggleFilesChanged" checked> Files changed</label>
    <label title="Distinct commit authors in a rolling window of 10 commits"><input type="checkbox" id="toggleAuthors" checked> Unique authors</label>
    <label title="Number of commits sharing the same calendar day"><input type="checkbox" id="toggleVelocity" checked> Commit velocity</label>
    <label title="Files changed as a percentage of total files in the repository"><input type="checkbox" id="toggleChurn" checked> Churn rate</label>
  </div>
  <div id="loading" class="loading" style="display:none">Loading chart data…</div>
  <div id="empty" class="empty" style="display:none">No commits found in the configured time window.</div>
  <div class="chart-container" id="chartContainer" style="display:none">
    <svg id="chart"></svg>
    <div class="tooltip" id="tooltip"></div>
  </div>
  <script nonce="${nonce}" src="${raw(scriptUri)}"></script>
</body>
</html>`;
}
