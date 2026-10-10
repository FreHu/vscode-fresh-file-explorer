/**
 * Switching to the branch you were comparing against flips the blame
 * heatmap's baseline to the branch you just left, so it keeps showing "what
 * changed relative to where you came from" without a manual re-pick.
 *
 * Returns the new baseline ref, or undefined when nothing should change: not
 * in Baseline mode, no baseline, an unknown or unchanged branch, or a switch to
 * any branch other than the baseline.
 */
export function flippedBaseRef(change: {
  from: string | undefined;
  to: string | undefined;
  mode: string | undefined;
  baseRef: string | undefined;
}): string | undefined {
  const { from, to, mode, baseRef } = change;
  if (mode !== "branch" || !baseRef || !from || !to || from === to) { return undefined; }
  return to === baseRef ? from : undefined;
}
