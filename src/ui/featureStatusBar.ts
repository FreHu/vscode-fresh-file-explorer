import * as vscode from "vscode";

export type StatusBarState =
  | { kind: "hidden" }
  | { kind: "active"; text: string; tooltip: string }
  | { kind: "warning"; text: string; tooltip: string }
  | { kind: "new-file"; text: string; tooltip: string }
  /** Visible but de-emphasized — feature is off and waiting for the user. */
  | { kind: "inactive"; text: string; tooltip: string };

/**
 * A reusable wrapper around a single VS Code status bar item.
 *
 * Callers describe what to show via a `StatusBarState` union and this class
 * handles all the `vscode.StatusBarItem` API details (show/hide, background
 * color, text, tooltip).  Each feature that wants a status bar entry creates
 * its own `FeatureStatusBar` instance with its own alignment/priority/command.
 */
export class FeatureStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(options: {
    alignment?: vscode.StatusBarAlignment;
    priority?: number;
    command?: string;
  } = {}) {
    this.item = vscode.window.createStatusBarItem(
      options.alignment ?? vscode.StatusBarAlignment.Left,
      options.priority ?? 0,
    );
    if (options.command) {
      this.item.command = options.command;
    }
  }

  update(state: StatusBarState): void {
    if (state.kind === "hidden") {
      this.item.hide();
      return;
    }

    this.item.text = state.text;
    this.item.tooltip = state.tooltip;

    if (state.kind === "warning") {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.color = undefined;
    } else if (state.kind === "new-file") {
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor("gitDecoration.addedResourceForeground");
    } else if (state.kind === "inactive") {
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor("descriptionForeground");
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }

    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
