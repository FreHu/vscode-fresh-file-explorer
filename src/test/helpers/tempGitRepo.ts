import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export interface TempGitRepo {
  dir: string;
  /** Run git in the repo and return its stdout. */
  git(...args: string[]): string;
  /** Delete the repo. */
  dispose(): void;
}

/** A fresh `git init` repo under the OS temp dir, with a test identity configured. */
export function createTempRepo(prefix: string): TempGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  return {
    dir,
    git,
    dispose() {
      // Git object files are read-only; on Windows rmSync's force doesn't clear
      // the attribute, so chmod everything writable first.
      const makeWritable = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) { makeWritable(p); } else { fs.chmodSync(p, 0o666); }
        }
      };
      makeWritable(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
