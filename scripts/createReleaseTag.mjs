// Create the release tag for the current package.json version — but only after
// the full suite has passed. Invoked via `npm run tag`, which runs `npm test`
// first, so a red build never produces a tag.
//
// Pushing the tag is left to you (`git push origin <tag>`) — that push is what
// triggers the publish pipeline, so it stays a deliberate, separate step.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;

// A release tag must point at a committed state — refuse on a dirty tree so the
// tag can never capture uncommitted changes. (Bump version + changelog, commit,
// then run this.)
const dirty = execSync("git status --porcelain").toString().trim();
if (dirty) {
  console.error(`✗ Working tree is dirty. Commit the ${version} release first, then re-run \`npm run tag\`.`);
  process.exit(1);
}

// Never clobber an existing tag — that would silently re-point a shipped version.
let exists = false;
try {
  execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: "ignore" });
  exists = true;
} catch { /* tag does not exist — good */ }
if (exists) {
  console.error(`✗ Tag ${tag} already exists. Bump the version in package.json (or delete the tag) and re-run.`);
  process.exit(1);
}

execSync(`git tag ${tag}`, { stdio: "inherit" });
console.log(`\n✓ Tests passed. Created ${tag}.\n  Publish with:  git push origin ${tag}`);
