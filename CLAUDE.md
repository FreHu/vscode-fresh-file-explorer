# Fresh File Explorer - Agent Maintenance Guide

## Approach to Problems

**Optimize for end-of-conversation satisfaction over next-reply satisfaction** Drop pleasantries. Initial pushback is better than starting the wrong way and going in circles. NEVER brush over concerns you spot, even if unrelated to the issue at hand. You MUST list any additional findings with your next reply.

**Iteration is fast.** Before diving into long reasoning chains or vscode sources: make a quick attempt to produce better diagnostics and ask the developer to run it. They will report back within the same conversation. This is almost always faster than trying to reason from first principles about VS Code internals.

**When something is unclear or behaving unexpectedly:**
1. Run the git commands the extension runs, inside the repo used to reproduce the problem. Don't assume their output. A wrong assumption is often the problem.
2. Add targeted logging and ask the developer to reproduce and share the output
3. If nothing is working as expected, look at the relevant VS Code source (cloned for you in `../vscode`)

**Unit-testable logic:** Create pure functions. A large part of the functionality relies on hard-to-automate scenarios - specific workspace setups or git history being a certain way. Make sure it at least operates on testable inputs and outputs.

## Non-Obvious Architecture

### Refresh Hierarchy — Use the Cheapest One That's Correct

From cheapest to most expensive:

1. **`refreshTreeOnly()`** — Re-renders from cached data. No git. Use for filter/display changes.
2. **`refreshPending(targetRepoPaths?)`** — Re-runs `git status` only, rebuilds from cached historical baseline. Use when working tree changes (file save, stage, discard). Supports targeting specific repos.
3. **`refresh({ targetRepoPaths? })`** — Re-runs git log for affected repos. Skips repo discovery. Supports `preserveHistoricalCache: true` (e.g. time window switch) and `targetRepoPaths` to scope to specific repos.
4. **`hardRefresh()`** — Clears everything including repo discovery. Only needed when the repo list may have changed (startup, refresh button).

**Historical data is cached across the max configured time window.** Switching time windows almost never requires a git call — `setTimeWindow()` checks whether the in-flight or cached data already covers the new window and falls back to `refreshTreeOnly()` if so. The incremental load fires threshold callbacks so smaller windows get data first.

### Manual Scan — Dormancy Is a Gate, Not a Mode Switch

`freshFileExplorer.freshFileLoading: "manual"` makes the fresh-files scan wait for
an explicit Refresh (an enum, not a boolean, so a future fully-manual mode needs no
settings migration). It's one predicate (`isScanDormant`) checked at two chokepoints
— `kickOffLoad()` and `refreshPending()`, both in `LoadOrchestrator` — not at every
call site. Add new automatic refresh triggers *above* those chokepoints and they're
covered for free.

Two rules keep it from breaking neighbouring features:

- **Repo discovery still runs while dormant.** `ensureReposDiscovered()` runs Phase 1
  of the load on its own (deduplicated against a concurrent full load in `RepoDiscovery`) and
  fires `onReposReady` without touching git log. Branch compare, auto-follow and the
  blame heatmap all resolve repos through it, so none of them go dark. It's called
  from activation, not just from the first tree render — the view may be hidden.
- **Explicit consumers arm; ambient ones stay gated.** Anything the user directly
  asked for — quick pick, Code Telescope finder, fresh-files search, the stonks panel,
  the heatmap toggle, filter-by-author/commit — routes through `ensureDataLoaded()`,
  which calls `armScan()`. Silently returning empty would look like a bug. Arming is
  sticky for the session.

  The test is who initiated the *call*. VS Code polls decoration providers for every
  visible file right after activation, so they must never arm: the file heatmap's
  provider checks `isScanDormant` and bails, while `handleToggleHeatmap` (a click)
  arms. Display-only commands (time window, grouping, sort order) don't arm either.

`dataLoaded` stays false while dormant, so `enterDormant()` clears
`ContextKeys.LOADING` explicitly — `package.json` `when` clauses depend on it.

**Cancellation:** `RefreshEpochGuard` (`refreshEpochGuard.ts`). `refresh()`, `hardRefresh()` and `cancelInFlight()` call `bump()`; the load path holds a `RefreshToken` and calls `assertLive()` at each async boundary, which throws `RefreshCancelledError` once a newer load started. Keep that check when adding async work to the load path.

## `files.exclude` is Per-Node, Not Global

The tree honors VS Code's `files.exclude` (`freshFileExplorer.respectFilesExclude`, default on). The non-obvious part: a glob is evaluated **relative to the workspace folder of the node it's rendered under**, so the *same* absolute file can be hidden under one root and shown under another. The motivating case (issue #3): a repo root added alongside its own `backend/` subfolder, with the root excluding `backend` — `backend/app.js` must vanish under the root node yet remain under the backend node. A single global "display map" cannot express this; don't try to filter `_freshFiles` once and reuse it everywhere.

- Pure glob matching: [filesExcludeMatcher.ts](src/fresh-files/filesExcludeMatcher.ts) — a faithful port of VS Code's own `vs/base/common/glob.ts` engine (not minimatch). A bare `backend` matches the path *and its ancestor prefixes* (mirrors the Explorer pruning the `backend` dir node); bare patterns stay root-anchored.
- Per-node application: [FilesExcludeFilter](src/fresh-files/filesExcludeFilter.ts). `isExcludedUnder(path, folder)` is the per-node check used by `buildTree`/`buildFlatList`/`buildRepoRootItems`. `isExcludedByOwner` / `filterByOwner` handle the flat lenses (group-by-author/commit, search) that have no node context.
- Both are pure/unit-tested; `FilesExcludeFilter` also holds the compiled-glob cache, which the provider invalidates on config change. `when`-clause (sibling) excludes are unsupported.

## Path Handling

- Git uses forward slashes; Windows uses backslashes. We try to stick to normalized paths `/`.
- Use and define branded types for different path variants
- `asAbsolutePath()` calls `normalizePath()` internally

## Git Command Execution

Always use **`execGitWithArgs(args[], cwd)`** — uses `spawn()` with an argument array, no injection risk. For large outputs, stream instead of buffering: `streamGitLogNameStatus` in `src/git/gitLogStream.ts`, or the diff-search parser's own `streamGitDiffOutput` (local to `diffSearchParser.ts`).

All of those sit on one primitive, **`spawnGitSettled`** in `src/git/gitSpawn.ts` — the only place that starts a git process. A `no-restricted-syntax` rule flags any call taking the literal `"git"` as its first argument (spawn, execFile, a promisified alias) outside it. Failures reject with **`GitError`** (stderr, exit code, timeout naming `freshFileExplorer.gitTimeout`); in new code read it as `error instanceof Error ? error.message : String(error)`, never `catch (e: any)` with `e.message`.

## Webview Message Protocol

The host↔webview boundary is a `postMessage` contract typed by discriminated
unions in `src/webview/messages.ts` (compiled by both tsconfigs). Every host
panel sends through a typed `_post(msg: XToWebview)` wrapper and types its
inbound handler as `XFromWebview`; webview scripts mirror this. **Never** call
`webview.postMessage({...})` with a bare object literal — it re-opens the `any`
hole and field drift ships green. See [docs/webview-message-protocol.md](docs/webview-message-protocol.md)
for the per-panel command tables and the enforcement rationale.

## Context Menus

Adding or changing a context menu item requires **both**:
1. The `menus` entry in `package.json` (with a `when` clause matching `contextValue`)
2. The correct `contextValue` set on the tree item (`FreshFileItem` and the other item classes)

Missing either side will silently not work. Valid context values can be found in `treeItemConstants.ts`, `BranchCompareContextValues` and `DiffSearchContextValues`. `packageJsonDrift.unit.test.ts` now catches a `when` clause naming a context value nothing produces; the reverse is still silent.

## Tree View — `collapsibleState` is sticky

VS Code's `TreeView` locks in a tree item's `collapsibleState` on the **first render** it sees for a given `id`. Subsequent refreshes that return an item with the same `id` but a different state are silently ignored — the item keeps whatever state it had on first appearance.

This bites async-loaded trees: if an item is rendered as `Collapsed` (or worse, `None`) while data is loading, then "fixed" to `Expanded` after data arrives, the tree stays collapsed forever — until a manual refresh that happens to skip the loading phase.

**Rule:** the *first* time an item id appears, its `collapsibleState` must already match what you eventually want. Avoid rendering placeholder loading states with the same id as the loaded version. Either:
- Render the loading state with the same `collapsibleState` you'd use post-load (e.g. expand the repo even while empty/loading — children populate later)
- Use a different `id` for loading vs loaded variants
- Suppress the placeholder entirely until data is ready

Examples in this codebase:
- [`FreshFileItem.forRepository`](src/fresh-files/freshFileTreeItems.ts) honors the `expanded` arg even when `isLoading` / `isLoadingHistorical` — without this, `autoExpandDepth` only "took effect" on manual refresh.
- [`RepoSectionItem`](src/branch-compare/branchCompareTreeItems.ts) never uses `None` — sections always render at least a "Loading…" / "No changes" message child, so the state is always meaningful.

The same lock is a tool: to re-apply a default state (Branch Compare's *Collapse All*, the pinned outline's expand-depth setting), re-issue the items under new ids.

## Keybindings

When a command is triggered via keybinding, `item` and `selectedItems` arguments are **undefined** — VS Code does not pass tree item context. Commands must fall back to `treeView.selection` to get the selected items. Pass the relevant `TreeView` references into the handler (see `handleDeleteFile`, `handleCopyFile`, `handleCompareSelected` for examples). For commands bound in multiple views (e.g. fresh files + pinned items), pass all tree views and use the first one with a non-empty selection — this gives you the focused view's selection, not a cross-view merge.

## Configuration

- All settings access goes through [ConfigService](src/config/configService.ts). Never read `vscode.workspace.getConfiguration` directly elsewhere — a `no-restricted-syntax` ESLint rule enforces this (configService.ts and tests excepted).

### `ConfigService` reads — keep scoped reads out of hot loops

`getConfiguration()` builds a fresh configuration snapshot each time. A single call is cheap; **thousands are not**.

`ConfigService` mitigates this centrally: it caches the default-scope `getConfiguration()` snapshot (`ConfigService.cfg()`) and rebuilds it only on `onDidChangeConfiguration`, so `getX()` reads are now plain lookups and consumers do **not** need their own per-value caches. Section/resource-scoped reads (`getConfiguration("files", uri)`) bypass the cache and are still relatively costly — keep those out of per-file loops. Never add a second caching layer on top of `ConfigService`.

- A new setting needs a `ConfigKeys` entry (`configKeyConstants.ts`) and must be classified as none / treeOnly / pending / hard in the exhaustive record of `configRefreshAction.ts`, or it won't compile.

## Commands

- `commandConstants.ts` - contains available command names
- tests enforce that commands in `package.json` are present in the constants and vice-versa
- command registration goes in `extension.ts`, implementation elsewhere 
- the same test file (`packageJsonDrift.unit.test.ts`) also checks settings ↔ `ConfigKeys`, context keys in `when` clauses, context values, submenus and keybindings.
- Commands that need a tree item or arguments built in code get `"when": "false"` in `menus.commandPalette`.

## Build guards

- `npm run pretest` runs compile, lint and `scripts/sizeRatchet.mjs`, which fails when the largest files grow past their line budget. Split a file rather than raising its budget.
- `@typescript-eslint/no-floating-promises` is an error: fire-and-forget calls need an explicit `void`.

## Conventions

- An unused positional parameter that must keep its slot (e.g. `selectedItems` in `(item, selectedItems, provider)` command handlers) gets a `_` prefix; `noUnusedParameters` is on. Delete unused *trailing* parameters instead.
- No file-header boilerplate ("Pure, vscode-free: tested against …"). A file-level note earns its place only for a constraint someone would otherwise break, e.g. "bundled into the settings webview" (no `vscode` import there).

## Useful concepts

- `findRepoForFile(folder, fileRelativePath)` - finds which repo a file belongs to. Critical to not reinvent as it covers tricky submodule scenarios.
- `decodeGitPath()` - Git octal path decoder
- `benchmark.ts` - a custom benchmark can be defined by adhering to these types. Include it in `perfBenchmarkPanel._initialize` and it will be runnable by the user through a webview UI