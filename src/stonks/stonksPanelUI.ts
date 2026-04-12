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
    #zoomSelect {
      display: none;
      min-width: 100px;
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
    .toggles input[type="number"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 2px 4px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
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
      line-height: 1.6;
    }
    .tooltip .stat .added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .tooltip .stat .deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 40px 0;
      text-align: center;
    }
    .controls-help {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-bottom: 10px;
      opacity: 0.8;
    }
    .controls-help kbd {
      display: inline-block;
      padding: 0px 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17));
      color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-keybindingLabel-border, rgba(51,51,51,0.6));
      border-bottom-color: var(--vscode-keybindingLabel-bottomBorder, rgba(68,68,68,0.6));
      border-radius: 3px;
    }
    .pan-scrollbar {
      display: none;
      position: relative;
      height: 12px;
      margin: 4px 60px 0 60px;
      background: var(--vscode-scrollbar-shadow, rgba(0,0,0,0.1));
      border-radius: 6px;
      cursor: pointer;
    }
    .pan-thumb {
      position: absolute;
      top: 1px;
      height: 10px;
      min-width: 20px;
      background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4));
      border-radius: 5px;
      cursor: grab;
    }
    .pan-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(121,121,121,0.7));
    }
    .pan-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground, rgba(121,121,121,0.9));
      cursor: grabbing;
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
    <select id="zoomSelect"></select>
  </div>
  <div class="toggles">
    <label title="Cumulative number of files in the repository at each commit"><input type="checkbox" id="toggleFileCount" checked> Files in repo</label>
    <label title="Files added, modified, or deleted per commit. Green = net additions, red = net deletions"><input type="checkbox" id="toggleFilesChanged" checked> Files changed</label>
    <label title="Distinct commit authors in a rolling window of 10 commits"><input type="checkbox" id="toggleAuthors" checked> Unique authors</label>
    <label title="Number of commits sharing the same calendar day"><input type="checkbox" id="toggleVelocity" checked> Commit velocity</label>
    <label title="Files changed as a percentage of total files in the repository"><input type="checkbox" id="toggleChurn" checked> Churn rate</label>
    <label title="Maximum commits rendered at once before panning kicks in. Lower values improve responsiveness.">Max ticks: <input type="number" id="maxTicks" value="1000" min="100" max="10000" step="100" style="width: 60px"></label>
  </div>
  <div class="controls-help">
    <kbd>drag</kbd> select range to zoom in · <kbd>dblclick</kbd> zoom out one level · <kbd>Shift</kbd>+<kbd>scroll</kbd> pan horizontally
  </div>
  <div id="loading" class="loading" style="display:none">Loading chart data…</div>
  <div id="empty" class="empty" style="display:none"></div>
  <div class="chart-container" id="chartContainer" style="display:none">
    <svg id="chart"></svg>
    <div class="pan-scrollbar" id="panScrollbar"><div class="pan-thumb" id="panThumb"></div></div>
    <div class="tooltip" id="tooltip"></div>
  </div>
  <script nonce="${nonce}" src="${raw(scriptUri)}"></script>
</body>
</html>`;
}
