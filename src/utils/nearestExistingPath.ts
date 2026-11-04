import * as path from "path";

/**
 * The path itself if it exists, else its closest existing ancestor folder. Used to
 * reveal "where a deleted file was": revealing a missing path silently does nothing.
 * Undefined when nothing up to the filesystem root exists.
 */
export async function nearestExistingPath(
  fsPath: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string | undefined> {
  let current = fsPath;
  for (;;) {
    if (await exists(current)) { return current; }
    const parent = path.dirname(current);
    if (parent === current) { return undefined; }
    current = parent;
  }
}
