// Size ratchet for the heavyweight, zero-direct-test coordinator files.
//
// These three files concentrate the project's bus-factor risk (see the
// maintainability review): large mutable coordinators with no direct unit
// coverage. The ratchet doesn't try to shrink them — it just freezes the
// ceiling so they can't grow further, forcing the established
// pull-out-a-testable-pure-function extraction pattern to continue.
//
// When you legitimately extract logic and a file shrinks, lower its ceiling
// here to lock in the win. The check fails the build if any tracked file
// exceeds its ceiling.

import { readFileSync } from "node:fs";

/** file path (repo-relative, POSIX) -> max allowed line count */
const CEILINGS = {
  // Bumped for files.exclude support: the pure matching/filtering logic lives in
  // filesExcludeMatcher.ts + filesExcludeFilter.ts (both unit-tested); only the
  // irreducible coordinator wiring (display-map setter hook, config dispatch)
  // landed here.
  "src/fresh-files/freshFileProvider.ts": 1618,
  "src/git/gitOperations.ts": 1316,
  "src/heatmap/blameHeatmapController.ts": 1169,
};

function lineCount(path) {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) { return 0; }
  // Count lines the way `wc -l` does: number of newline terminators, plus one
  // for a final non-empty line with no trailing newline.
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") { newlines++; }
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

let failed = false;
for (const [path, ceiling] of Object.entries(CEILINGS)) {
  let count;
  try {
    count = lineCount(path);
  } catch (err) {
    console.error(`size-ratchet: cannot read ${path} — ${err.message}`);
    failed = true;
    continue;
  }
  if (count > ceiling) {
    console.error(
      `size-ratchet: ${path} grew to ${count} lines (ceiling ${ceiling}). ` +
      `Extract testable logic into a separate module instead of growing this coordinator.`,
    );
    failed = true;
  } else if (count < ceiling - 50) {
    // A comfortable shrink — nudge the author to lock it in, but don't fail.
    console.warn(
      `size-ratchet: ${path} is now ${count} lines (ceiling ${ceiling}). ` +
      `Consider lowering its ceiling in scripts/sizeRatchet.mjs to lock in the reduction.`,
    );
  }
}

if (failed) {
  process.exit(1);
}
console.log("size-ratchet: all tracked coordinators within ceiling.");
