// What to print when a scene or UI test fails: the window, the scene's own
// diagnostics, and the extension's log. Shared by run.mjs and the UI tests.

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Saves the window as `<stateDir>/<name>.failure.png` and the extension log as
 * `<name>.failure.log`; returns the text to print.
 * @param {{ page: import("playwright-core").Page, stateDir: string, name: string, diagnose?: (page) => Promise<string> }} opts
 */
export async function failureReport({ page, stateDir, name, diagnose }) {
  const parts = [];
  const shot = join(stateDir, `${name}.failure.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  parts.push(`window at failure: ${shot}`);
  if (diagnose) {
    const text = await diagnose(page).catch(e => `diagnose failed: ${e}`);
    parts.push(`scene diagnostics:\n${indent(text)}`);
  }
  const extLog = findExtensionLog(join(stateDir, "user-data", "logs"));
  if (extLog) {
    const target = join(stateDir, `${name}.failure.log`);
    copyFileSync(extLog, target);
    const tail = readFileSync(extLog, "utf8").trimEnd().split("\n").slice(-20).join("\n");
    parts.push(`extension log (last 20 lines; full copy: ${target}):\n${indent(tail)}`);
  }
  return parts.map(p => `  ${p}`).join("\n");
}

function indent(text) {
  return String(text).split("\n").map(l => `    ${l}`).join("\n");
}

/** The extension's output-channel log in this run's profile (the profile is fresh per launch). */
function findExtensionLog(dir) {
  if (!existsSync(dir)) { return undefined; }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExtensionLog(p);
      if (found) { return found; }
    } else if (entry.name === "Fresh File Explorer.log") {
      return p;
    }
  }
  return undefined;
}
