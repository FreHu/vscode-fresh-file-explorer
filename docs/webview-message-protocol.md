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

Every webview opens with the same handshake: once its listeners are set up, the
script posts `{ command: "ready" }`, and the host replies by pushing initial
state. After that, messages flow on demand. (Branch Compare settings is a webview
*view* in the panel area, not an editor panel; the protocol is the same.)

| Webview | Host file | Webview file | To-webview (host sends) | From-webview (webview sends) |
|---|---|---|---|---|
| Stonks | `src/stonks/stonksPanel.ts` | `src/webview/stonksPanel.ts` | `setRepos`, `setData`, `setCompareData`, `setLoading`, `setTimeWindows`, `setConfig` | `ready`, `selectRepo`, `openCommit`, `selectTimeWindow`, `updateConfig`, `requestCompareData`, `openHelp`, `exportSvg` |
| Diff Search | `src/diff-search/diffSearchPanel.ts` | `src/webview/diffSearchPanel.ts` | `prefill`, `prefillParams`, `setHistory`, `reposStarted`, `repoProgress`, `repoComplete`, `searchComplete` | `ready`, `clearHistory`, `search` |
| Git Log -L | `src/logL/gitLogLPanel.ts` | `src/webview/gitLogLPanel.ts` | `setCommits` | `ready`, `compare`, `openCommit`, `openFileDiff`, `openSingle` |
| Branch Compare settings | `src/branch-compare/branchCompareSettingsPanel.ts` | `src/webview/branchCompareSettings.ts` | `state`, `refs`, `refValidation`, `heatmapState` | `ready`, `add`, `update`, `delete`, `move`, `moveTo`, `setHeatmapBaseline`, `setAllGroupingMode`, `setFileIcons`, `keepAutoFollow`, `showTree`, `requestRefs`, `validateRef`, `refreshRefs`, `updateHeatmap`, `setAutoFollow`, `openHeatmapHelp` |
| Perf Benchmark | `src/benchmark/perfBenchmarkPanel.ts` | `src/webview/perfBenchmarkPanel.ts` | `benchmarks`, `results`, `error`, `stats`, `statsError`, `cacheStats`, `cacheStatsError` | `ready`, `run`, `getStats`, `getCacheStats` |

The unions in `messages.ts` are the source of truth; if this table disagrees, the table is stale.

## Enforcement

The static guarantee only holds if neither side touches the raw `any`-typed
`postMessage` directly. Each host sends every outbound message through one typed
wrapper, `_post(msg: XToWebview)`, which calls `webview.postMessage` (on the
panel, or on the resolved view for Branch Compare settings), and types its inbound
handler as `XFromWebview`. Each webview script mirrors this with a typed send
helper (`postMessage` or `send`) taking `XFromWebview`, and types its `window`
message listener as `MessageEvent<XToWebview>`.

**Do not** call `webview.postMessage({ ... })` with a bare object literal: that
re-opens the `any` hole, and a renamed or dropped field ships green and renders
`undefined` / `NaN` at runtime. Always go through `_post`.

Branch Compare settings and Git Log -L end their inbound `switch` with an
exhaustive `never` check, which turns "forgot to handle a new command" into a
compile error. Copy that pattern when adding commands; Perf Benchmark still uses
an `if` chain without it.
