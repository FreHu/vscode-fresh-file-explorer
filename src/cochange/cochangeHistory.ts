import { spawnGitLines } from "../git/gitLogStream";
import { ConfigService } from "../config/configService";
import { CochangeCommit } from "./cochangeEngine";

/** Marks the start of a commit block in the streamed log. */
const COMMIT_MARK = "\x01";
/**
 * Marks the end of the commit message. Necessary because `%B` is multi-line
 * and `--name-only` prints file paths as bare lines — without a terminator,
 * body lines and file paths would be indistinguishable.
 */
const MESSAGE_END = "\x02";

/**
 * Collect per-commit file lists for the co-change engine: one on-demand
 * `git log --name-only` over the lookback window, streamed and discarded —
 * nothing is cached, matching the feature's explicit-command cost model.
 *
 * The full commit message (subject + body) is captured: ticket references
 * often live in the body — pasted tracker URLs, `Refs:` trailers.
 * Paths are repo-relative with forward slashes, exactly as git prints them.
 */
export async function collectCochangeHistory(
  repoFullPath: string,
  lookbackDays: number,
): Promise<CochangeCommit[]> {
  const commits: CochangeCommit[] = [];
  let current: CochangeCommit | undefined;
  let inMessage = false;

  const appendMessageLine = (line: string): void => {
    if (!current) { return; }
    const end = line.indexOf(MESSAGE_END);
    if (end !== -1) {
      current.message = (current.message + " " + line.substring(0, end)).trim();
      inMessage = false;
    } else {
      current.message = (current.message + " " + line).trim();
    }
  };

  await spawnGitLines(
    [
      "log",
      "--no-merges",
      `--since=${lookbackDays} days ago`,
      "--name-only",
      `--pretty=format:${COMMIT_MARK}%at%x1f%B%x02`,
    ],
    repoFullPath,
    ConfigService.getGitTimeoutMs(),
    line => {
      if (line.startsWith(COMMIT_MARK)) {
        const sep = line.indexOf("\x1f");
        current = { files: [], at: Number(line.substring(1, sep)) * 1000, message: "" };
        commits.push(current);
        inMessage = true;
        appendMessageLine(line.substring(sep + 1));
      } else if (inMessage) {
        appendMessageLine(line);
      } else if (line.length > 0 && current) {
        current.files.push(line);
      }
    },
  );

  return commits;
}
