import * as vscode from "vscode";
import * as path from "path";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { PinnedItemsProvider } from "../fresh-files/pinnedItemsProvider";
import { computeCochangeSuggestions, CochangeCommit } from "../cochange/cochangeEngine";
import { buildWorkUnits, computeCrossRepoPresence, TicketCommit } from "../cochange/workUnits";
import { collectCochangeHistory } from "../cochange/cochangeHistory";
import { ConfigService } from "../config/configService";
import { findRepoForAbsolutePath } from "../utils/pathUtils";
import { formatRelativeDateLong } from "../utils/formatUtils";
import { normalizePath } from "../utils";
import { asAbsolutePath, AbsolutePath } from "../pathTypes";
import { log, showInfo, showError } from "../extension/logger";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";

/** Resolve the command argument (tree item or uri from a context menu) to a file uri. */
function seedUriFromArg(arg: FreshFileItem | vscode.Uri | undefined): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) { return arg.scheme === "file" ? arg : undefined; }
  return arg?.resourceUri?.scheme === "file" ? arg.resourceUri : undefined;
}

/**
 * "Find files modified together": mine each repo's recent history for files and
 * directories that usually change together with what you're changing but are
 * untouched, and place the results as suggestion-pins (machine-created,
 * evidence in the note, accumulated across runs with path dedup).
 *
 * The seed — what "you're changing" means — resolves in order:
 *  1. an explicit file (right-click in a tree, the Explorer, or an editor),
 *  2. the current pending changes across all repos,
 *  3. the active editor's file.
 */
export async function handleSuggestCochanges(
  freshFileProvider: FreshFileProvider,
  pinnedItemsProvider: PinnedItemsProvider,
  arg?: FreshFileItem | vscode.Uri,
): Promise<void> {
  log("Suggest co-changes command triggered");
  if (!(await freshFileProvider.ensureDataLoaded())) {
    showInfo("No git repositories found in the workspace.");
    return;
  }

  // The full pending set always counts as "already handled", whatever the seed.
  const pendingByRepo = new Map<string, string[]>();
  for (const [absPath, metadata] of freshFileProvider.freshFiles) {
    if (!metadata.isPending || metadata.isDeleted) { continue; }
    const location = findRepoForAbsolutePath(freshFileProvider.workspaceFolders, absPath);
    if (!location) { continue; }
    const repoKey = normalizePath(location.repoFullPath);
    const list = pendingByRepo.get(repoKey) ?? [];
    list.push(normalizePath(location.filePathInRepo));
    pendingByRepo.set(repoKey, list);
  }

  // Seed resolution: explicit file → pending changes → active editor file.
  const explicitSeed = seedUriFromArg(arg)
    ?? (pendingByRepo.size === 0 ? seedUriFromArg(vscode.window.activeTextEditor?.document.uri) : undefined);
  const seedByRepo = new Map<string, string[]>();
  if (explicitSeed) {
    const location = findRepoForAbsolutePath(freshFileProvider.workspaceFolders, explicitSeed.fsPath);
    if (!location) {
      showInfo("This file isn't inside a git repository in the workspace.");
      return;
    }
    seedByRepo.set(normalizePath(location.repoFullPath), [normalizePath(location.filePathInRepo)]);
  } else {
    for (const [repo, files] of pendingByRepo) { seedByRepo.set(repo, files); }
  }
  if (seedByRepo.size === 0) {
    showInfo("Nothing to check — make a change or right-click a file to check its usual companions.");
    return;
  }

  const lookbackDays = ConfigService.getCochangeLookbackDays();
  const maxSuggestions = ConfigService.getCochangeMaxSuggestions();
  // Liveness: a coupling must have fired in the most recent third of the
  // window to count as current advice rather than history.
  const minLastTogetherAt = Date.now() - (lookbackDays / 3) * 24 * 60 * 60 * 1000;

  log(explicitSeed
    ? `Co-change seed: explicit file ${explicitSeed.fsPath}`
    : `Co-change seed: pending changes across ${seedByRepo.size} repo(s)`);

  const collected: { path: AbsolutePath; note: string; confidence: number; together: number }[] = [];
  const crossRepoNotes: string[] = [];
  const historyByRepo = new Map<string, CochangeCommit[]>();
  try {
    for (const [repoFullPath, seedFiles] of seedByRepo) {
      const repoName = path.basename(repoFullPath);
      const history = await collectCochangeHistory(repoFullPath, lookbackDays);
      historyByRepo.set(repoFullPath, history);
      const suggestions = computeCochangeSuggestions(history, seedFiles, {
        maxSuggestions,
        minLastTogetherAt,
        // A single-file seed still shouldn't suggest files that are already pending.
        satisfiedFiles: pendingByRepo.get(repoFullPath) ?? [],
        onStats: s => log(
          `Co-change [${repoName}]: seed ${seedFiles.length} file(s); ${s.historyCommits} commits in ${lookbackDays}d ` +
          `(${s.usableCommits} usable, ${s.ubiquitousItems} ubiquitous item(s) excluded); ` +
          `${s.pairsObserved} pair(s) observed → below support: ${s.belowSupport}, stale: ${s.droppedAsStale}, ` +
          `below confidence: ${s.belowConfidence}, already changed: ${s.alreadySatisfied} → ` +
          `${s.candidates} candidate(s), ${s.kept} kept after subsumption/cap`,
        ),
      });
      for (const s of suggestions) {
        log(`Co-change [${repoName}]: ${(s.confidence * 100).toFixed(0)}% (${s.together}/${s.total}) ${s.sourceKind} ${s.source} → ${s.targetKind} ${s.target}`);
        const sourceLabel = path.basename(s.source) + (s.sourceKind === "dir" ? "/" : "");
        const when = s.lastTogetherAt !== undefined ? `, last ${formatRelativeDateLong(new Date(s.lastTogetherAt))}` : "";
        collected.push({
          path: asAbsolutePath(normalizePath(path.join(repoFullPath, s.target))),
          note: `changed with ${sourceLabel} in ${s.together}/${s.total} commits${when}`,
          confidence: s.confidence,
          together: s.together,
        });
      }
    }

    // ── Cross-repo nudges via ticket joins ─────────────────────────────────
    // Two repos share no commits but do share ticket ids in commit messages.
    // Repo-presence stats over those work units answer what file mining can't:
    // "tickets touching this area usually also change the other repo."
    const repoList = freshFileProvider.getRepoList();
    if (repoList.length >= 2) {
      const nameByRepo = new Map<string, string>(repoList.map(r => [normalizePath(r.path), r.name]));
      for (const { path: repoPath } of repoList) {
        const key = normalizePath(repoPath);
        if (!historyByRepo.has(key)) {
          historyByRepo.set(key, await collectCochangeHistory(key, lookbackDays));
        }
      }

      let extraPattern: RegExp | undefined;
      const patternSetting = ConfigService.getCochangeTicketPattern();
      if (patternSetting) {
        try {
          extraPattern = new RegExp(patternSetting, "gi");
        } catch (e) {
          log(`Co-change: invalid cochange.ticketPattern ignored — ${e instanceof Error ? e.message : String(e)}`, "warn");
        }
      }

      const ticketCommits: TicketCommit[] = [];
      for (const [repo, history] of historyByRepo) {
        for (const c of history) {
          ticketCommits.push({ repo, files: c.files, message: c.message ?? "", at: c.at });
        }
      }
      const units = buildWorkUnits(ticketCommits, extraPattern);
      log(`Co-change cross-repo: ${units.length} ticket work unit(s) across ${historyByRepo.size} repo(s)`);

      for (const [repoFullPath, seedFiles] of seedByRepo) {
        const sourceName = nameByRepo.get(repoFullPath) ?? path.basename(repoFullPath);
        const nudges = computeCrossRepoPresence(units, { repo: repoFullPath, files: seedFiles }, {
          minLastTogetherAt,
          onStats: s => log(
            `Co-change cross-repo [${sourceName}]: ${s.unitsWithSourceRepo}/${s.units} unit(s) touch this repo; ` +
            `base rates ${JSON.stringify(Object.fromEntries(Object.entries(s.baseRates).map(([r, v]) => [nameByRepo.get(r) ?? r, +v.toFixed(2)])))}; ` +
            `${s.considered} pairing(s) considered, ${s.kept} kept`,
          ),
        });
        for (const n of nudges) {
          const targetName = nameByRepo.get(n.targetRepo) ?? path.basename(n.targetRepo);
          log(`Co-change cross-repo [${sourceName}]: ${(n.confidence * 100).toFixed(0)}% (${n.together}/${n.total}, base ${(n.baseRate * 100).toFixed(0)}%) ${n.sourceKind} ${n.source} → repo ${targetName}`);
          if (pendingByRepo.has(n.targetRepo)) { continue; } // already being changed — not forgotten
          const sourceLabel = path.basename(n.source) + (n.sourceKind === "dir" ? "/" : "");
          crossRepoNotes.push(
            `Tickets touching ${sourceLabel} usually also change ${targetName} (${n.together}/${n.total}) — ${targetName} has no pending changes`,
          );
        }
      }
    }
  } catch (e) {
    showError(`Co-change suggestions failed: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }

  // Multi-repo runs share one budget — strongest evidence wins overall.
  collected.sort((a, b) => b.confidence - a.confidence || b.together - a.together);
  const top = collected.slice(0, maxSuggestions);

  pinnedItemsProvider.pinnedItemsManager.addSuggestions(top);
  for (const note of crossRepoNotes) {
    // Unchecked on purpose: unlike the no-result note, this is a todo —
    // "go look at the other repo".
    pinnedItemsProvider.pinnedItemsManager.addSuggestionNote(note, false);
  }
  if (top.length === 0 && crossRepoNotes.length === 0) {
    // The click promised results in the pinned view — report "nothing found"
    // there too, as a pre-checked note, not in the notification area.
    pinnedItemsProvider.pinnedItemsManager.addSuggestionNote(explicitSeed
      ? `No strong co-change pattern for ${path.basename(explicitSeed.fsPath)} in the last ${lookbackDays} days`
      : `No co-change patterns for the current pending changes in the last ${lookbackDays} days`);
  }
  await vscode.commands.executeCommand("pinnedItems.focus");
}

/** Promote a suggestion to a normal user pin. */
export function handleKeepSuggestion(pinnedItemsProvider: PinnedItemsProvider, item: FreshFileItem | undefined): void {
  const fsPath = item?.resourceUri?.fsPath;
  if (!fsPath) { return; }
  pinnedItemsProvider.pinnedItemsManager.keepSuggestion(asAbsolutePath(normalizePath(fsPath)));
}
