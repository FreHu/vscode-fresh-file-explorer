/**
 * Per-file heatmap state: which mode is active on a file, and that file's
 * cached decorations.
 *
 * The two are kept behind one object because they must be dropped together.
 * The controller repaints visible editors straight from the decoration cache
 * without consulting the active mode, so a cache entry that outlives its mode
 * repaints a file the heatmap has already bailed out of. Eight bail-out paths
 * used to drop the mode and leave the cache behind; holding both here makes
 * {@link forget} the obvious call and the invariant structural rather than a
 * rule each new early-return has to remember.
 *
 * Invalidating the cache while KEEPING the mode is a separate, legitimate
 * operation ({@link invalidateCache}) — that is a recompute, not a bail-out.
 *
 * Generic over the mode and cache types so this file needs no `vscode` import
 * and runs in the fast, host-free unit tier.
 */
export class HeatmapFileState<TMode, TCache> {
  private readonly modes = new Map<string, TMode>();
  private readonly caches = new Map<string, TCache>();

  // ── active mode ──────────────────────────────────────────────────────────

  getMode(fsPath: string): TMode | undefined {
    return this.modes.get(fsPath);
  }

  hasMode(fsPath: string): boolean {
    return this.modes.has(fsPath);
  }

  setMode(fsPath: string, mode: TMode): void {
    this.modes.set(fsPath, mode);
  }

  /** Every file with an active mode — a snapshot, safe to {@link forget} while iterating. */
  trackedPaths(): string[] {
    return [...this.modes.keys()];
  }

  // ── cached decorations ───────────────────────────────────────────────────

  getCache(fsPath: string): TCache | undefined {
    return this.caches.get(fsPath);
  }

  setCache(fsPath: string, cache: TCache): void {
    this.caches.set(fsPath, cache);
  }

  /** Every cached entry, for bulk disposal. */
  cachedValues(): IterableIterator<TCache> {
    return this.caches.values();
  }

  /**
   * Drop the cached decorations but keep the mode active — the next apply
   * recomputes them. Use when the underlying data changed, NOT when the
   * heatmap is giving up on the file.
   */
  invalidateCache(fsPath: string): void {
    this.caches.delete(fsPath);
  }

  // ── paired teardown ──────────────────────────────────────────────────────

  /**
   * Forget the file entirely. Always drops both maps; this is the only correct
   * way to deactivate a file.
   */
  forget(fsPath: string): void {
    this.modes.delete(fsPath);
    this.caches.delete(fsPath);
  }

  /** True when a cache entry has no owning mode — the state this type exists to prevent. */
  hasOrphanedCache(): boolean {
    for (const fsPath of this.caches.keys()) {
      if (!this.modes.has(fsPath)) {
        return true;
      }
    }
    return false;
  }
}
