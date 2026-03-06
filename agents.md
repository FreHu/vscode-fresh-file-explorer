# Fresh File Explorer - Agent Maintenance Guide

This document captures non-obvious architectural decisions, gotchas, and critical patterns that an AI agent needs to know when maintaining this VS Code extension. It focuses on things you won't discover quickly from reading individual files.

## Core Concepts

### What This Extension Does

A tree view in the Explorer sidebar showing files modified within a configurable time window, based on Git history. Supports:

- **Pending changes mode**: Shows uncommitted changes from `git status`
- **Historical mode**: Shows files from `git log` within the time window, **plus** pending changes
- Deleted files with necromancy themed "exhume" (view/restore to temp) and "resurrect" (restore to original location) operations
- Filters by author/commit
- Multi-repo and multi-root workspace support

## Architecture

### Data Flow

1. `FreshFileProvider` is the central data store and TreeDataProvider
2. Loading is **lazy and incremental**: `getChildren()` detects no data is loaded and fires `updateFreshFiles()` as a non-blocking promise. It returns immediately with a spinner placeholder.
3. `updateFreshFiles()` runs in three phases per repository, firing `_onDidChangeTreeData` after each step so the tree updates progressively:
   - **Phase 1** (once per hard refresh): Repo discovery via `DataCollector.discoverAllRepos()`
   - **Phase 2**: Pending changes via `DataCollector.collectPendingForRepo()` — fast, shown immediately
   - **Phase 3**: Historical changes via `DataCollector.collectHistoricalForRepo()` — slow, shown after pending
4. Two separate file maps are maintained:
   - `freshFiles`: The combined live view (pending + historical) used by the tree
   - `historicalFiles`: The historical baseline; used to restore entries when pending changes are reverted
5. **Key insight**: `freshFiles` stores only file paths, not directories. Directories are virtual groupings created on-demand by `buildTree()`
6. `getChildren()` calls `buildTree()` for directory nodes, which dynamically constructs children from the flat `freshFiles` map
7. A `refreshEpoch` counter is incremented on every refresh. `updateFreshFiles()` checks it at each async boundary to abort stale loads if a newer refresh has started.

### Four Types of "Refresh"

- `hardRefresh()`: Clears everything including discovered repos, forcing full repo re-discovery and reload on next `getChildren()` call. Use when repos may have changed.
- `refresh()` (soft): Clears file cache but keeps discovered repos. Skips repo discovery on next load. Falls back to `hardRefresh()` if repos were never discovered.
- `refreshTreeOnly()`: Just fires the tree change event, reusing cached data (used for filter changes, display toggle, sync warnings).
- `refreshPending()`: Reloads only pending changes via `updatePendingFiles()`, rebuilding `freshFiles` from the cached `historicalFiles` baseline plus fresh pending entries. Falls back to `refresh()` if data not yet loaded.

### Commit history

We don't parse the full history. We are looking at the last commit that touched each file. This has some consequences on how filtering works, for example.

## Branded Types

The codebase uses TypeScript branded types for type safety. Key types in [types.ts](src/types.ts) and [pathTypes.ts](src/pathTypes.ts):

## Path Handling - Critical!

### Automatic Path Normalization

Windows uses backslashes, but Git uses forward slashes. The codebase automatically normalizes paths to forward slashes when creating `AbsolutePath` branded types:

```typescript
asAbsolutePath(path); // Automatically calls normalizePath() internally
```

**Rule**: Use `asAbsolutePath()` when creating absolute paths - normalization is automatic. No need to call `normalizePath()` separately.

### Path Security

[pathUtils.ts](src/utils/pathUtils.ts) contains `isPathWithinRoot()` to prevent path traversal attacks. Use this when writing files based on Git output (resurrect, etc.).

## Git Command Execution

### Two Approaches with Security Implications

1. **`execGitWithArgs(args[], cwd)`** - SAFE, no shell
   - Uses `spawn()` with argument array
   - Prevents shell injection from special filenames
   - **Use for any command involving ANYTHING from Git output**

2. **`execGitInDir(command, cwd)`** - Shell execution
   - Uses `exec()` with string command
   - OK for commands with no user/file input in the command string
   - Example: `git log --since="X.days.ago"` - the date is internal

### Git Path Encoding

Git encodes non-ASCII filenames as octal sequences. Use `decodeGitPath()` when parsing Git output.

## Distinguishing File Types (Important!)

A file in `freshFiles` can be:

- pending
- historical
- deleted

**Why it matters**: This can result in entirely different handling and extension behavior. Especially deleted files, as we don't have them immediately available.

## Tree Item Context Values

Context values control context menu visibility in `package.json`:

| `contextValue`    | Meaning                   | Key Actions              |
| ----------------- | ------------------------- | ------------------------ |
| `file`            | Committed file            | Open, Open Changes       |
| `pendingFile`     | Uncommitted change        | + Discard, Reveal in SCM |
| `deletedFile`     | Deleted file              | Resurrect, Exhume        |
| `folder`          | Directory                 | Expand Subtree           |
| `workspaceFolder` | Root when single repo     | -                        |
| `repoFolder`      | Repo root when multi-repo | -                        |
| `pinnedFile`      | Any pinned file           | Open, Copy Path, Unpin   |

**Rule**: When adding new context menu items, update both `package.json` menus and ensure correct `contextValue` is set in `FreshFileItem` constructor.

## Multi-Root / Multi-Repo Support

### Data Structure

```typescript
workspaceFolders: WorkspaceFolderInfo[] = [{
  path: AbsolutePath,
  name: string,
  gitRepos: string[]  // Relative paths, empty string = root is repo
}]
```

### Repository Discovery Order

1. Check if workspace folder root is a Git repo (`isGitRepository`)
2. If not, scan immediate subdirectories for Git repos (`discoverGitReposInSubdirs`)

### Finding Which Repo a File Belongs To

Use the `findRepoForFile()` helper function:

```typescript
const repoLocation = findRepoForFile(folder, fileRelativePath);
if (repoLocation) {
  // repoLocation.repoFullPath - absolute path to repo
  // repoLocation.repoRelativePath - relative path from workspace folder (empty if root)
  // repoLocation.filePathInRepo - path to file within the repo
}
```

## State Persistence

State persisted via `context.workspaceState`:

- `selectedTimeWindowDays`: Current time window selection
- `openChangesMode`: Toggle between open file / open diff on click

## Git Extension Integration

[gitExecutionListener.ts](src/gitExecutionListener.ts) integrates with VS Code's built-in Git extension:

1. Provides real-time sync warnings (ahead/behind)
2. Tracks branch names for each repo
3. Uses **debounced refresh** (500ms) to avoid excessive updates
4. Subscribes to `repo.state.onDidChange` for each repository

**Caution**: The Git extension API is not fully typed. Local interfaces mirror the expected shape.

## Command Pattern

Commands are registered in [extension.ts](src/extension.ts), handlers are in `commands/` folder.

VS Code passes:

- `item`: The clicked item
- `selectedItems`: All selected items if multi-select

**Rule**: Check `selectedItems` first for bulk operations (discard, resurrect).

## Configuration

All settings access goes through [ConfigService](src/config/configService.ts). Never read `vscode.workspace.getConfiguration` directly in other files.

Settings are defined in `package.json` under `contributes.configuration`.

## Common Gotchas

1. **Filters are cleared on time window change** - Authors/commits may differ between windows
2. **Context menus require `when` clause** - Update `package.json` when changing contextValue

## Testing and Debugging

- Add unit tests for simple functions with input/output
- For tricky problems, ask the developer to provide you with the output log
- Log enough information during development to make problems discoverable through the log
- For very tricky problems or issues unclear based on documentation, ask the developer to point you to vscode's own sources from which you can figure out how things really work.
