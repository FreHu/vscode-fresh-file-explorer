// UI tests: a real VS Code with the extension, on the demo fixture repo. They check
// what VS Code renders, which the extension-host tests can't. Run: npm run test:ui

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
 * @param {{ settings?: object, workspace?: (ctx: { stateDir: string, buildFixtureRepo: Function }) => string }} opts
 * @param {(page: import("playwright-core").Page) => Promise<void>} body
 */
export async function withVSCode(name, opts, body) {
  const stateDir = join(repoRoot, ".scratch/claude/ui-tests", name);
  const workspace = opts.workspace
    ? opts.workspace({ stateDir, buildFixtureRepo })
    : buildFixtureRepo(join(stateDir, "orbit-shop"));
  const { app, page } = await launchVSCode({ repoRoot, workspace, stateDir, settings: opts.settings });
  try {
    await body(page);
  } catch (err) {
    console.error(await failureReport({ page, stateDir, name }));
    throw err;
  } finally {
    await app.close();
  }
}
