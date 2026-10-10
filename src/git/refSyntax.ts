// Pure, vscode-free: also bundled into the settings webview.

/**
 * `N` for a `HEAD~N` ref (`HEAD~` alone counts as 1), otherwise undefined.
 * Only the first-parent `~` form: it is the one that means "the last N commits".
 */
export function parseHeadOffset(ref: string): number | undefined {
  const m = /^HEAD~(\d*)$/.exec(ref.trim());
  if (!m) { return undefined; }
  return m[1] === "" ? 1 : Number(m[1]);
}
