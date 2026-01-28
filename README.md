# Fresh File Explorer

A Visual Studio Code extension which provides a tree view showing only recently modified files based on recent Git history and your pending changes.

## Has this ever happened to you?

### 1. "I just cloned a large repo and don't know where to start"

You joined a new company and the codebase has thousands of files. Most haven't been touched in the last 75 years. But the file explorer shows everything, making it overwhelming to find where active development is happening.

| Approach                | How it works                                                                      | Friction                                                     |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Default VS Code**     | Browse folders manually, maybe search for recent commits in Source Control        | High - requires mental context switching, no visual overview |
| **GitLens**             | Use "Commits" view to see recent commits, then navigate to files from there       | Medium - commit-centric view, extra clicks to open files     |
| **Fresh File Explorer** | Open the Fresh Files panel, see all files modified in last 30 days as a file tree | Low - immediate visual overview, familiar tree navigation    |

---

### 2. "I swear this file was here at some point"

You remember a file existed, but it's not there. Was it renamed? Moved? Did you misremember the path? Have you been drinking again? It's someone else's fault _this time_, but you're questioning your own sanity.

| Approach                | How it works                                                         | Friction                                        |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| **Default VS Code**     | Search for the filename, find nothing, assume you're wrong           | High - no hint that deletion occurred           |
| **GitLens**             | Would need to think "maybe it was deleted" and search commit history | High - requires the right mental model          |
| **Fresh File Explorer** | Deleted files appear right where they used to be                     | Zero - it's still there, just marked as deleted |

---

### 3. "I accidentally deleted some files and need them back"

**Pain Point:** You deleted files and realize you need them. They're committed to git but you wish it was easier to get them back.

| Approach                | How it works                                                     | Friction                      |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------- |
| **Default VS Code**     | `git log --diff-filter=D`, then `git checkout <hash>^ -- <path>` | High - requires git expertise |
| **GitLens**             | Find the deletion commit, view file at revision, copy content    | Medium - several steps        |
| **Fresh File Explorer** | Deleted files are there, right-click → "Resurrect"               | Low - one-click restore. Works on multiple files at once.       |

---

### 4. "I made a commit and now I've lost track of what I was working on"

You make a commit but now your "pending changes" view is empty. You've lost the mental map of which files you were touching. This actually discourages small, frequent commits because you want to keep that overview.

| Approach                | How it works                                                                                 | Friction                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Default VS Code**     | Pending changes disappear after commit, must remember or check git log                       | High - punishes good commit practices                                                                           |
| **GitLens**             | Can view recent commits, but context switch required                                         | Medium - the information is there, but in a different place, and you can only have so many views open at a time |
| **Fresh File Explorer** | Set time window to "Last 7 days" - your committed files still appear, organized by directory | Low - commit freely, overview persists                                                                          |
### 5. "I was using Fresh File Explorer and it was going great, but then someone reformatted the entire codebase and now all the files are fresh"

**Pain Point:** A large automated change (formatting, linting, dependency updates) pollutes your view of what actually changed.

| Approach                | How it works                                                                                           | Friction                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Default VS Code**     | No built-in way to filter by author                                                                    | High - must use terminal commands           |
| **GitLens**             | Can filter by author in various views                                                                  | Medium - need to know where to look         |
| **Fresh File Explorer** | Filter out the person doing the formatting, or (it was _you_, wasn't it?) the commit where it was done | Low - visual multi-select, instant feedback |

---

## Features

### Time Window Selection

Switch between viewing pending (uncommitted) changes or files modified in configurable time periods.
Pending Changes mode shows uncommitted changes (esentially what the Source Control view would give you)

### Smart File Tree

Files are grouped by directory structure, with file counts on folders. Auto-expands to configurable depth.

### Deleted File Support

- Deleted files appear in the tree, clearly indicated
- **Exhume**: Open deleted file content in a read-only temp file (default action on clicking a deleted file)
- **Resurrect**: Restores the exhumed file to its original location

### Sync Status Notifications

Displays info at the top of the tree view:

- When you are behind/ahead of the remote (meaning you need to push/pull)
- When you are behind/ahead of the base branch (meaning you need to merge)

Both options can be individually disabled.

### Filtering

- **Filter by Author**: Hide files from specific authors
- **Filter by Commit**: Hide files from specific commits
- **Clear filters**

- Filters are temporary and reset when changing time windows

> **Note:** The extension tracks the _most recent_ commit per file only. If a file was modified by both a filtered author and a non-filtered author within the time window, the file will be hidden entirely (because the most recent commit is what's filtered). This is a deliberate simplification - for deeper history analysis, consider using something like GitLens or learning more than 5 git commands.

### Context Menu Actions

- Open / Open to Side - you can toggle whether clicking a file opens the file or a diff
- Reveal in Explorer / Source Control
- Discard Changes (for pending files)
- Resurrect (for deleted files)

### Multi-Repository Support

Works with:

- Folders containing multiple repos in subfolders
- Multi-root workspaces
- Worktrees

**Submodules:**

- Submodules are shown in the tree but not their contents.
- You can also see deleted submodules, but can't exhume them.

I wanted to do more with submodules just for the fun of it but turns out it's not fun at all.

## Extension Settings

Look under `freshfileexplorer.` to see all configurable settings.

## Comparison with GitLens

Fresh File Explorer is **not** a GitLens replacement. It's a focused tool for one specific workflow: navigating recently changed files.

| Feature                     |    Fresh File Explorer | GitLens                       |
| --------------------------- | ---------------------: | :---------------------------- |
| **Focus**                   | Recent file navigation | Comprehensive git integration |
| **Learning Curve**          |                Minimal | Significant                   |
| **File Tree View**          |     ✅ Primary feature | ✅ Available                  |
| **Blame/Annotations**       |                     ❌ | ✅ Excellent                  |
| **Commit Graph**            |                     ❌ | ✅ Visual graph               |
| **Line History**            |                     ❌ | ✅ Detailed                   |
| **Deleted File Restore**    |           ✅ One-click | ✅ Via commits                |
| **Author/Commit Filtering** | ✅ Visual multi-select | ✅ Via search                 |
| **Price**                   |                   Free | Free (Pro features paid)      |

**Use Fresh File Explorer if you want:** A simple, fast way to see and navigate recent changes.

**Use GitLens if you need:** Deep git integration, blame annotations, commit graphs, or advanced history exploration.

**Use both if you want:** Fresh Files for navigation + GitLens for investigation.

---

## Testimonials

> This is **above average** for a VS Code extension.
>
> _(a chatbot instructed to pretend to be Linus Torvalds)_