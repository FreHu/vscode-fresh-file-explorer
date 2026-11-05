// Launches VS Code with this extension loaded from out/, in an isolated profile,
// and returns a Playwright handle to its window.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron } from "playwright-core";

/**
 * Pinned so screenshots don't shift with VS Code releases. `UI_VSCODE_VERSION` runs the UI
 * tests against another build, e.g. the VS Code base of current Cursor.
 */
export const VSCODE_VERSION = process.env.UI_VSCODE_VERSION || "1.145.0";

const DEFAULT_WINDOW = { width: 1280, height: 800 };

/** Keeps the chrome quiet and identical between runs. */
const USER_SETTINGS = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.enableExperiments": false,
  "window.zoomLevel": 0,
  "window.restoreWindows": "none",
  "window.commandCenter": true,
  "editor.fontSize": 14,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "git.openRepositoryInParentFolders": "never",
  "chat.disableAIFeatures": true,
};

/**
 * Run from a terminal inside VS Code, the environment carries ELECTRON_RUN_AS_NODE
 * (Code.exe would start as plain Node, no window) and the parent's VSCODE_* IPC
 * handles (the new window would attach to the running instance).
 */
function cleanEnv(stateDir) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|VSCODE_)/i.test(key))),
    // The fixtures live inside this extension's own checkout. Without a ceiling, git in a
    // non-repo fixture folder walks up into it, and discovery treats the folder as that repo.
    GIT_CEILING_DIRECTORIES: stateDir,
  };
}

/**
 * @param {{ repoRoot: string, workspace: string, stateDir: string, settings?: Record<string, unknown>, window?: { width: number, height: number } }} opts
 */
export async function launchVSCode({ repoRoot, workspace, stateDir, settings = {}, window = DEFAULT_WINDOW }) {
  const executablePath = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: join(repoRoot, ".vscode-test") });

  // Fresh profile every run: no restored editors, layout or view state.
  const userDataDir = join(stateDir, "user-data");
  const extensionsDir = join(stateDir, "extensions");
  rmSync(userDataDir, { recursive: true, force: true });
  mkdirSync(join(userDataDir, "User"), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(join(userDataDir, "User", "settings.json"), JSON.stringify({ ...USER_SETTINGS, ...settings }, null, 2));

  const app = await electron.launch({
    executablePath,
    env: cleanEnv(stateDir),
    args: [
      workspace,
      `--extensionDevelopmentPath=${repoRoot}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-gpu-sandbox",
      "--force-device-scale-factor=1",
      "--new-window",
    ],
  });

  const page = await app.firstWindow();
  await app.browserWindow(page).then(w => w.evaluate((win, size) => {
    win.unmaximize();
    win.setContentSize(size.width, size.height);
    win.center();
  }, window));
  await page.locator(".monaco-workbench").waitFor();
  return { app, page };
}
