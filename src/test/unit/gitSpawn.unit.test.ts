import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GitError, GIT_TIMEOUT_SETTING, spawnGitSettled } from "../../git/gitSpawn";

// Spawns real `git` against a throwaway repo. These are the regression guards
// for two defects the old per-file spawn wrappers shared: a timeout kill
// reported as "exited with code null", and rejections that were bare strings
// (so `error.message` rendered the literal "undefined" in user-facing toasts).

let repo: string;

function collect(): { onStdout(c: Buffer): void; onSuccess(): string } {
  let out = "";
  return {
    onStdout: c => {
      out += c.toString();
    },
    onSuccess: () => out,
  };
}

suite("spawnGitSettled", () => {
  suiteSetup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ffe-gitspawn-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    run("add", "a.txt");
    run("commit", "-qm", "first");
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("resolves with accumulated stdout on exit 0", async () => {
    const out = await spawnGitSettled(["rev-parse", "--is-inside-work-tree"], repo, undefined, collect());
    assert.strictEqual(out.trim(), "true");
  });

  test("rejects with a GitError carrying stderr and exit code", async () => {
    await assert.rejects(
      () => spawnGitSettled(["cat-file", "-p", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], repo, undefined, collect()),
      (err: unknown) => {
        assert.ok(err instanceof GitError, "should be a GitError");
        assert.ok(err instanceof Error, "GitError must be an Error");
        assert.notStrictEqual(err.exitCode, 0);
        assert.strictEqual(err.signal, null);
        assert.strictEqual(err.timedOut, false);
        assert.ok(err.message.length > 0, "message must not be empty");
        return true;
      },
    );
  });

  // The old wrappers rejected with strings, so `error.message` was undefined
  // and toasts rendered the literal text "undefined".
  test("a rejected git call always yields a usable .message", async () => {
    await assert.rejects(
      () => spawnGitSettled(["cat-file", "-p", "nope"], repo, undefined, collect()),
      (err: unknown) => {
        const rendered = err instanceof Error ? err.message : String(err);
        assert.ok(!rendered.includes("undefined"), `rendered message leaked "undefined": ${rendered}`);
        return true;
      },
    );
  });

  // Every pre-existing call site renders git failures via String(err) or
  // `${err}`. Node's default would prefix "Error: "; the toString override
  // keeps those sites byte-identical.
  test("String(err) yields the bare message, not \"Error: ...\"", () => {
    const err = new GitError("boom", { args: ["status"], cwd: "/tmp" });
    assert.strictEqual(String(err), "boom");
    assert.strictEqual(`${err}`, "boom");
    assert.strictEqual(err.message, "boom");
  });

  test("a timeout kill reports actionable timeout text, not 'exited with code null'", async function () {
    this.timeout(20000);
    await assert.rejects(
      // Deterministic hang: `hash-object --stdin` reads until EOF, and spawn
      // leaves stdin an open pipe nobody closes — so the timeout always wins.
      // (A short timeout on a normal git call races the process and flakes.)
      () => spawnGitSettled(["hash-object", "--stdin"], repo, 250, collect()),
      (err: unknown) => {
        assert.ok(err instanceof GitError);
        // Timing-dependent: if git beat the 1ms timer the call resolves and
        // assert.rejects fails loudly instead of silently passing.
        assert.strictEqual(err.timedOut, true);
        assert.notStrictEqual(err.signal, null, "a killed child must report its signal");
        assert.ok(
          !err.message.includes("code null"),
          `timeout must not surface as an exit code: ${err.message}`,
        );
        assert.ok(
          err.message.includes(GIT_TIMEOUT_SETTING),
          `timeout message must name the setting to raise: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("a missing git binary rejects as GitError, preserving the cause", async () => {
    await assert.rejects(
      () => spawnGitSettled(["status"], path.join(repo, "does-not-exist"), undefined, collect()),
      (err: unknown) => {
        assert.ok(err instanceof GitError, "spawn failures must be GitErrors too");
        assert.ok(err.cause !== undefined, "the underlying spawn error must be preserved");
        return true;
      },
    );
  });

  test("onFinish runs before the exit status is judged, so trailing output is not lost", async () => {
    let finished = false;
    await assert.rejects(
      () =>
        spawnGitSettled(["cat-file", "-p", "nope"], repo, undefined, {
          onStdout: () => undefined,
          onFinish: () => {
            finished = true;
          },
          onSuccess: () => undefined,
        }),
      () => true,
    );
    assert.strictEqual(finished, true, "onFinish must fire even when git exits non-zero");
  });
});
