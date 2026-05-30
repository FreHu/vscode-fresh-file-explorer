import * as vscode from "vscode";
import { DeltaTracker, formatDelta } from "./deltaTimer";

let outputChannel: vscode.LogOutputChannel | undefined;
const deltas = new DeltaTracker();

export function initializeLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Fresh File Explorer", { log: true });
  context.subscriptions.push(outputChannel);
}

export function log(message: string, level: "info" | "warn" | "error" = "info", now: number = Date.now()): void {
  if (!outputChannel) {
    return; // Guard against early calls before activation
  }
  const delta = deltas.tick(now);
  // channel.info / .warn / .error — the channel prepends local time + level.
  outputChannel[level](`(${formatDelta(delta)}) ${message}`);
}

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
