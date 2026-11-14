// Loaded by `test:unit` before any test. Git sets GIT_DIR for hooks run in a linked
// worktree (and a rebase `exec` or a parent tool can set others); every git call the
// tests make in a temp repo would inherit it and act on the surrounding repository.
import { execFileSync } from "child_process";

for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n")) {
  if (name) { delete process.env[name]; }
}
