import * as vscode from "vscode";
import * as path from "path";

import { normalizePath } from "../../utils";

/** Quiet time before a refresh. */
const DEBOUNCE_MS = 300;
/** Upper bound while edits keep coming, so a typing burst still shows progress. */
const MAX_WAIT_MS = 1000;

/**
 * Fires `onDidChange` with the (normalized) path of a watched outline file
 * that changed: typing in an open editor (debounced, unsaved edits included)
 * or a write from outside the editor (git checkout, another tool). One file
 * watcher per path, because pinned files can live outside the workspace.
 */
export class PinnedOutlineSync implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  readonly onDidChange = this._onDidChange.event;

  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; firstAt: number }>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(normalizePath(e.document.uri.fsPath))),
      // Closing a dirty editor without saving reverts to the disk content.
      vscode.workspace.onDidCloseTextDocument(doc => this.schedule(normalizePath(doc.uri.fsPath))),
    );
  }

  /** Watch exactly these files (absolute paths); drops watchers for the rest. */
  setWatched(fsPaths: string[]): void {
    const wanted = new Set(fsPaths.map(p => normalizePath(p)));
    for (const [key, watcher] of this.watchers) {
      if (!wanted.has(key)) {
        watcher.dispose();
        this.watchers.delete(key);
      }
    }
    for (const fsPath of fsPaths) {
      const key = normalizePath(fsPath);
      if (this.watchers.has(key)) { continue; }
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(fsPath)), path.basename(fsPath));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.schedule(key));
      watcher.onDidCreate(() => this.schedule(key));
      watcher.onDidDelete(() => this.schedule(key));
      this.watchers.set(key, watcher);
    }
  }

  /** Debounce per file, but never hold a refresh back longer than MAX_WAIT_MS. */
  private schedule(key: string): void {
    if (!this.watchers.has(key)) { return; }
    const now = Date.now();
    const existing = this.pending.get(key);
    if (existing) { clearTimeout(existing.timer); }
    const firstAt = existing?.firstAt ?? now;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - now));
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this._onDidChange.fire(key);
    }, delay);
    this.pending.set(key, { timer, firstAt });
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) { clearTimeout(timer); }
    this.pending.clear();
    for (const watcher of this.watchers.values()) { watcher.dispose(); }
    this.watchers.clear();
    for (const s of this.subscriptions) { s.dispose(); }
    this._onDidChange.dispose();
  }
}
