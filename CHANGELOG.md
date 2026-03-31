# Change Log

## [1.5.0]

### Compare selected files

Now available for fresh files and pinned items. 

Behavior:
- For 2 selected files, opens a simple comparison (like file explorer)

Unlike file explorer, you are not limited to two files
- For 3, opens a multi-diff (1-2, 1-3, 2-3). no further questions here, as the result set is still manageable
- For 3+, asks if you want to compare one vs rest or all permutations (1-2,1-3,1-4,2-3,3-4) and so on
  - If you choose one vs rest, you must also pick which is the base file

## [1.4.0]

### List view

The tree view can now be switched into a flat list. See also some new config options:

`freshFileExplorer.defaultGroupingMode`
`freshFileExplorer.defaultSortOrder`
`freshFileExplorer.flatList.labelStyle`

### Code Telescope integration

- The quick pick (CTRL+Q, F) can now be switched to open in the Code Telescope extension (guichina.code-telescope). 
- This provides a better search experience but remains fully optional (I don't make code telescope or install it for you).

You need to have the extension installed and enable `freshFileExplorer.codeTelescopeIntegration` for this to work.

## [1.3.0]
### Vastly improved performance
  
#### Percieved performance
  - Incremental loading (repo discovery, then pending, then historical changes)
  - Historical changes keep loading in the background up to your maximum configured time window.
    - You can also choose to fire an incremental update after each historical time window is ready (`freshFileExplorer.incrementalTreeLoading`). You probably don't need to enable this but it helped me make a more impressive gif of the loading process.
    - Changing time windows after the initial load no longer requires a refresh of git history, barring events like switching branches or pulling changes.
    - Changing time windows in the quick pick now does a live preview so I can show off how fast it is.
  
#### Real performance
  - Making changes in one repo will not trigger any refreshing in another.
  - Rendering a large tree is much faster.

### Right click options
- Copy + paste
- Delete
- Expand, copy structure now also available on repo level

### Submodule support

- Includes nested submodules, or the same repo appearing multiple times as submodules of different repos.
- I still consider this experimental but it's much better than the nothing in the previous version.

### Smaller things
- `[NEW]` - Reveal active file in tree. `freshFileExplorer.autoReveal` can be configured

- `[CHANGE]` - Pinned items are now a separate view. This was done so that they can properly stay at the top (or moved elsewhere). Previously they would be covered by sticky folders when scrolling down in the tree.
- `[NERFED]` - Showing added/removed lines (`freshFileExplorer.description.showLineChanges`) now only applies to pending changes. I didn't like the performance impact it had on the entire history.
- `[FIX]` - Discarding staged files silently doing nothing
- `[IMPROVED]` - Discard now asks if you want to discard unstaged/discard all/unstage/cancel (if applicable)
- `[IMPROVED]` - Staged status of files is now shown in the tree
- `[IMPROVED]` - Recursive expand occasionally failing to expand parts of the tree

## [1.2.1]
- `[FIX]` heatmap flickering
- `[FIX]` status labels for rename/copy not having proper names
- `[FIX]` potential inconsistency in commit ordering (author vs committer date)

## [1.2.0]
- [NEW] Pathspec can be set per-repo to limit git output
- [NEW] Scoping to folders
- [NEW] Right click options to copy file paths, remote url, or folder structure (as bullet points)
- [PERF] Loading is now in phases - repo discovery, then pending, then historical changes. It should now feel a lot faster (it isn't, but the view is usable long before it has all the data).
- [PERF] Loading git log now streams output instead of accumulating a potentially giant buffer. It's not faster but will always use almost no memory.
- [FIX] Heatmap would be incorrect if file explorer was in focus on startup (because we didn't load any data yet)

## [1.1.3]

- [NEW] Performance benchmark view for measuring load times 
- [PERF] Eliminate pointless refetches of git log in response to git listener (it was most of them)
- [PERF] Minor optimizations of git log (initial load)
- [CONFIG] Change counts disabled by default (because of perf)
- [DOCS] Added notes on security
- [DEPS] Removed the only runtime dependency
- [VSIX] Removed files that don't need to be there

## [1.1.2]
- [NEW] Create files action on folder level
- [CONFIG] Support older vscode engine (cursor runs on 1.105.1)

## [1.1.1]
- `[FIX]` Repos not in immediate subfolders not discovered https://github.com/FreHu/vscode-fresh-file-explorer/issues/1

## [1.1]
- `[NEW]` History search tools (pickaxe, -L, history view)
- `[NEW]` Change counts in tree view (lines added/removed)

## [1.0.7]
- `[NEW]` Menu button for search editor - open all found files
- `[NEW]` Menu button for search editor - copy paths of found files (absolute/relative)
- `[NEW]` Create new files directly from the tree view - right-click any file to create a sibling file
- `[NEW]` Support for creating multiple files and nested folder structures (e.g., `folder/file1.ts,file2.ts`)
- `[NEW]` Sort order options - sort files by name, date (newest first), or author
- `[NEW]` Consolidated "View Options" menu to reduce toolbar clutter (grouping, sorting, and filters)
- `[IMPROVEMENT]` Pending files now use actual file modification time for accurate date sorting
- `[IMPROVEMENT]` Streamlined toolbar - moved less common actions to overflow menu
- `[REMOVED]` "Expand All" from toolbar, it was janky anyway (still available via right-click on folders)

## [1.0.6]
- `[NEW]` Search in found files
- `[REWORK]` Search include pattern length limitation - no longer truncates, now batches into multiple search editors
- `[CONFIG]` Search editor is now the default preference

## [1.0.5]
- `[NEW]` Open commit - right click a file to open its last commit in a multi-diff editor
- `[REMOVED]` Welcome view with initialize repository button (pretty useless and briefly flashed during loading before we figure out there is a repo)
- `[FIX]` Open changes of new file in git history was broken

## [1.0.4]
- `[NEW]` Grouping options
- `[NEW]` Heatmap

## [1.0.3]
- `[NEW]` Pin items to the top of the view or use the section as a todo list

## [1.0.2]

- `[NEW]` Open files or search via new quick pick (`CTRL+Q F`)
- `[NEW]` Setting to toggle where search opens (view/editor)
- `[FIX]` Repo root now shows total file count
- `[DOCS]` Readme improved, added pictures

## [1.0.1]

- `[NEW]` Added an action to launch a fulltext search across fresh files. This has some limitations (see readme)

## [1.0.0]

- Initial release