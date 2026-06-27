/**
 * Returns true if the file has changes staged in the index (X position of XY porcelain code).
 * Examples: "M ", "MM", "A ", "AM", "D ", "MD", "R ", "RM"
 */
export function hasStagedChanges(status: string): boolean {
  return status.length === 2 && status !== "??" && status !== "!!" && status[0] !== " ";
}

/**
 * Returns true if the file has changes in the working tree (Y position of XY porcelain code).
 * Examples: " M", "MM", "AM", " D", "MD"
 */
export function hasUnstagedChanges(status: string): boolean {
  return status.length === 2 && status !== "??" && status !== "!!" && status[1] !== " ";
}

/**
 * Returns true if the file has staged changes but no working-tree changes.
 * These are the silent no-op cases for `git checkout -- <file>`.
 * Examples: "M ", "A ", "D ", "R "
 */
export function isStagedOnly(status: string): boolean {
  return hasStagedChanges(status) && !hasUnstagedChanges(status);
}
