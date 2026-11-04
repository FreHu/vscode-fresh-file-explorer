// Runs inside the container: copy the repo from the read-only mount, install, test,
// copy results back. Exit code is the tests' exit code.
// Usage (from testInDocker.mjs): node /src/scripts/docker/inContainer.mjs <npm script>...

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const scripts = process.argv.slice(2);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

// Everything but what's platform-specific or regenerated: node_modules has Windows
// binaries (esbuild), and the build output and test state are rebuilt here.
console.log("[docker] copying the repo");
sh("rsync", ["-a", "--delete",
  "--exclude=node_modules", "--exclude=.vscode-test", "--exclude=out", "--exclude=dist",
  "--exclude=.scratch", "--exclude=*.vsix", "--exclude=.codegraph",
  "/src/", "/work/"]);
// The VS Code download lives in a volume (/cache), reused across runs.
mkdirSync("/cache/vscode-test", { recursive: true });
rmSync("/work/.vscode-test", { recursive: true, force: true });
sh("ln", ["-s", "/cache/vscode-test", "/work/.vscode-test"]);

console.log("[docker] npm ci");
sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: "/work" });

let exitCode = 0;
for (const script of scripts) {
  console.log(`[docker] xvfb-run npm run ${script}`);
  const started = Date.now();
  const r = spawnSync("xvfb-run", ["-a", "npm", "run", script], { cwd: "/work", stdio: "inherit" });
  console.log(`[docker] ${script}: exit ${r.status} after ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (r.status !== 0) { exitCode = r.status ?? 1; }
}

// Failure screenshots and logs (UI tests) back to the host.
if (existsSync("/work/.scratch/claude/ui-tests")) {
  rmSync("/results/ui-tests", { recursive: true, force: true });
  cpSync("/work/.scratch/claude/ui-tests", "/results/ui-tests", { recursive: true,
    filter: src => !/[\\/](user-data|extensions|orbit-shop|agents|ws|remote)[\\/]/.test(src + "/") || /failure\.(png|log)$/.test(src) });
}
process.exit(exitCode);
