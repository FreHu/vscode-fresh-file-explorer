import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { manifestDir } from "../manifest";

// SOURCE-LEVEL GUARDS, not behaviour tests.
//
// The destructive paths (delete a file, discard changes, paste over) are all
// correct today, and every one of them is a single argument away from not
// being: drop `useTrash: true` and deletes become unrecoverable; drop
// `overwrite: false` and a paste silently clobbers; drop the `--` and a
// filename that looks like a flag is read as one. Exercising these properly
// needs an extension host and a real workspace, so nothing in the fast tier
// covers them and the mutation would ship green.
//
// These assertions cannot prove the behaviour. They do prove nobody removed
// the argument that produces it, which is the failure actually worth catching.

const root = manifestDir();

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Non-comment source lines containing `needle`. */
function callsTo(source: string, needle: string): string[] {
  return source
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.includes(needle) && !l.startsWith("//") && !l.startsWith("*"));
}

suite("Destructive-command safety invariants", () => {
  test("the only workspace.fs.delete sends the file to the trash", () => {
    const source = read("src/commands/basicCommands.ts");
    const deletes = callsTo(source, "workspace.fs.delete");
    assert.strictEqual(deletes.length, 1, `expected exactly one fs.delete, found ${deletes.length}`);
    assert.ok(
      deletes[0].includes("useTrash: true"),
      `fs.delete must pass useTrash: true so a delete is recoverable — found: ${deletes[0]}`,
    );
  });

  test("no other module deletes from the filesystem", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "test") { walk(rel); }
        } else if (entry.name.endsWith(".ts") && rel !== "src/commands/basicCommands.ts") {
          if (callsTo(read(rel), "workspace.fs.delete").length > 0) { offenders.push(rel); }
        }
      }
    };
    walk("src");
    assert.deepStrictEqual(offenders, [], `unreviewed fs.delete call sites: ${offenders.join(", ")}`);
  });

  test("every rename and copy refuses to overwrite", () => {
    for (const rel of ["src/commands/basicCommands.ts", "src/commands/copyPasteCommands.ts"]) {
      const source = read(rel);
      for (const needle of ["workspace.fs.rename", "workspace.fs.copy"]) {
        for (const call of callsTo(source, needle)) {
          assert.ok(
            call.includes("overwrite: false"),
            `${rel}: ${needle} must pass overwrite: false so a paste cannot clobber — found: ${call}`,
          );
        }
      }
    }
  });

  test("every git mutation separates pathspecs with --", () => {
    const source = read("src/git/gitMutations.ts");
    // Any git arg array naming a file must terminate its options with `--`,
    // or a path such as `--force.txt` is parsed as a flag.
    const argArrays = source.match(/\[\s*"(?:clean|checkout|restore)"[^\]]*\]/g) ?? [];
    assert.ok(argArrays.length > 0, "expected to find git mutation arg arrays");
    for (const arr of argArrays) {
      assert.ok(
        arr.includes('"--"'),
        `git mutation arg array must contain a "--" pathspec separator: ${arr}`,
      );
    }
  });

  test("gitMutations only ever runs the mutating verbs it is reviewed for", () => {
    const source = read("src/git/gitMutations.ts");
    const verbs = new Set([...source.matchAll(/\[\s*"([a-z-]+)"/g)].map(m => m[1]));
    const allowed = new Set(["clean", "checkout", "restore"]);
    const unexpected = [...verbs].filter(v => !allowed.has(v));
    assert.deepStrictEqual(
      unexpected,
      [],
      `new git verb in gitMutations needs a pathspec review: ${unexpected.join(", ")}`,
    );
  });
});
