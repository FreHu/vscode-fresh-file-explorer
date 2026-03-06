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

/**
 * Shows an information message to the user, and optionally logs it.
 * @param logMessage - Pass `true` to log the display message as-is, or a string to log a different message.
 */
export function showInfo(displayMessage: string, logMessage?: string | true): void {
  vscode.window.showInformationMessage(displayMessage);
  if (logMessage === true) {
    log(displayMessage);
  } else if (typeof logMessage === "string") {
    log(logMessage);
  }
}

/**
 * Shows a warning message to the user, and optionally logs it.
 * @param logMessage - Pass `true` to log the display message as-is, or a string to log a different message.
 */
export function showWarning(displayMessage: string, logMessage?: string | true): void {
  vscode.window.showWarningMessage(displayMessage);
  if (logMessage === true) {
    log(displayMessage, "warn");
  } else if (typeof logMessage === "string") {
    log(logMessage, "warn");
  }
}

/**
 * Shows an error message to the user, and optionally logs it.
 * @param logMessage - Pass `true` to log the display message as-is, or a string to log a different message.
 */
export function showError(displayMessage: string, logMessage?: string | true): void {
  vscode.window.showErrorMessage(displayMessage);
  if (logMessage === true) {
    log(displayMessage, "error");
  } else if (typeof logMessage === "string") {
    log(logMessage, "error");
  }
}