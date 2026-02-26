import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;
let lastLogTime: number | undefined;

export function initializeLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Fresh File Explorer");
  context.subscriptions.push(outputChannel);
}

export function log(message: string, level: "info" | "warn" | "error" = "info"): void {
  if (!outputChannel) {
    return; // Guard against early calls before activation
  }
  const now = Date.now();
  const timeStr = new Date(now).toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm
  const delta = lastLogTime !== undefined ? `+${now - lastLogTime}ms` : "+0ms";
  lastLogTime = now;
  outputChannel.appendLine(`[${timeStr}] (${delta.padStart(8)}) ${logLevelIcons.get(level)} ${message}`);
}

export const logLevelIcons: Map<string, string> = new Map([
  ["info", "ℹ️"],
  ["warn", "⚠️"],
  ["error", "❌"],
]);

export function showOutputChannel(): void {
  outputChannel?.show();
}