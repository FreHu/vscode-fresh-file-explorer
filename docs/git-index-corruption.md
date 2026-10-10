# Oh no! Git index corruption

Git reported this repository's index as corrupt (for example `fatal: index file corrupt` or `error: bad signature 0x00000000`) when Fresh File Explorer asked it for pending changes. This usually follows a crash, power loss or forced kill while git was writing the index.

Until it's fixed, pending changes (modified, staged, untracked, deleted files) can't be read, so they're missing from the tree. Committed history is unaffected. Other git tools working on this repo may misbehave too.

## Fix

From the repository root:

```
git read-tree HEAD
```

This rebuilds the index from the last commit. Anything you had staged is unstaged (your file edits stay); `git add` it again.

If that fails too, delete the index and let git regenerate it:

```
rm "$(git rev-parse --git-dir)/index"
git reset
```

(`git rev-parse --git-dir` finds the right folder in worktrees and submodules too, where `.git` is a file.)

Then refresh Fresh Files.
