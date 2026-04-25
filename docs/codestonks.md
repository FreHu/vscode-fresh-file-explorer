# CodeStonks

CodeStonks is a visual analytics panel that charts the evolution of your codebase over time. It turns your commit history into interactive, stacked time-series charts — giving you a high-level view of how the codebase is growing, who's contributing, and how activity patterns change.

It doesn't actually do anything stonks-related, just uses TradingView as an inspiration for the UI. The charts reuse local git history data the extension already loads on startup based on your configured time windows.

## Watchlist

The right sidebar shows all repositories in your workspace. Click a repo to load its chart data.

| Column | Description |
|--------|-------------|
| **Repo** | Repository name. Click to select. |
| **Δ Files** | Last commit's file breakdown: `+added` `~modified` `-deleted`, color-coded. |

The **last commit hash** (clickable — opens the commit) and **message** are shown below the repo name.

### Controls

- **Time window** — How far back to look - based on your configured time windows.
- **X-axis mode** — `Per commit` shows every commit individually. `Per day/week/month` aggregates commits into buckets.

## Chart sections

Toggle each section on or off in the sidebar. Sections stack vertically and share the same horizontal axis.

### Files in repo

Cumulative file count at each point in time. A steadily rising line means the codebase is growing; a plateau means activity without net new files.

### Files changed

Bar chart of files touched per commit (or per bucket in aggregated modes). Green bars = net additions, red bars = net deletions.

### Unique authors *(commit mode only)*

Rolling count of distinct commit authors over a configurable window. Useful for spotting periods of concentrated vs. distributed contributions.

- **Window size**: Number of commits in the rolling window (default: 10).

### Author concentration *(commit mode only)*

Percentage of commits attributable to the top-X most active authors within the rolling window. High concentration means a few people are doing most of the work.

- **Top X**: Number of top authors to include (default: 1).

### Commit velocity

Number of commits that share the same calendar day (in commit mode) or the commit count per bucket (in aggregated modes). Spikes indicate bursts of activity.

### Churn rate

Files changed as a percentage of total files in the repository. High churn on a large codebase may signal instability or a major refactor.

### Avg commit size

Average number of files changed per commit. In commit mode, this is a rolling average over a configurable window. In aggregated modes, it's the per-bucket average.

- **Window size**: Number of commits in the rolling window (default: 10).

### Activity heatmap

A 7×24 grid showing when commits land, broken down by day of week (rows) and hour of day (columns). Darker cells = more commits at that time.

Useful for spotting:
- **Timezone distribution** — where in the world your contributors are
- **Crunch patterns** — late night or weekend bursts
- **Work rhythm** — morning vs. afternoon commit tendencies

The heatmap reflects the currently visible data (respecting the time window and any zoom applied to the chart).

## Comparing repos

Enable **Compare repos** in the sidebar, then check individual repos to overlay their "Files in repo" lines on the same chart. Each repo gets a distinct color shown as a swatch next to its name. This only works in time-based modes (per day/week/month) — not per-commit, since commits don't align across repos.

## Interactions

| Action | Effect |
|--------|--------|
| **Drag** on the chart | Select a range to zoom in |
| **Double-click** | Zoom out one level |
| **Shift + scroll** | Pan horizontally when zoomed |
| **Hover** | Tooltip with detailed stats for that point |
| **Click commit hash** in watchlist | Opens that commit in the editor |

## Max ticks

Controls the maximum number of data points rendered at once before panning kicks in. Lower values improve responsiveness of the chart. Default: 1000.
