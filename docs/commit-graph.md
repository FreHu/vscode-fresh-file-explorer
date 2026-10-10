# Speed up git history reads with a commit-graph

Reading this repository's history took a while, and the repository has no **commit-graph**, an optional git cache that speeds up exactly this kind of work. (Don't want this hint? Pick *Don't ask again*, or turn off `freshFileExplorer.warnMissingCommitGraph`.)

## What it is

A small file in the repository's object store (`objects/info/commit-graph`) that caches what git otherwise parses commit by commit on every history walk: parent links, generation numbers and, with `--changed-paths`, which paths each commit touched. Git uses it automatically once it exists. Your data, remotes and workflow don't change; it's a cache.

## Why it helps

Fresh File Explorer runs `git log` over your recent history on load, plus path-limited logs for file history, pathspecs and diff search. The commit-graph speeds up the walk itself, and the changed-paths filters let git skip commits that didn't touch a path without opening them. It also speeds up everything else that walks commits in this repo: merge-base before merges and rebases, `--contains`, ahead/behind counts, and other git tools.

## Enable it

From the repository root, build it once:

```
git commit-graph write --reachable --changed-paths
```

Recommended: let git keep it up to date, along with the rest of the object store:

```
git maintenance start
```

This registers the repo for git's hourly / daily / weekly background maintenance (cron or Windows Task Scheduler).

## Undo

Stop background maintenance for this repo (the commit-graph stays):

```
git maintenance unregister
```

(`git maintenance stop` would stop it for every registered repo on the machine.)

To remove the commit-graph, delete `objects/info/commit-graph` and `objects/info/commit-graphs/` inside the repo's git directory. That's `.git/` in a normal checkout; in a worktree or submodule, `git rev-parse --git-common-dir` prints it. Git falls back to reading commits directly, as before.
