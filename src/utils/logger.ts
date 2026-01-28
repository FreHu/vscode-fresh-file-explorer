import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

export function initializeLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Fresh File Explorer");
  context.subscriptions.push(outputChannel);
}

export function log(message: string, level: "info" | "warn" | "error" = "info"): void {
  if (!outputChannel) {
    return; // Guard against early calls before activation
  }
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${logLevelIcons.get(level)} ${message}`);
}

export const logLevelIcons: Map<string, string> = new Map([
  ["info", "ℹ️"],
  ["warn", "⚠️"],
  ["error", "❌"],
]);

export function showOutputChannel(): void {
  outputChannel?.show();
}