/** Arguments for the working-tree status every view parses with {@link parseStatusZ}. */
export const STATUS_Z_ARGS = ["status", "--porcelain=v1", "-z", "-uall"];

export interface StatusEntryZ {
  /** Raw two-letter code: index side, then worktree side (" M", "M ", "MM", "R ", "??"). */
  xy: string;
  pathInRepo: string;
  /** Original path of a rename or copy. */
  renameSource?: string;
}

/**
 * Parse `git status --porcelain=v1 -z`. Each entry is `XY path\0`; a rename or copy
 * (R or C in either column) is `XY new\0old\0`. With -z git writes paths verbatim:
 * no quoting, no octal escapes, so nothing is decoded. Ignored entries (`!!`) are dropped.
 */
export function parseStatusZ(output: string): StatusEntryZ[] {
  const fields = output.split("\0");
  const out: StatusEntryZ[] = [];
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i++];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const pathInRepo = entry.slice(3);
    const renamed = /[RC]/.test(xy) && xy !== "??";
    const renameSource = renamed ? fields[i++] || undefined : undefined;
    if (xy === "!!") continue;
    out.push(renameSource ? { xy, pathInRepo, renameSource } : { xy, pathInRepo });
  }
  return out;
}
