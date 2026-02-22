import { html, css, raw } from "./utils/templateHelpers";
import { getNonce } from "./utils/nonceUtils";

export function getGitLogLPanelHtml(cspSource: string, scriptUri: string): string {
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
      margin: 0 0 4px 0;
      font-size: 1.1em;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin-bottom: 6px;
    }
    .git-command {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      color: var(--vscode-textPreformat-foreground);
      background: var(--vscode-textPreformat-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 2px 8px;
      display: inline-block;
      margin-bottom: 10px;
      user-select: text;
    }
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      padding-bottom: 10px;
      margin: -16px -20px 0;
      padding: 16px 20px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 12px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: var(--vscode-panel-border);
      margin: 0 2px;
    }
    button {
      padding: 5px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 600;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hint {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    /* ── timeline ─────────────────────────────────── */
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .commit-row {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-panel-border);
      border-bottom: none;
    }
    .commit-row:last-child { border-bottom: 1px solid var(--vscode-panel-border); }
    .commit-row.focused > .commit-header { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .commit-header {
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
      padding: 4px 10px 4px 4px;
      flex-wrap: nowrap;
      cursor: pointer;
      min-width: 0;
    }
    .commit-header:hover { background: var(--vscode-list-hoverBackground); }
    .chevron {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
      font-size: 0.7em;
      opacity: 0.5;
      pointer-events: none;
    }
    .ab-btn {
      flex-shrink: 0;
      width: 24px;
      height: 20px;
      font-size: 0.72em;
      font-weight: 700;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      letter-spacing: 0.04em;
    }
    .ab-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .ab-btn.sel-a {
      background: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
      color: #fff;
      border-color: transparent;
    }
    .ab-btn.sel-b {
      background: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      color: #fff;
      border-color: transparent;
    }
    .hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      color: var(--vscode-textLink-foreground);
      flex-shrink: 0;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .hash:hover { color: var(--vscode-textLink-activeForeground); }
    .message {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .meta {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .stat {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
    .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .rename {
      font-size: 0.78em;
      color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-descriptionForeground));
      white-space: nowrap;
      flex-shrink: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      cursor: default;
    }
    .hunk {
      display: none;
      padding: 0 12px 10px 46px;
      overflow-x: auto;
    }
    .commit-row.expanded .hunk { display: block; }
    pre.diff {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.4;
      white-space: pre;
    }
    .diff-hunk-header { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d4a017); }
    .diff-add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
    .diff-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .diff-ctx { color: var(--vscode-foreground); opacity: 0.7; }
    .empty-state {
      padding: 32px 0;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
  <title>Git Log -L</title>
  <style>${raw(styles)}</style>
</head>
<body>
  <div class="sticky-header">
    <h2 id="title">Git Log -L</h2>
    <p class="subtitle" id="subtitle">Loading...</p>
    <code class="git-command" id="gitCommand"></code>
    <div class="toolbar">
      <button id="compareBtn" disabled>Compare A → B</button>
      <button id="clearBtn" class="secondary">Clear</button>
      <span id="selectionInfo" class="hint"></span>
      <div class="toolbar-sep"></div>
      <button id="prevBtn" class="secondary" disabled title="Previous commit (Ctrl+Left)">◀ Prev</button>
      <button id="nextBtn" class="secondary" disabled title="Next commit (Ctrl+Right)">Next ▶</button>
      <div class="toolbar-sep"></div>
      <button id="expandAllBtn" class="secondary" title="Expand all (Ctrl+*)">Expand All</button>
      <button id="collapseAllBtn" class="secondary" title="Collapse all (Ctrl+/)">Collapse All</button>
    </div>
  </div>

  <div id="timeline" class="timeline">
    <div class="empty-state">Loading commits...</div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

