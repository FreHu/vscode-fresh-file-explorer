# Heatmaps

Heatmpas help visualize how recent the work in your repo is, but at different scales:

- **File heatmap** — colors files in the tree (and File Explorer) by how recently they were last modified. Answers *"which files have been touched recently?"* at a glance.
- **Blame heatmap** — colors lines inside a file. Two sub-modes: 
  - absolute age - *"which parts of this file are fresh?"*
  - baseline - *"what is happening here compared to the baseline (e.g. last release branch/tag)?"*

The colors use an 8-color palette (`age1..age8`), so a file glowing bright in the tree will glow bright at the line level too.
- colors of the file heatmap are reused
- the baseline heatmap adds a second 8-color greenish palette for lines added since the baseline

## How the buckets work

Both heatmaps split the age signal into 8 color buckets, `age1` (most recent) through `age8` (oldest / out of window). The mapping uses a non-linear curve so recent edits get more distinction than ancient ones — what you touched today vs 3 days ago is more likely to fall in different buckets, while "2 years ago" and "3 years ago" are more likely to blend into the same bucket.

Exact day ranges depend on the active window.

## File heatmap

Colors files in the Fresh Files view and File Explorer by their last modification date. Brighter = more recent.

![file heatmap](../img/heatmap.png)

Toggle from the Fresh Files view (`...` menu, or *Toggle Heatmap Coloring* command). The coloring uses your active time window:

- Within the window: bucketed across `age1..age7`.
- Older than the window: lumped into `age8` ("even older than that"), kept distinct so you can tell within-window-but-old apart from really-out-of-window.

Switching time windows reframes the signal — useful for zooming the heatmap to your timeframe.

## Blame heatmap

Per-line gutter coloring + a faint background wash inside the editor — the same recency signal as the file heatmap, taken one level deeper.

Use it to answer:

- *"Which lines in this big function did I just change, and which have been around for a while?"*
- *"What did **this** branch actually touch in this file vs. main?"*
- *"What got deleted from this file since I branched off — and can I get it back?"*

### Modes

- **Age** — line color reflects recency of the last commit on that line. Other blame tools surface who/when textually — hover popups, inline annotations — and stop there. This one paints the file. The pattern reads at a glance: fresh code stands out, ancient code fades. Drill into the metadata only when you actually want it. The recency window auto-derives from the file's own oldest line, so all 8 buckets get used regardless of how old the file is overall.
- **Branch / Tag** — colors only lines changed since a chosen baseline ref. Pre-baseline lines stay uncolored. Added lines get a distinct (green) palette; modified lines keep the age palette. Pure deletions surface as red gutter badges with the deleted line count.

### Activation surfaces

- **Status bar** (bottom-left, `Heatmap: …`) — click to open the rich picker. Shows current mode, saved baseline ref, and warnings inline (`not in a git repo`, `no blame data`, etc.).
- **Right-click on the gutter** — `Blame Heatmap >` submenu with direct access to Age / Branch saved / Pick / Turn off / Diff vs baseline / Clear baseline / Toggle auto-apply.
- **Right-click on a deletion badge** — `Copy baseline lines` / `Restore from baseline` (right-click, since left-click area is owned by the breakpoint glyph).
- **Right-click in the editor** — `Diff with Branch / Tag…` opens a regular diff editor against the saved baseline. Prompts for a ref on first use; saves it for reuse.

### Persistence

- Last used mode and chosen baseline (per repo) survive window reloads.
- Auto-apply re-renders the heatmap on newly opened tabs. Multi-repo aware — skips silently when the active editor's repo has no saved baseline, never pops an unwanted picker.

### Edge cases

- File added since baseline → no decorations, status bar shows `Heatmap: new file vs <ref>`.
- Restoring a deleted block must save the document or the deletion marker would reappear.

### Performance

- `git blame` runs once per file, results cached. Re-applies on text change debounced 1.5s.
- Configurable max line count limit. "No blame because file is over limit" vs "no blame for other reasons (e.g. new file)" is distinguishable in the status bar.
- Branch mode caches the merge-base SHA per `(repo, ref)`, invalidates on any git state change for that repo (HEAD move, fetch, branch switch).
- Status bar shows a spinner during compute so slow files don't appear stuck.

## Configuration

### Settings

- `freshFileExplorer.blameHeatmap.autoApply` (default: `true`) — auto-apply the blame heatmap to newly opened tabs.
- `freshFileExplorer.blameHeatmap.backgroundOpacity` (default: `0.1`) — opacity of the per-line background wash in the blame heatmap. Recommended low (0.05–0.15).
- `freshFileExplorer.blameHeatmap.maxFileLines` (default: `1500`) — skip the blame heatmap on files above this line count to keep `git blame` fast.

### Colors

`workbench.colorCustomizations` accepts all 16 color IDs:

```jsonc
"workbench.colorCustomizations": {
    "freshFileExplorer.heatmap.age1": "#FF0000",
    "freshFileExplorer.heatmap.age2": "#FF4400",
    "freshFileExplorer.heatmap.age3": "#FF8800",
    "freshFileExplorer.heatmap.age4": "#FFCC00",
    "freshFileExplorer.heatmap.age5": "#AACC00",
    "freshFileExplorer.heatmap.age6": "#55AA00",
    "freshFileExplorer.heatmap.age7": "#228800",
    "freshFileExplorer.heatmap.age8": "#006644",

    // Baseline heatmap only — added-since-baseline palette
    "freshFileExplorer.heatmap.added1": "#00E676",
    "freshFileExplorer.heatmap.added2": "#26A69A",
    "freshFileExplorer.heatmap.added3": "#4CAF50",
    "freshFileExplorer.heatmap.added4": "#388E3C",
    "freshFileExplorer.heatmap.added5": "#2E7D32",
    "freshFileExplorer.heatmap.added6": "#558B2F",
    "freshFileExplorer.heatmap.added7": "#33691E",
    "freshFileExplorer.heatmap.added8": "#666666"
}
```

The `age*` palette is shared between the file heatmap and the blame heatmap's modified-line coloring. The `added*` palette is blame-only. Light/dark/high-contrast variants are pre-registered, so overrides apply across themes.

#### Per-theme overrides

`workbench.colorCustomizations` supports theme-scoped sections — wrap the IDs in a `"[ThemeName]"` block to apply only when that theme is active. Useful when you want different palettes per theme without flipping settings every time you switch:

```jsonc
"workbench.colorCustomizations": {
    // Applies to every theme unless overridden below
    "freshFileExplorer.heatmap.age1": "#FF0000",

    // Exact theme name match
    "[Default Dark Modern]": {
        "freshFileExplorer.heatmap.age1": "#00E5FF",
        "freshFileExplorer.heatmap.age8": "#444444"
    },

    // Wildcard — matches any theme whose name contains "Light"
    "[*Light*]": {
        "freshFileExplorer.heatmap.age1": "#0066CC",
        "freshFileExplorer.heatmap.age8": "#BBBBBB"
    }
}
```

Theme-scoped overrides win over the unscoped ones for matching themes; everything else falls back to the unscoped value, then the registered default.
