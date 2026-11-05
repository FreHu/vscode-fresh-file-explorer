// Runs the test suites headless in Docker (Linux + xvfb, like CI): no VS Code windows
// on your desktop. The repo is mounted read-only and copied in; failure screenshots
// and logs come back to .scratch/claude/docker/.
// Usage: node scripts/docker/testInDocker.mjs [npm script...]   (default: test test:ui)

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const results = join(repoRoot, ".scratch/claude/docker");
const scripts = process.argv.slice(2).length ? process.argv.slice(2) : ["test", "test:ui"];
const IMAGE = "fresh-file-explorer-tests";

const run = (args, label) => {
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) { console.error(`${label} failed (exit ${r.status})`); process.exit(r.status ?? 1); }
};

run(["build", "-q", "-t", IMAGE, "-f", join(here, "Dockerfile"), here], "docker build");
mkdirSync(results, { recursive: true });

const started = Date.now();
const r = spawnSync("docker", [
  "run", "--rm", "--init",
  // Electron's renderer needs more shared memory than Docker's 64 MB default.
  "--shm-size=1g",
  "-v", `${repoRoot}:/src:ro`,
  "-v", `${results}:/results`,
  "-v", "fresh-file-explorer-cache:/cache",
  "-v", "fresh-file-explorer-npm:/root/.npm",
  ...(process.env.UI_VSCODE_VERSION ? ["-e", `UI_VSCODE_VERSION=${process.env.UI_VSCODE_VERSION}`] : []),
  IMAGE, "node", "/src/scripts/docker/inContainer.mjs", ...scripts,
], { stdio: "inherit" });
console.log(`[docker] done in ${((Date.now() - started) / 1000).toFixed(0)} s, exit ${r.status}; failures (if any) in ${results}`);
process.exit(r.status ?? 1);
