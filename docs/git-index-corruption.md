# Oh no!

## Git index corruption

Fresh File Explorer read `.git/index` for a repository and git reported it as
corrupt (for example `fatal: index file corrupt` or `error: bad signature
0x00000000`). This usually follows a crash, power loss, or forced process
kill while git was mid-write to the index — the rename onto `.git/index` can
land durably while the data it points at doesn't.

Pending changes (modified/staged/untracked/deleted files) can't be read while
the index is in this state, so they won't appear in the tree until it's
fixed. Committed history is unaffected — it doesn't go through the index.

Any other extensions that interact with this git repo may fail to work or be subtly wrong until this is fixed.

## Fix

From the repository root:

```
git read-tree HEAD
```

This rebuilds the index from the last commit. Any changes you had staged
will be unstaged (the underlying working-tree edits are untouched); redo
`git add` for anything you want staged again.

If that also fails, remove the index and let git regenerate it:

```
rm .git/index
git reset
```

Refreshing fresh files should be enough for this extension, but reload the editor just to be sure.
