/** Status codes from git diff-tree --name-status. */
export type DiffStatus = "A" | "D" | "M" | "R" | "C" | "T";

/**
 * The status letter of a diff-tree status field ("M", "R100", ...). git's other letters (U unmerged,
 * X unknown, B broken pair) still name a file present on both sides, so they open as a modification
 * rather than being dropped by a switch over DiffStatus.
 */
export function toDiffStatus(statusField: string): DiffStatus {
  const letter = statusField[0];
  switch (letter) {
    case "A":
    case "D":
    case "M":
    case "R":
    case "C":
    case "T":
      return letter;
    default:
      return "M";
  }
}
