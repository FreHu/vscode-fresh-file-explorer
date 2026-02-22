import * as vscode from "vscode";
import * as nodePath from "path";
import { execGitWithArgs } from "../git/gitOperations";
import { parseGitLogL } from "../git/gitLogLParser";
import { GitLogLPanel } from "../gitLogLPanel";
import { log } from "../utils/logger";
import { FreshFileItem } from "../treeItems";
import { formatGitCommand } from "../utils/formatUtils";
export { formatGitCommand };

/**
 * Run `git log -L` on the current editor selection.
 *
 * - If the selection spans multiple lines  → line range mode: `git log -L <start>,<end>:<file>`
 * - If the selection is within a single line → function name mode: `git log -L :<word>:<file>`
 *   (uses the word under the cursor / selected text as the funcname pattern)
 */
export async function handleGitLogL(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const fileUri = editor.document.uri;
  if (fileUri.scheme !== "file") {
    vscode.window.showWarningMessage("git log -L only works on files on disk.");
    return;
  }

  const filePath = fileUri.fsPath;

  // Find the git repo root for this file
  const repoRoot = await findGitRoot(filePath);
  if (!repoRoot) {
    vscode.window.showWarningMessage(`Could not find a git repository for: ${filePath}`);
    return;
  }

  // Build the -L argument from the selection
  const selection = editor.selection;
  const isMultiLine = selection.start.line !== selection.end.line;

  // Path relative to the repo root (git expects forward slashes)
  const relativePath = toForwardSlashes(nodePath.relative(repoRoot, filePath));

  let lArg: string;
  let label: string;

  if (isMultiLine) {
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    lArg = `${startLine},${endLine}:${relativePath}`;
    label = `lines ${startLine}–${endLine} · ${nodePath.basename(filePath)}`;
    log(`git log -L (line range): ${lArg}`, "info");
  } else {
    const funcName = getSelectedWordOrText(editor);
    if (!funcName) {
      vscode.window.showWarningMessage(
        "Could not determine a function name. Place the cursor on a name or select text."
      );
      return;
    }
    lArg = `:${escapeRegex(funcName)}:${relativePath}`;
    label = `${funcName} · ${nodePath.basename(filePath)}`;
    log(`git log -L (funcname): ${lArg}`, "info");
  }

  try {
    const args = ["log", "-L", lArg];
    const rawOutput = await execGitWithArgs(args, repoRoot, { timeout: 30000 });
    const commits = parseGitLogL(rawOutput);
    log(`git log -L: parsed ${commits.length} commits`, "info");

    const extensionUri = vscode.extensions.getExtension("frehu.fresh-file-explorer")?.extensionUri
      ?? vscode.Uri.file(nodePath.resolve(__dirname, "../..")); 

    GitLogLPanel.createOrShow(extensionUri, repoRoot, filePath, lArg, label, commits, formatGitCommand(args), "logL");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`git log -L error: ${message}`, "error");
    if (message.includes("There is no path")) {
      vscode.window.showWarningMessage("This file has no git history yet — it may be untracked or not yet committed.");
    } else {
      vscode.window.showErrorMessage(`git log -L failed: ${message}`);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Whole-file history: `git log --follow -p -- <file>`
 * Works from the tree view (FreshFileItem) or the active editor.
 */
export async function handlegitLogFile(item?: FreshFileItem): Promise<void> {
  let filePath: string | undefined;

  if (item?.resourceUri?.scheme === "file") {
    filePath = item.resourceUri.fsPath;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("No file to trace history for.");
      return;
    }
    filePath = editor.document.uri.fsPath;
  }

  const repoRoot = await findGitRoot(filePath);
  if (!repoRoot) {
    vscode.window.showWarningMessage(`Could not find a git repository for: ${filePath}`);
    return;
  }

  const relativePath = toForwardSlashes(nodePath.relative(repoRoot, filePath));
  const label = nodePath.basename(filePath);
  const lArg = `file:${relativePath}`; // used as panel dedup key only

  log(`git log --follow -p: ${relativePath}`, "info");

  try {
    const args = ["log", "--follow", "-p", "--", relativePath];
    const rawOutput = await execGitWithArgs(
      args,
      repoRoot,
      { timeout: 30000 },
    );
    const commits = parseGitLogL(rawOutput);
    log(`git log file: parsed ${commits.length} commits`, "info");

    if (commits.length === 0) {
      vscode.window.showWarningMessage("This file has no git history yet — it may be untracked or not yet committed.");
      return;
    }

    const extensionUri =
      vscode.extensions.getExtension("frehu.fresh-file-explorer")?.extensionUri ??
      vscode.Uri.file(nodePath.resolve(__dirname, "../..")); 

    GitLogLPanel.createOrShow(extensionUri, repoRoot, filePath, lArg, label, commits, formatGitCommand(args), "fileHistory");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`git log file error: ${message}`, "error");
    vscode.window.showErrorMessage(`git log failed: ${message}`);
  }
}

async function findGitRoot(filePath: string): Promise<string | null> {
  const dir = nodePath.dirname(filePath);
  try {
    const result = await execGitWithArgs(
      ["rev-parse", "--show-toplevel"],
      dir,
      { timeout: 5000 }
    );
    return result.trim();
  } catch {
    return null;
  }
}

function getSelectedWordOrText(editor: vscode.TextEditor): string {
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection).trim();
  if (selectedText) {
    return selectedText;
  }
  // Fall back to word under cursor
  const wordRange = editor.document.getWordRangeAtPosition(selection.active);
  if (wordRange) {
    return editor.document.getText(wordRange).trim();
  }
  return "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}


