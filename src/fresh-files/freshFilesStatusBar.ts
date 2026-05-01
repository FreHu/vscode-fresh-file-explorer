import * as vscode from "vscode";
import { FeatureStatusBar } from "../ui/featureStatusBar";
import { FreshFileProvider } from "./freshFileProvider";

/**
 * Steady status-bar entry that reports Fresh Files' loading progress.
 *
 * Always visible (no hide-when-idle flicker). Three observable states:
 *   - **Discovering**  spinner + "Discovering repos…"
 *   - **Loading**      spinner + "Loading 2/5"
 *   - **Idle**         "Fresh files" (or "Fresh files: no repos" when the
 *                       workspace has none)
 *
 * Re-evaluated on every `onDidChangeTreeData` fire — that event already
 * triggers at every transition we care about (discovery done, repo loaded,
 * historical loaded), so we don't need a dedicated emitter.
 */
export class FreshFilesStatusBar implements vscode.Disposable {
  private readonly statusBar: FeatureStatusBar;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly freshFileProvider: FreshFileProvider) {
    this.statusBar = new FeatureStatusBar({
      alignment: vscode.StatusBarAlignment.Left,
      priority: 11, // sits just left of the blame heatmap entry (priority 10)
      command: "freshFileExplorer.focus",
    });

    this.subscriptions.push(
      this.freshFileProvider.onDidChangeTreeData(() => this.update()),
    );
    this.update();
  }

  private update(): void {
    const { state, totalRepos, loadedRepos } = this.freshFileProvider.getLoadingProgress();
    if (state === "discovering") {
      this.statusBar.update({
        kind: "active",
        text: `$(sync~spin) Discovering repos…`,
        tooltip: "Fresh Files: discovering git repositories in the workspace.",
      });
      return;
    }
    if (state === "loading") {
      this.statusBar.update({
        kind: "active",
        text: `$(sync~spin) Loading ${loadedRepos}/${totalRepos}`,
        tooltip: `Fresh Files: ${loadedRepos} of ${totalRepos} repos loaded.`,
      });
      return;
    }
    // Idle.
    if (totalRepos === 0) {
      this.statusBar.update({
        kind: "inactive",
        text: `$(folder) Fresh files: no repos`,
        tooltip: "Fresh Files: no git repositories in the workspace.",
      });
      return;
    }
    this.statusBar.update({
      kind: "active",
      text: `$(check) Fresh files`,
      tooltip: `Fresh Files: ${totalRepos} repo${totalRepos === 1 ? "" : "s"} loaded.`,
    });
  }

  dispose(): void {
    this.statusBar.dispose();
    for (const sub of this.subscriptions) { sub.dispose(); }
  }
}
