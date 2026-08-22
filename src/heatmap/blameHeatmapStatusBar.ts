import * as vscode from "vscode";

import { FeatureStatusBar } from "../ui/featureStatusBar";
import { ConfigService } from "../config/configService";
import { Commands } from "../commands/commandConstants";
import type { BlameHeatmapMode } from "./blameHeatmapController";

/**
 * The blame heatmap's status-bar entry plus the per-file display state that
 * drives it: warnings ("file too large"), the loading spinner, and the
 * "entirely new file" branch-mode variant.
 */
export class BlameHeatmapStatusBar implements vscode.Disposable {
  private readonly statusBar: FeatureStatusBar;
  /** fsPath → user-visible problem text (e.g. "file too large"). */
  private readonly warnings = new Map<string, string>();
  /** fsPath set for branch-mode files where every line is new (no pre-branch content). */
  private readonly newFiles = new Set<string>();
  /** fsPath set for files whose heatmap is currently being computed (drives the spinner state). */
  private readonly loadingFsPaths = new Set<string>();

  constructor(private readonly deps: {
    getMode(fsPath: string): BlameHeatmapMode | undefined;
    /** Saved baseline ref for the editor's repo, if any. */
    getSavedRef(editor: vscode.TextEditor | undefined): string | undefined;
    /** Baseline ref for the file's repo (branch mode display). */
    getBranchRef(fsPath: string): string | undefined;
  }) {
    this.statusBar = new FeatureStatusBar({
      alignment: vscode.StatusBarAlignment.Left,
      priority: 10,
      command: Commands.BLAME_HEATMAP_PICKER,
    });
  }

  setWarning(fsPath: string, message: string): void {
    this.warnings.set(fsPath, message);
  }

  clearWarning(fsPath: string): void {
    this.warnings.delete(fsPath);
  }

  setLoading(fsPath: string, loading: boolean): void {
    if (loading) { this.loadingFsPaths.add(fsPath); } else { this.loadingFsPaths.delete(fsPath); }
  }

  setNewFile(fsPath: string, isNew: boolean): void {
    if (isNew) { this.newFiles.add(fsPath); } else { this.newFiles.delete(fsPath); }
  }

  isNewFile(fsPath: string): boolean {
    return this.newFiles.has(fsPath);
  }

  update(editor: vscode.TextEditor | undefined): void {
    if (!ConfigService.getStatusBarHeatmapEnabled()) {
      this.statusBar.update({ kind: "hidden" });
      return;
    }
    const uri = editor?.document.uri;
    // Only show the indicator for real files. Output channels, settings, etc. → hide.
    if (!uri || uri.scheme !== "file") {
      this.statusBar.update({ kind: "hidden" });
      return;
    }
    const fsPath = uri.fsPath;

    const warning = this.warnings.get(fsPath);
    if (warning) {
      this.statusBar.update({
        kind: "warning",
        text: `$(color-mode) Heatmap: $(warning) ${warning}`,
        tooltip: warning,
      });
      return;
    }

    if (this.loadingFsPaths.has(fsPath)) {
      this.statusBar.update({
        kind: "active",
        text: `$(sync~spin) Heatmap…`,
        tooltip: "Computing blame heatmap.",
      });
      return;
    }

    const mode = this.deps.getMode(fsPath);
    if (!mode) {
      const savedRef = this.deps.getSavedRef(editor);
      this.statusBar.update({
        kind: "inactive",
        text: savedRef ? `$(color-mode) Heatmap: off (vs ${savedRef})` : `$(color-mode) Heatmap: off`,
        tooltip: savedRef
          ? `Click to enable the blame heatmap. Saved diff baseline: ${savedRef}.`
          : "Click to enable the blame heatmap (Age or Branch).",
      });
      return;
    }

    if (mode === "absolute") {
      this.statusBar.update({
        kind: "active",
        text: `$(color-mode) Heatmap: Age`,
        tooltip: "Blame heatmap: coloring by commit age. Click to change.",
      });
    } else {
      const ref = this.deps.getBranchRef(fsPath) ?? "branch";
      if (this.newFiles.has(fsPath)) {
        this.statusBar.update({
          kind: "new-file",
          text: `$(add) Heatmap: new file vs ${ref}`,
          tooltip: `Blame heatmap: this file is entirely new since ${ref}. Click to change.`,
        });
      } else {
        this.statusBar.update({
          kind: "active",
          text: `$(color-mode) Heatmap: vs ${ref}`,
          tooltip: `Blame heatmap: showing changes since ${ref}. Click to change.`,
        });
      }
    }
  }

  dispose(): void {
    this.statusBar.dispose();
  }
}
