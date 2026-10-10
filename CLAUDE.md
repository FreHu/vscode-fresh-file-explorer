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

The tree honors VS Code's `files.exclude` (`freshFileExplorer.respectFilesExclude`, default on). A glob is evaluated **relative to the workspace folder of the node it's rendered under**, so the *same* file can be hidden under one root and shown under another (issue #3: a repo root excluding `backend` next to its own `backend/` folder root). Don't filter `_freshFiles` once and reuse it everywhere.

- Glob matching: [filesExcludeMatcher.ts](src/fresh-files/filesExcludeMatcher.ts), a port of VS Code's own `vs/base/common/glob.ts` (not minimatch). A bare `backend` also matches ancestor prefixes, like the Explorer pruning that folder.
- Per-node application: [FilesExcludeFilter](src/fresh-files/filesExcludeFilter.ts), which also owns the compiled-glob cache (the provider only calls `invalidate()` on config change). `isExcludedUnder(path, folder)` is used by `buildTree` / `buildFlatList` / `buildRepoRootItems`; `isExcludedByOwner` / `filterByOwner` serve the flat lenses (group by author/commit, search). `when`-clause (sibling) excludes are unsupported.

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
2. The item setting that `contextValue` — from the constants in `TreeItemContextValues` (`treeItemConstants.ts`), `BranchCompareContextValues` or `DiffSearchContextValues`

`packageJsonDrift.unit.test.ts` fails when a `when` clause names a context value nothing produces. The reverse (an item whose value no menu uses) still fails silently.

## Tree View — `collapsibleState` is sticky

VS Code's `TreeView` locks in a tree item's `collapsibleState` on the **first render** of its `id`; a later refresh with the same id and a different state is ignored. So an item rendered `Collapsed` (or `None`) while loading stays that way after the data arrives.

**Rule:** the first time an id appears, its `collapsibleState` must already be the one you want. Either render the loading state with the final state (`FreshFileItem.forRepository` expands even while loading; `RepoSectionItem` never uses `None`), give loading and loaded variants different ids, or don't render a placeholder.

The same lock is a tool: to re-apply a default state (Branch Compare's *Collapse All*, the pinned outline's expand-depth setting), re-issue the items under new ids.

## Keybindings

When a command is triggered via keybinding, `item` and `selectedItems` arguments are **undefined** — VS Code does not pass tree item context. Commands must fall back to `treeView.selection` to get the selected items. Pass the relevant `TreeView` references into the handler (see `handleDeleteFile`, `handleCopyFile`, `handleCompareSelected` for examples). For commands bound in multiple views (e.g. fresh files + pinned items), pass all tree views and use the first one with a non-empty selection — this gives you the focused view's selection, not a cross-view merge.

## Configuration

- All settings access goes through [ConfigService](src/config/configService.ts); a `no-restricted-syntax` ESLint rule bans `vscode.workspace.getConfiguration` elsewhere (configService.ts and tests excepted).
- `getX()` reads come from a cached snapshot that `ConfigService.invalidate()` drops on every config change, so they're cheap anywhere; don't add a second cache on top. Section- or resource-scoped reads (`getConfiguration("files", uri)`) bypass the cache — keep those out of per-file loops.
- A new setting needs a `ConfigKeys` entry (`configKeyConstants.ts`) and must be classified as none / treeOnly / pending / hard in the exhaustive record of `configRefreshAction.ts`, or it won't compile.

## Commands

- `commandConstants.ts` holds the command ids; registration goes in `extension.ts`, implementation elsewhere.
- `packageJsonDrift.unit.test.ts` keeps `package.json` and the code in sync: commands, settings ↔ `ConfigKeys`, context keys in `when` clauses, context values, submenus and keybindings.
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