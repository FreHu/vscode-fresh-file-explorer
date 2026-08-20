import * as cp from "child_process";

// The single git-subprocess primitive. Four near-identical spawn/settle
// implementations used to live in gitOperations.ts (x2), gitLogStream.ts and
// diffSearchParser.ts; they drifted independently and all three carried the
// same two defects (a timeout kill reported as "exited with code null", and
// rejections that were bare strings). Everything that spawns git goes through
// here so a fix lands once.
//
// Deliberately free of `vscode` and ConfigService imports so it runs in the
// fast, host-free unit tier.

/** The config key surfaced when a git call is killed by its timeout. */
export const GIT_TIMEOUT_SETTING = "freshFileExplorer.gitTimeout";

/**
 * A failed git invocation, carrying the parts callers need to act on.
 *
 * `toString()` returns the bare message rather than Node's `"Error: <message>"`.
 * Most call sites render git failures with `String(err)` or `` `${err}` ``, and
 * those predate this class — the override keeps their output byte-identical
 * while `instanceof Error` and `.message` start working.
 */
export class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly args: readonly string[];
  readonly cwd: string;

  constructor(
    message: string,
    details: {
      stderr?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      timedOut?: boolean;
      args: readonly string[];
      cwd: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GitError";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.timedOut = details.timedOut ?? false;
    this.args = details.args;
    this.cwd = details.cwd;
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }

  override toString(): string {
    return this.message;
  }
}

export interface SpawnGitHandlers<T> {
  /** Every stdout chunk, in order. */
  onStdout(chunk: Buffer): void;
  /**
   * Runs once on close, before the exit status is judged — so a trailing
   * partial line is still flushed when git exits non-zero. Must not throw.
   */
  onFinish?(): void;
  /** Builds the resolved value. Called only when git exited 0. */
  onSuccess(): T;
}

/**
 * Spawn `git` and settle once it closes: resolve with `onSuccess()` on exit 0,
 * reject with a {@link GitError} otherwise.
 *
 * A `timeout` makes Node kill the child, which surfaces as a signal with a null
 * exit code — reported here as an actionable timeout rather than the bare
 * "exited with code null" the old wrappers produced.
 */
export function spawnGitSettled<T>(
  args: string[],
  cwd: string,
  timeout: number | undefined,
  handlers: SpawnGitHandlers<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => handlers.onStdout(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(
        new GitError(error.message, {
          stderr,
          args,
          cwd,
          cause: error,
        }),
      );
    });

    child.on("close", (code, signal) => {
      handlers.onFinish?.();

      if (signal !== null) {
        // `timeout` is the only thing in this codebase that kills a git child,
        // so a signal with a timeout configured is a timeout.
        const timedOut = timeout !== undefined;
        const message = timedOut
          ? `git timed out after ${timeout}ms — increase \`${GIT_TIMEOUT_SETTING}\` if this repository is large (git ${args[0] ?? ""})`
          : `git was terminated by ${signal} (git ${args[0] ?? ""})`;
        reject(new GitError(message, { stderr, exitCode: code, signal, timedOut, args, cwd }));
        return;
      }

      if (code !== 0) {
        reject(
          new GitError(stderr || `git exited with code ${code}`, {
            stderr,
            exitCode: code,
            args,
            cwd,
          }),
        );
        return;
      }

      resolve(handlers.onSuccess());
    });
  });
}
