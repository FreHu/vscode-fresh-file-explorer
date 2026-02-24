# Change Log

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