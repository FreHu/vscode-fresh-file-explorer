import * as vscode from "vscode";

import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import { GENERATED_ATTRIBUTES, parseGeneratedAttributes } from "../git/generatedFiles";
import { execGitWithArgs } from "../git/gitOperations";

/**
 * Which files a repo marks generated (`linguist-generated` / `gitlab-generated`
 * in .gitattributes), by normalized absolute path. Filled lazily per repo with
 * one `git check-attr --stdin` for the files not classified yet.
 */
export class GeneratedFilesStore implements vscode.Disposable {
  private readonly known = new Map<string, boolean>();
  // Generated before the last clear(): still answered as generated until rechecked,
  // so labels don't blink off and on around every refresh.
  private stale = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when a check changed a file's answer. */
  readonly onDidChange = this._onDidChange.event;

  /**
   * @param files the Fresh Files map, stamped with `generated` in place
   * @param repoRoots normalized roots of the discovered repos
   * @param redraw re-render Fresh Files after answers changed
   */
  constructor(
    private readonly files: () => Map<string, { generated?: boolean }>,
    private readonly repoRoots: () => string[],
    redraw: () => void,
  ) {
    this._onDidChange.event(() => {
      this.stamp(this.files());
      redraw();
    });
  }

  /** The Fresh Files map was replaced: stamp what's known, check the rest. */
  update(): void {
    this.stamp(this.files());
    this.scheduleClassify();
  }

  isGenerated(absPath: string): boolean {
    return this.known.get(absPath) ?? this.stale.has(absPath);
  }

  /** Recheck every file on next classify: a .gitattributes may have changed. */
  clear(): void {
    for (const [p, generated] of this.known) {
      if (generated) { this.stale.add(p); }
    }
    this.known.clear();
  }

  /** Copy the current answers onto metadata entries (updated in place). */
  private stamp(files: Map<string, { generated?: boolean }>): void {
    for (const [p, metadata] of files) {
      const generated = this.isGenerated(p);
      if (generated || metadata.generated) { metadata.generated = generated || undefined; }
    }
  }

  private pendingTimer: NodeJS.Timeout | undefined;
  /** Debounced: classify the Fresh Files entries against the most specific repo root owning each. */
  private scheduleClassify(): void {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      const roots = [...this.repoRoots()].sort((a, b) => b.length - a.length);
      const byRepo = new Map<string, string[]>();
      for (const p of this.files().keys()) {
        if (this.known.has(p)) { continue; }
        const root = roots.find(r => p.startsWith(r + "/"));
        if (root) { byRepo.set(root, [...(byRepo.get(root) ?? []), p]); }
      }
      for (const [root, paths] of byRepo) { void this.classify(root, paths); }
    }, 200);
  }

  /** Classify `absPaths` under `repoRoot` (all normalized) that aren't classified yet. */
  async classify(repoRoot: string, absPaths: Iterable<string>): Promise<void> {
    const todo = [...absPaths].filter(p => p.startsWith(repoRoot + "/") && !this.known.has(p) && !this.inFlight.has(p));
    if (todo.length === 0) { return; }
    todo.forEach(p => this.inFlight.add(p));
    try {
      const relPaths = todo.map(p => p.slice(repoRoot.length + 1));
      const out = await execGitWithArgs(
        ["check-attr", "-z", "--stdin", ...GENERATED_ATTRIBUTES],
        repoRoot,
        { stdin: relPaths.join("\0") + "\0", timeout: ConfigService.getGitTimeoutMs() },
      );
      const generated = parseGeneratedAttributes(out);
      let changed = 0;
      relPaths.forEach((rel, i) => {
        const isGenerated = generated.has(rel);
        if (isGenerated !== this.isGenerated(todo[i])) { changed++; }
        this.known.set(todo[i], isGenerated);
        this.stale.delete(todo[i]);
      });
      if (changed > 0) {
        log(`${repoRoot}: ${changed} of ${todo.length} checked files changed generated status (.gitattributes)`);
        this._onDidChange.fire();
      }
    } catch (error) {
      log(`check-attr failed in ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`, "warn");
    } finally {
      todo.forEach(p => this.inFlight.delete(p));
    }
  }

  dispose(): void {
    clearTimeout(this.pendingTimer);
    this._onDidChange.dispose();
  }
}
