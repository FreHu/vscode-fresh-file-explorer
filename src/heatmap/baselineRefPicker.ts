import * as vscode from "vscode";

import { getAvailableBranches } from "../git/gitCommitQueries";
import { showError, showInfo } from "../extension/logger";

/**
 * Quick pick of the repo's branches and tags to use as the blame heatmap's
 * baseline; the picked ref name, or undefined when cancelled or none exist.
 */
export async function pickBaselineRef(repoRoot: string): Promise<string | undefined> {
  let branches;
  try {
    branches = await getAvailableBranches(repoRoot);
  } catch (err) {
    showError(
      "Blame heatmap: couldn't list branches and tags for the baseline.",
      `Blame heatmap: couldn't list branches and tags for the baseline — ${err}`,
    );
    return undefined;
  }

  if (branches.length === 0) {
    showInfo("Blame heatmap: no branches or tags to use as a baseline.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    branches.map(b => ({ label: b.name, description: b.relativeDate })),
    { placeHolder: "Branch or tag: lines changed since it get colored", title: "Blame Heatmap: Pick a Baseline" },
  );
  return picked?.label;
}
