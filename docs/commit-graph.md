# Speed up git history reads with a commit-graph

Fresh File Explorer noticed that reading this repository's history was slow,
and the repository has no **commit-graph** — an optional git optimization
that makes exactly this kind of work faster.

## What it is

The commit-graph is a small binary file (`.git/objects/info/commit-graph`)
that caches the commit metadata git otherwise has to parse object-by-object
on every history walk: parent links, generation numbers, and — with
`--changed-paths` — Bloom filters recording which paths each commit touched.

Git uses it automatically once it exists. Nothing about your repository's
data, remotes, or workflow changes; it's a cache, and deleting the file
returns everything to how it was.

## Why it helps here

Fresh File Explorer runs `git log` over your recent history on load, and
path-scoped history reads for features like file history, repo pathspecs,
and diff search. The commit-graph speeds up the commit walk itself; the
`--changed-paths` Bloom filters let git skip whole commits during
path-limited logs without opening their trees — often the difference
between seconds and near-instant on large repositories.

## Benefits beyond this extension

The same cache speeds up anything that walks commits or answers reachability
questions in this repository, whoever asks: `git merge-base` (the slow
ancestry step before merges and rebases on large histories), `git branch
--contains` / `git tag --contains` / `git describe`, ahead/behind counts in
`git status` and push/fetch, and history views in other tools — VS Code's
built-in git support, GitLens, anything that shells out to `git log`.

`git maintenance start` additionally keeps the object store itself healthy
(loose-object cleanup, incremental repack), which speeds up git operations
across the board.

## Enable it

One-time build, from the repository root:

```
git commit-graph write --reachable --changed-paths
```

Recommended: also let git keep it (and the rest of the repo) maintained in
the background:

```
git maintenance start
```

`git maintenance start` registers a scheduled task (cron / Windows Task
Scheduler) that runs hourly, daily, and weekly jobs; the commit-graph is
kept up to date as part of those. It only registers the schedule — to also
run the jobs right now:

```
git maintenance run --task=commit-graph --task=loose-objects --task=incremental-repack
```

## Undo

Stop the background maintenance (keeps the commit-graph file):

```
git maintenance stop
```

Remove the commit-graph entirely by deleting the file(s):

```
.git/objects/info/commit-graph
.git/objects/info/commit-graphs/
```

Git falls back to parsing commit objects directly, exactly as before.
