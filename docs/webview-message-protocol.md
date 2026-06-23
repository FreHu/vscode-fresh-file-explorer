# Webview message protocol

The extension host (Node.js) and the webview scripts (browser) talk only over
VS Code's `postMessage` / `onDidReceiveMessage`. There is no shared runtime — a
message is the only contract. All message shapes live in one file,
[`src/webview/messages.ts`](../src/webview/messages.ts), as discriminated unions
keyed on a literal `command` field. That file is compiled by **both** tsconfigs
(extension host + `src/webview/tsconfig.json`), so a shape change is a compile
error on whichever side falls out of sync — *provided both sides go through the
typed channel* (see "Enforcement" below).

Naming convention: for each panel there is a `XToWebview` union (host → webview)
and a `XFromWebview` union (webview → host).

## Per-panel protocol

Every panel opens with the same handshake: the webview script's last line posts
`{ command: "ready" }`; the host replies by pushing initial state. After that,
messages flow on demand.

| Panel | Host file | Webview file | To-webview (host sends) | From-webview (webview sends) |
|---|---|---|---|---|
| Stonks | `src/stonks/stonksPanel.ts` | `src/webview/stonksPanel.ts` | `setRepos`, `setData`, `setCompareData`, `setLoading`, `setTimeWindows`, `setConfig` | `ready`, `selectRepo`, `openCommit`, `selectTimeWindow`, `updateConfig`, `requestCompareData`, `openHelp`, `exportSvg` |
| Diff Search | `src/diff-search/diffSearchPanel.ts` | `src/webview/diffSearchPanel.ts` | `prefill`, `prefillParams`, `setHistory`, `reposStarted`, `repoProgress`, `repoComplete`, `searchComplete` | `ready`, `clearHistory`, `search` |
| Git Log -L | `src/logL/gitLogLPanel.ts` | `src/webview/gitLogLPanel.ts` | `setCommits` | `ready`, `compare`, `openCommit`, `openSingle` |
| Branch Compare settings | `src/branch-compare/branchCompareSettingsPanel.ts` | `src/webview/branchCompareSettings.ts` | `state`, `refs`, `refValidation`, `heatmapState` | `ready`, `add`, `update`, `delete`, `move`, `moveTo`, `setHeatmapBaseline`, `setAllGroupingMode`, `requestRefs`, `validateRef`, `refreshRefs`, `updateHeatmap`, `openHeatmapHelp` |

The command lists above are a navigation aid, not the source of truth — the
unions in `messages.ts` are. If they disagree, the code is right and this table
is stale.

## Enforcement

The static guarantee only holds if neither side touches the raw `any`-typed
`vscode` API directly. Each host panel funnels every outbound message through a
single typed wrapper:

```ts
private _post(msg: XToWebview): void {
  void this._panel.webview.postMessage(msg);
}
```

and types its inbound handler as `XFromWebview`, switching on `command`. Each
webview script mirrors this with a local typed send helper (named `postMessage`
or `send`) taking `XFromWebview`, and types its `window`-message listener as
`MessageEvent<XToWebview>`.

**Do not** call `this._panel.webview.postMessage({ ... })` with a bare object
literal — that re-opens the `any` hole and a renamed/dropped field will ship
green and render `undefined`/`NaN` at runtime. Always go through `_post`.

The `branchCompareSettings` inbound handler additionally ends its `switch` with
an exhaustive `never` check — a good pattern to copy when adding commands, since
it turns "forgot to handle a new command" into a compile error.
