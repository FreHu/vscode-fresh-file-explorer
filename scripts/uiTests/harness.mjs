// UI tests: a real VS Code with the extension, on the demo fixture repo. They check
// what VS Code renders, which the extension-host tests can't. Run: npm run test:ui

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureRepo } from "../demo/fixtureRepo.mjs";
import { failureReport } from "../demo/failureReport.mjs";
import { launchVSCode } from "../demo/launchVSCode.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Runs `body` against a fresh VS Code on a fresh fixture repo. On failure, prints the
 * window screenshot path and the extension log's tail before rethrowing.
 * @param {string} name used for this test's folder under .scratch/claude/ui-tests
 * @param {{ settings?: object, window?: object, workspace?: (ctx: { stateDir: string, buildFixtureRepo: Function }) => string }} opts
 * @param {(page: import("playwright-core").Page, ctx: { stateDir: string, extensionLog: () => string }) => Promise<void>} body
 */
export async function withVSCode(name, opts, body) {
  const stateDir = join(repoRoot, ".scratch/claude/ui-tests", name);
  const workspace = opts.workspace
    ? opts.workspace({ stateDir, buildFixtureRepo })
    : buildFixtureRepo(join(stateDir, "orbit-shop"));
  const { app, page } = await launchVSCode({ repoRoot, workspace, stateDir, settings: opts.settings, window: opts.window });
  const extensionLog = () => readExtensionLog(join(stateDir, "user-data", "logs"));
  try {
    await body(page, { stateDir, extensionLog });
  } catch (err) {
    console.error(await failureReport({ page, stateDir, name }));
    throw err;
  } finally {
    await app.close();
  }
}

/** Runs git in `cwd` (fixture changes while VS Code is running). */
export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * The visible rows of a tree view section as { level, label, description, icon, expanded }.
 * `icon` is the row's codicon id (e.g. "worktree", "repo"). Only rendered rows: keep
 * the tree short enough to fit.
 */
export async function treeRows(page, paneTitle) {
  const pane = page.locator(".pane", { has: page.locator(".pane-header .title", { hasText: new RegExp(`^${paneTitle}$`, "i") }) }).first();
  // Sorted by data-index: the list reuses row elements, so DOM order isn't display order.
  return pane.locator(".monaco-list-row").evaluateAll(rows => rows
    .map(r => {
      const iconEl = r.querySelector(".custom-view-tree-node-item-icon");
      const icon = [...(iconEl?.classList ?? [])].find(c => c.startsWith("codicon-"))?.slice("codicon-".length);
      return {
        index: Number(r.getAttribute("data-index")),
        level: Number(r.getAttribute("aria-level")),
        label: r.querySelector(".label-name")?.textContent ?? "",
        description: r.querySelector(".label-description")?.textContent ?? "",
        icon,
        expanded: r.getAttribute("aria-expanded"),
      };
    })
    .sort((a, b) => a.index - b.index));
}

/** Top-level rows with the labels of the rows nested under each: { "orbit-shop": ["search.ts", …] }. */
export function childrenByRoot(rows) {
  const out = {};
  let current;
  for (const row of rows) {
    if (row.level === 1) { current = row.label; out[current] = []; } else if (current) { out[current].push(row.label); }
  }
  return out;
}

function readExtensionLog(dir) {
  if (!existsSync(dir)) { return ""; }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = readExtensionLog(p);
      if (found) { return found; }
    } else if (entry.name === "Fresh File Explorer.log") {
      return readFileSync(p, "utf8");
    }
  }
  return "";
}
