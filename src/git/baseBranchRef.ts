/** The parts of VS Code's git `Branch` that say where a branch lives. */
export interface BranchLocation {
  name?: string;
  /** Set for a remote-tracking branch (e.g. name "main", remote "origin"). */
  remote?: string;
  /** A local branch's upstream, if it tracks one. */
  upstream?: { remote: string; name: string };
}

/**
 * The ref to compare against for a branch's base, which is also the name shown.
 * VS Code's getBranchBase returns a remote branch (name "main", remote "origin"),
 * so the remote has to be part of the ref: the bare name would be the local
 * `main`, which lacks whatever was pushed since the last pull. A local base
 * compares against its upstream when it has one, else itself.
 */
export function baseBranchRef(branch: BranchLocation): string | undefined {
  if (!branch.name) { return undefined; }
  if (branch.remote) {
    return branch.name.startsWith(`${branch.remote}/`) ? branch.name : `${branch.remote}/${branch.name}`;
  }
  return branch.upstream ? `${branch.upstream.remote}/${branch.upstream.name}` : branch.name;
}
