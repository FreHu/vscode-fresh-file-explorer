import { RefreshEpochGuard, RefreshCancelledError, RefreshToken } from "./refreshEpochGuard";
import { RepoDiscovery } from "./repoDiscovery";
import { ConfigService } from "../config/configService";
import { ContextManager } from "../extension/contextManager";
import { log } from "../extension/logger";
import { NormalizedRepoPath } from "../pathTypes";

/**
 * The data-side operations a load needs. All state the orchestrator sequences
 * (epochs, dormancy, targets, per-repo loading sets, dataLoaded) lives in the
 * orchestrator itself; the delegate only reads/evicts/loads the file store.
 */
export interface LoadDelegate {
  hasWorkspaceFolders(): boolean;
  /** Evict file data for a refresh. `hard` also clears discovery-derived caches (repo items). */
  resetData(opts: { hard: boolean; targetRepoPaths?: NormalizedRepoPath[]; preserveHistoricalCache?: boolean }): void;
  /** Phases 2+3: load pending + historical files for the current target scope. Returns the tree-level error, if any. */
  loadFiles(assertNotCancelled: () => void): Promise<string | undefined>;
  /** Re-run git status only and merge onto the cached historical baseline. */
  updatePending(targetRepoPaths?: NormalizedRepoPath[]): Promise<void>;
  /** A full load finished: record the error for the tree and refresh dependents (heatmap). */
  onLoadCompleted(error: string | undefined): void;
  /** Public discovery entry that also initializes workspace folders when needed. */
  ensureDiscovered(): Promise<void>;
  fireTree(): void;
}

/**
 * Owns the fresh-files load lifecycle: the refresh hierarchy (soft / hard /
 * pending), the cancellation epoch, in-flight load dedup + re-kick, manual-scan
 * dormancy, refresh target scoping, and the per-repo loading sets that drive
 * progress display. Data itself stays with the delegate.
 */
export class LoadOrchestrator {
  private readonly refreshGuard = new RefreshEpochGuard();
  private refreshPromise: Promise<void> | undefined;
  /**
   * Manual-scan mode: true once the scan has been armed for this session. Sticky
   * on purpose — the point of manual scan is to skip the cost for users who never
   * open the view, not to keep the tree stale for someone who just asked for it.
   */
  private scanArmed = false;
  // Target repo paths for the current refresh (undefined = all repos).
  private _targetRepoPaths: NormalizedRepoPath[] | undefined = undefined;
  private _dataLoaded = false;
  /** Repos whose initial (pending) file loading is still in progress. Mutated by the load path. */
  readonly reposLoading = new Set<NormalizedRepoPath>();
  /** Repos with pending files loaded but historical still running. Mutated by the load path. */
  readonly reposLoadingHistorical = new Set<NormalizedRepoPath>();
  /** Incremented on every refreshPending() run, so listeners can skip scheduling duplicates. */
  pendingRefreshVersion = 0;

  constructor(
    private readonly discovery: RepoDiscovery,
    private readonly deps: LoadDelegate,
  ) {}

  get dataLoaded(): boolean { return this._dataLoaded; }
  private setDataLoaded(value: boolean): void {
    this._dataLoaded = value;
    ContextManager.setLoading(!value);
  }
  /** Scope of the current refresh — the load path skips repos outside it. */
  get targetRepoPaths(): NormalizedRepoPath[] | undefined { return this._targetRepoPaths; }
  get hasInFlightLoad(): boolean { return this.refreshPromise !== undefined; }

  /** Cancel any in-flight load (e.g. the new state is served from cache instead). */
  cancelInFlight(): void {
    this.refreshGuard.bump();
  }

  /** The current state is complete without a load (served from cache). */
  markLoadedFromCache(): void {
    this.setDataLoaded(true);
  }

  /**
   * Snapshot of where loading currently sits — drives the fresh-files status bar.
   *
   * - `dormant`     — manual scan on and not yet armed; no history has been read.
   * - `discovering` — repo discovery still in flight.
   * - `loading`     — repos discovered, files (pending and/or historical) loading.
   * - `idle`        — caught up. `totalRepos` may be 0 when the workspace has none.
   */
  getLoadingProgress(): { state: "dormant" | "discovering" | "loading" | "idle"; totalRepos: number; loadedRepos: number } {
    const totalRepos = this.discovery.resolvedRepos.length;
    if (this.isScanDormant) {
      // Repo count is only meaningful once discovery has run.
      return { state: "dormant", totalRepos: this.discovery.reposDiscovered ? totalRepos : 0, loadedRepos: 0 };
    }
    if (!this.discovery.reposDiscovered) {
      return { state: "discovering", totalRepos: 0, loadedRepos: 0 };
    }
    const stillLoading = this.reposLoading.size + this.reposLoadingHistorical.size;
    if (stillLoading > 0) {
      // A single repo can sit in both sets simultaneously — clamp so the count
      // doesn't briefly exceed totalRepos during the pending→historical handoff.
      const loadedRepos = Math.max(0, totalRepos - Math.min(stillLoading, totalRepos));
      return { state: "loading", totalRepos, loadedRepos };
    }
    return { state: "idle", totalRepos, loadedRepos: totalRepos };
  }

  /**
   * True while manual scan is on and no explicit Refresh has armed the scan yet.
   * Nothing reads git history in this state.
   */
  get isScanDormant(): boolean {
    return !this.scanArmed && ConfigService.getFreshFileLoadingMode() === "manual";
  }

  /**
   * Arm the scan for the rest of the session. Called by the Refresh command and by
   * `ensureLoaded()` — the blame heatmap needs real data, and enabling it is an
   * explicit opt-in to the scan.
   */
  armScan(): void {
    if (this.scanArmed) { return; }
    log("Manual scan armed — history loading enabled for this session");
    this.scanArmed = true;
  }

  /** The loading-mode setting changed — the next dormancy check starts fresh. */
  resetArm(): void {
    this.scanArmed = false;
  }

  /**
   * Soft refresh: reload files from the already-known set of repositories.
   * Falls back to hardRefresh() if repos have never been discovered yet.
   * @param preserveHistoricalCache When true, the historical cache is kept intact (e.g. time-window display switch).
   */
  refresh(options?: { preserveHistoricalCache?: boolean; targetRepoPaths?: NormalizedRepoPath[] }): void {
    if (!this.discovery.reposDiscovered) {
      this.hardRefresh();
      return;
    }
    const targetRepoPaths = options?.targetRepoPaths;
    const scopeDesc = targetRepoPaths ? ` [${targetRepoPaths.length} repo(s)]` : "";
    log(`Refresh of files${scopeDesc}`);
    this.setDataLoaded(false);
    this._targetRepoPaths = targetRepoPaths;
    this.refreshGuard.bump();
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    this.deps.resetData({ hard: false, targetRepoPaths, preserveHistoricalCache: options?.preserveHistoricalCache });
    if (targetRepoPaths) {
      // Show spinner only for target repos.
      for (const repoPath of targetRepoPaths) {
        this.reposLoading.add(repoPath);
      }
    } else {
      // Pre-populate reposLoading so spinner appears on each repo node immediately.
      for (const { normalizedRepoPath } of this.discovery.resolvedRepos) {
        this.reposLoading.add(normalizedRepoPath);
      }
    }
    this.deps.fireTree();
    this.kickOffLoad();
  }

  /** Hard refresh: re-discover repositories then reload all files. */
  hardRefresh(): void {
    log("Hard refresh (repo discovery + history)");
    this.setDataLoaded(false);
    this._targetRepoPaths = undefined; // a cancelled targeted refresh must not scope this full reload
    this.discovery.reset();
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    this.refreshGuard.bump();
    this.deps.resetData({ hard: true });
    this.deps.fireTree();
    this.kickOffLoad();
  }

  /**
   * Start `runLoad()` if no load is already in flight. Includes a re-kick when
   * the in-flight load was cancelled (refreshEpoch bumped mid-load) — without
   * this, the new state set by the cancelling refresh() would never actually load.
   */
  kickOffLoad(): void {
    if (this.isScanDormant) {
      // Discovery still runs — branch compare and the blame heatmap resolve repos
      // through it, and neither should go dark just because history is dormant.
      void this.deps.ensureDiscovered();
      // A targeted refresh that parked here never runs, so its scope must not
      // leak into the first armed load (which would then skip every other repo).
      this._targetRepoPaths = undefined;
      this.enterDormant();
      return;
    }
    if (this.refreshPromise) { return; }
    this.refreshPromise = this.runLoad().finally(() => {
      this.refreshPromise = undefined;
      // Re-check dormancy: entering manual scan mid-load cancels the load, and
      // restarting it here would defeat the setting the moment it's turned on.
      if (!this._dataLoaded && !this.isScanDormant) {
        log("Stale load detected after promise settled — starting new load");
        this.refreshPromise = this.runLoad().finally(() => {
          this.refreshPromise = undefined;
        });
      }
    });
  }

  /**
   * Refresh only the pending layer, leaving historical data cached.
   * Used when working-tree or index changes are detected but no full refresh is required.
   * Falls back to a full refresh if data hasn't been loaded yet.
   */
  async refreshPending(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    if (this.isScanDormant) { return; }
    if (!this._dataLoaded) {
      this.refresh(); // soft if repos known, hard if first load
      return;
    }
    this.pendingRefreshVersion++;
    const scopeDesc = targetRepoPaths ? ` for ${targetRepoPaths.length} repo(s)` : "";
    log(`Refreshing pending changes only${scopeDesc}`);
    try {
      await this.deps.updatePending(targetRepoPaths);
      this.deps.fireTree();
    } catch (e) {
      // Callers fire-and-forget this (`void`), so a rejection here would be an
      // unhandled rejection with no handler. Log and swallow: a failed pending
      // refresh just leaves the tree showing its last-known state.
      log(`refreshPending failed${scopeDesc}: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /**
   * Ensure a load has run, starting one if necessary. Arms the scan: every
   * caller here is acting on an explicit user request, where silently returning
   * empty data would look like a bug.
   */
  async ensureLoaded(): Promise<void> {
    if (this._dataLoaded) { return; }
    this.armScan();
    if (!this.refreshPromise) {
      log("ensureLoaded: Loading files from Git repositories...");
      this.refreshPromise = this.runLoad().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }

  /**
   * Settle into the dormant state. `dataLoaded` stays false (no data was read), so
   * the loading context key has to be cleared explicitly or the `when`-clauses that
   * hide file actions during a load would stay stuck.
   *
   * Deliberately fires no tree event: the root render calls into here on every pass
   * while dormant (`dataLoaded` is always false), so firing would re-enter
   * getChildren and spin the view's progress bar forever. The one re-render that
   * matters — discovery finishing — is fired by `ensureReposDiscovered()`.
   */
  private enterDormant(): void {
    ContextManager.setLoading(false);
  }

  /** One full load: discovery (if needed) → per-repo pending + historical. */
  private async runLoad(): Promise<void> {
    if (!this.deps.hasWorkspaceFolders()) {
      return;
    }

    const token = this.refreshGuard.capture();
    const assertNotCancelled = () => token.assertLive();

    try {
      // --- Phase 1: Discover repositories (skipped on soft refresh) ---
      await this.discovery.discoverRepositories(assertNotCancelled);

      // Mark repos as loading and fire so the repo list appears immediately with
      // per-repo spinners before any git log runs. A targeted refresh already
      // seeded only its own repos — don't widen it to the whole workspace.
      if (!this._targetRepoPaths) {
        for (const { normalizedRepoPath } of this.discovery.resolvedRepos) {
          this.reposLoading.add(normalizedRepoPath);
        }
      }
      this.deps.fireTree();

      if (this.discovery.resolvedRepos.length === 0) {
        this.setDataLoaded(true);
        this.deps.fireTree();
        return;
      }

      // --- Phase 2: Load files per repository (pending first, then historical) ---
      const errorToShow = await this.deps.loadFiles(assertNotCancelled);

      this.deps.onLoadCompleted(errorToShow);
      this.setDataLoaded(true);
      this._targetRepoPaths = undefined;
    } catch (e) {
      if (e instanceof RefreshCancelledError) {
        log("runLoad: cancelled (newer refresh started)");
        return;
      }
      throw e;
    }
  }

  /** Capture a cancellation token tied to the current epoch (discovery-only callers, incremental load callbacks). */
  captureEpoch(): RefreshToken {
    return this.refreshGuard.capture();
  }
}
