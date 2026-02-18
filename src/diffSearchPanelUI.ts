import { html, css, raw } from "./utils/templateHelpers";

export function getWebviewHtml(cspSource: string): string {
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
      padding: 16px;
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
  `;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Diff Search</title>
  <style>${raw(styles)}</style>
</head>
<body>
  <div class="search-container">
    <h2>Search in Diffs</h2>
    
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
        <label for="daysInput">Days to Look Back</label>
        <div class="days-row">
          <input type="number" id="daysInput" name="daysInput" min="1" placeholder="7" value="7">
          <span class="help-text">days (empty = all history ⚠️)</span>
        </div>
        <div class="checkbox-group" style="margin-top: 8px; margin-bottom: 0;">
          <input type="checkbox" id="pendingOnly" name="pendingOnly">
          <label for="pendingOnly" style="margin-bottom: 0; font-weight: normal;">Pending changes only (skip history)</label>
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

      <div class="form-group" id="repoGroup" style="display: none;">
        <label>Repositories</label>
        <div class="multi-select" id="repoList">
          <div class="checkbox-group">
            <input type="checkbox" id="repo-all" checked>
            <label for="repo-all" style="margin-bottom: 0;">All Repositories</label>
          </div>
        </div>
        <div class="help-text">Select which repositories to search</div>
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('searchForm');
    const patternInput = document.getElementById('pattern');
    const isRegexCheckbox = document.getElementById('isRegex');
    const caseInsensitiveCheckbox = document.getElementById('caseInsensitive');
    const includePatternInput = document.getElementById('includePattern');
    const excludePatternInput = document.getElementById('excludePattern');
    const daysInput = document.getElementById('daysInput');
    const pendingOnlyCheckbox = document.getElementById('pendingOnly');
    const searchBtn = document.getElementById('searchBtn');
    const statusDiv = document.getElementById('status');
    const repoGroup = document.getElementById('repoGroup');
    const repoList = document.getElementById('repoList');
    const repoAllCheckbox = document.getElementById('repo-all');
    const batchProgressDiv = document.getElementById('batchProgress');
    const batchBarsDiv = document.getElementById('batchBars');
    const aggregateStatsDiv = document.getElementById('aggregateStats');

    let repos = [];
    let repoStates = {};

    // Validate regex on checkbox change
    isRegexCheckbox.addEventListener('change', () => {
      if (isRegexCheckbox.checked) {
        validateRegex();
      } else {
        hideStatus();
      }
    });

    patternInput.addEventListener('input', () => {
      if (isRegexCheckbox.checked) {
        validateRegex();
      }
    });

    // Toggle days input when pending only checkbox changes
    pendingOnlyCheckbox.addEventListener('change', () => {
      daysInput.disabled = pendingOnlyCheckbox.checked;
      if (pendingOnlyCheckbox.checked) {
        hideStatus();
      } else if (!daysInput.value) {
        showStatus('⚠️ Full history search is slow on large repos. Ballpark metrics - a minute per 1GB of .git folder size. Multiple repos run in parallel, and the search should not die midway or eat all your RAM.', 'warning');
      }
    });

    // Show warning when days is cleared (unlimited)
    daysInput.addEventListener('input', () => {
      if (!daysInput.value && !pendingOnlyCheckbox.checked) {
        showStatus('⚠️ Full history search is slow on large repos. Ballpark metrics - a minute per 1GB of .git folder size. Multiple repos run in parallel, and the search should not die midway or eat all your RAM.', 'warning');
      } else if (statusDiv.textContent.includes('all history')) {
        hideStatus();
      }
    });

    function validateRegex() {
      try {
        new RegExp(patternInput.value);
        hideStatus();
        searchBtn.disabled = false;
      } catch (e) {
        showStatus('Invalid regex: ' + e.message, 'error');
        searchBtn.disabled = true;
      }
    }

    function showStatus(message, type = 'info') {
      statusDiv.textContent = message;
      statusDiv.className = 'status ' + type;
      statusDiv.style.display = 'block';
    }

    function hideStatus() {
      statusDiv.style.display = 'none';
    }

    // Handle form submission
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      
      const pattern = patternInput.value.trim();
      if (!pattern) {
        showStatus('Please enter a search pattern', 'error');
        return;
      }

      searchBtn.disabled = true;
      showStatus('Searching...', 'info');

      const selectedRepos = [];
      if (!repoAllCheckbox.checked) {
        repos.forEach((repo, index) => {
          const checkbox = document.getElementById('repo-' + index);
          if (checkbox && checkbox.checked) {
            selectedRepos.push(repo.path);
          }
        });
      }

      vscode.postMessage({
        command: 'search',
        pattern: pattern,
        isRegex: isRegexCheckbox.checked,
        caseInsensitive: caseInsensitiveCheckbox.checked,
        includePattern: includePatternInput.value.trim(),
        excludePattern: excludePatternInput.value.trim(),
        pendingOnly: pendingOnlyCheckbox.checked,
        days: pendingOnlyCheckbox.checked ? null : (daysInput.value ? parseInt(daysInput.value) : null),
        selectedRepos: selectedRepos
      });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'setRepos':
          repos = message.repos;
          if (repos.length > 1) {
            repoGroup.style.display = 'block';
            updateRepoList();
          }
          break;
        case 'reposStarted':
          // Initialize per-repo progress display
          repoStates = {};
          batchBarsDiv.innerHTML = '';
          batchProgressDiv.style.display = 'block';
          statusDiv.style.display = 'none';
          
          for (let i = 0; i < message.repoCount; i++) {
            const repoName = message.repoNames[i];
            repoStates[i + 1] = { commits: 0, matches: 0, status: 'Waiting' };
            
            const repoDiv = document.createElement('div');
            repoDiv.className = 'batch-bar';
            repoDiv.id = 'repo-' + (i + 1);
            repoDiv.innerHTML = 
              '<div class="batch-bar-label">' +
                '<span>' + repoName + '</span>' +
                '<span id="repo-' + (i + 1) + '-stats" style="font-style: italic; color: var(--vscode-descriptionForeground);">Waiting...</span>' +
              '</div>';
            batchBarsDiv.appendChild(repoDiv);
          }
          
          aggregateStatsDiv.textContent = 'Waiting...';
          break;
          
        case 'repoProgress':
          // Initial "Searching..." message for a repo
          if (repoStates[message.repoIndex]) {
            repoStates[message.repoIndex].status = message.status;
            
            const statsSpan = document.getElementById('repo-' + message.repoIndex + '-stats');
            if (statsSpan) {
              statsSpan.textContent = message.status;
            }
          }
          break;
          
        case 'repoComplete':
          // Final results for a repo
          if (repoStates[message.repoIndex]) {
            repoStates[message.repoIndex] = {
              commits: message.commits,
              matches: message.matches,
              status: 'Complete'
            };
            
            const statsSpan = document.getElementById('repo-' + message.repoIndex + '-stats');
            
            if (statsSpan) {
              const elapsed = message.elapsedMs != null ? ' — ' + formatElapsed(message.elapsedMs) : '';
              if (message.commits > 0) {
                statsSpan.textContent = 
                    'Found matches in ' + message.commits + ' commits (' + message.matches + ' line matches)' + elapsed;
              } else if (message.matches > 0) {
                statsSpan.textContent = message.matches + 
                    ' matches (pending changes only)' + elapsed;
              } else {
                statsSpan.textContent = 'No matches' + elapsed;
              }
            }
            
            // Update aggregate stats
            let totalCommits = 0;
            let totalMatches = 0;
            for (const repoIndex in repoStates) {
              totalCommits += repoStates[repoIndex].commits;
              totalMatches += repoStates[repoIndex].matches;
            }
            
            if (totalCommits > 0) {
              aggregateStatsDiv.textContent = 
                'Total: Found matches in ' + totalCommits + ' commits (' + totalMatches + ' line matches)';
            } else if (totalMatches > 0) {
              aggregateStatsDiv.textContent = 
                'Total: ' + totalMatches + ' matches (pending changes only)';
            } else {
              aggregateStatsDiv.textContent = 
                'Total: No matches';
            }
          }
          break;
          
        case 'searchComplete':
          searchBtn.disabled = false;
          showStatus(message.message, message.count > 0 ? 'info' : 'error');
          break;
      }
    });

    function updateRepoList() {
      // Clear existing checkboxes except "All"
      const allCheckbox = repoList.firstElementChild;
      repoList.innerHTML = '';
      repoList.appendChild(allCheckbox);

      // Add checkbox for each repo
      repos.forEach((repo, index) => {
        const div = document.createElement('div');
        div.className = 'checkbox-group';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'repo-' + index;
        checkbox.checked = true;
        checkbox.disabled = repoAllCheckbox.checked;
        
        const label = document.createElement('label');
        label.htmlFor = 'repo-' + index;
        label.style.marginBottom = '0';
        label.textContent = repo.name;
        
        div.appendChild(checkbox);
        div.appendChild(label);
        repoList.appendChild(div);
      });

      // Handle "All" checkbox
      repoAllCheckbox.addEventListener('change', () => {
        repos.forEach((repo, index) => {
          const checkbox = document.getElementById('repo-' + index);
          if (checkbox) {
            checkbox.disabled = repoAllCheckbox.checked;
            if (repoAllCheckbox.checked) {
              checkbox.checked = true;
            }
          }
        });
      });
    }

    // Notify extension that webview is ready
    vscode.postMessage({ command: 'ready' });

    // Focus the input
    patternInput.focus();

    function formatElapsed(ms) {
      if (ms < 1000) return ms + 'ms';
      const s = (ms / 1000).toFixed(1);
      return s + 's';
    }
  </script>
</body>
</html>`;
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
