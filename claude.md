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

**`refreshEpoch`** is incremented by `refresh()` and `hardRefresh()`. `updateFreshFiles()` checks it at each async boundary and throws `RefreshCancelledError` if a newer refresh started. Always preserve this check when adding async work to the load path.

## Path Handling

- Git uses forward slashes; Windows uses backslashes. We try to stick to normalized paths `/`.
- Use and define branded types for different path variants
- `asAbsolutePath()` calls `normalizePath()` internally

## Git Command Execution

Always use **`execGitWithArgs(args[], cwd)`** � uses `spawn()` with an argument array - no injection risk. For large outputs use the streaming variants `streamGitLogNameStatus` / `streamGitDiffOutput`.

## Context Menus

Adding or changing a context menu item requires **both**:
1. The `menus` entry in `package.json` (with a `when` clause matching `contextValue`)
2. The correct `contextValue` set in the `FreshFileItem` constructor

Missing either side will silently not work. Valid context values can be found in `treeItemConstants.ts`.

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

## Keybindings

When a command is triggered via keybinding, `item` and `selectedItems` arguments are **undefined** — VS Code does not pass tree item context. Commands must fall back to `treeView.selection` to get the selected items. Pass the relevant `TreeView` references into the handler (see `handleDeleteFile`, `handleCopyFile`, `handleCompareSelected` for examples). For commands bound in multiple views (e.g. fresh files + pinned items), pass all tree views and use the first one with a non-empty selection — this gives you the focused view's selection, not a cross-view merge.

## Configuration

- All settings access goes through [ConfigService](src/config/configService.ts). Never read `vscode.workspace.getConfiguration` directly elsewhere.

## Commands

- `commandConstants.ts` - contains available command names
- tests enforce that commands in `package.json` are present in the constants and vice-versa
- command registration goes in `extension.ts`, implementation elsewhere 

## Useful concepts

- `findRepoForFile(folder, fileRelativePath)` - finds which repo a file belongs to. Critical to not reinvent as it covers tricky submodule scenarios.
- `decodeGitPath()` - Git octal path decoder
- `benchmark.ts` - a custom benchmark can be defined by adhering to these types. Include it in `perfBenchmarkPanel._initialize` and it will be runnable by the user through a webview UI