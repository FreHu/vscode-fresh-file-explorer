// Builds a throwaway git repo for demo screenshots. Commit dates are relative to
// now, so every time window has content whenever the demo is recorded.
// Usage: node scripts/demo/fixtureRepo.mjs [targetDir]

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAYMENT_PENDING, PAYMENT_V1, PAYMENT_V2, PAYMENT_V3, PAYMENT_V4 } from "./fixturePayment.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

const AUTHORS = {
  ada: { name: "Ada Okafor", email: "ada@example.com" },
  bo: { name: "Bo Lindqvist", email: "bo@example.com" },
  carmen: { name: "Carmen Reyes", email: "carmen@example.com" },
};

/**
 * Oldest first. `daysAgo` may be fractional; `files` maps path → content, null deletes.
 * Later steps only touch some files so the time windows split them up.
 */
const HISTORY = [
  { daysAgo: 85, author: "ada", message: "Initial project layout", files: {
    "package.json": '{\n  "name": "orbit-shop",\n  "version": "0.1.0"\n}\n',
    "README.md": "# Orbit Shop\n\nA small storefront.\n",
    "src/server.ts": "export function start() {}\n",
    "src/cart/cart.ts": "export class Cart {}\n",
    "src/catalog/products.ts": "export const products = [];\n",
    "docs/architecture.md": [
      "# Architecture", "", "## Storefront", "", "### Catalog", "", "### Cart", "",
      "## Checkout", "", "### Payments", "", "### Retries", "", "## Operations", "",
    ].join("\n"),
    "src/checkout/payment.ts": PAYMENT_V1,
    "src/checkout/legacyCheckout.ts": "export function legacyCheckout() {}\n",
  } },
  { daysAgo: 40, author: "bo", message: "Add checkout flow", files: {
    "src/checkout/checkout.ts": "export function checkout() {}\n",
    "src/checkout/payment.ts": PAYMENT_V2,
  } },
  { daysAgo: 30, author: "ada", message: "Release 1.0", tag: "v1.0.0", files: {
    "package.json": '{\n  "name": "orbit-shop",\n  "version": "1.0.0"\n}\n',
  } },
  { daysAgo: 20, author: "carmen", message: "Product search", files: {
    "src/catalog/search.ts": "export function search(q: string) { return q; }\n",
    "src/catalog/products.ts": "export const products = [{ id: 1 }];\n",
  } },
  { daysAgo: 12, author: "carmen", message: "Per-currency payment limits", files: {
    "src/checkout/payment.ts": PAYMENT_V3,
  } },
  { daysAgo: 9, author: "ada", message: "Cart totals with tax", files: {
    "src/cart/cart.ts": "export class Cart {\n  total() { return 0; }\n}\n",
    "src/cart/tax.ts": "export const TAX_RATE = 0.21;\n",
  } },
  { daysAgo: 5, author: "bo", message: "Retry failed payments", files: {
    "src/checkout/payment.ts": PAYMENT_V4,
    "src/checkout/retry.ts": "export function retry() {}\n",
  } },
  // A deleted file: the tree keeps it where it was, ready to restore.
  { daysAgo: 3, author: "bo", message: "Remove legacy checkout", files: {
    "src/checkout/legacyCheckout.ts": null,
  } },
  { daysAgo: 2, author: "carmen", message: "Document the search API", files: {
    "docs/search.md": "# Search\n",
    "README.md": "# Orbit Shop\n\nA small storefront with product search.\n",
  } },
  { daysAgo: 0.2, author: "ada", message: "Discount codes", files: {
    "src/cart/discounts.ts": "export function applyDiscount() {}\n",
    "src/cart/cart.ts": "export class Cart {\n  total() { return 0; }\n  discount() {}\n}\n",
  } },
];

/** Uncommitted changes on top of HEAD: modified, staged, untracked. */
const PENDING = {
  modified: {
    "src/catalog/search.ts": "export function search(q: string) { return q.trim(); }\n",
    "src/checkout/payment.ts": PAYMENT_PENDING,
  },
  staged: { "src/server.ts": "export function start() {\n  // listen\n}\n" },
  untracked: { "src/cart/giftCards.ts": "export class GiftCard {}\n" },
};

function git(cwd, args, env = {}) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function buildFixtureRepo(target, now = Date.now()) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "commit.gpgsign", "false"]);
  git(target, ["config", "core.autocrlf", "false"]);
  // Pending changes are shown under the current git identity: never the real user's in a published shot.
  git(target, ["config", "user.name", AUTHORS.ada.name]);
  git(target, ["config", "user.email", AUTHORS.ada.email]);

  for (const step of HISTORY) {
    writeFiles(target, step.files);
    git(target, ["add", "-A"]);
    commitAs(target, step, now);
    if (step.tag) { git(target, ["tag", step.tag]); }
  }

  writeFiles(target, PENDING.staged);
  git(target, ["add", "-A"]);
  writeFiles(target, PENDING.modified);
  writeFiles(target, PENDING.untracked);
  return target;
}

/**
 * Commits as a fixture author at a time relative to `now`. `paths` limits the commit
 * to those files, leaving anything else staged as it was.
 */
function commitAs(repo, { author, daysAgo, message }, now, paths = []) {
  const { name, email } = AUTHORS[author];
  const date = new Date(now - daysAgo * DAY_MS).toISOString();
  git(repo, ["commit", "-q", "-m", message, ...(paths.length ? ["--", ...paths] : [])], {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date,
  });
}

/**
 * Gives `repo` an `origin` (a bare repo at `remoteDir`) that has moved on: the remote
 * gains `REMOTE_ONLY` commits, the local repo one unpushed commit. Drives the
 * "behind origin" / "unpushed" warnings at the top of the tree.
 */
export function addDivergedRemote(repo, remoteDir, now = Date.now()) {
  rmSync(remoteDir, { recursive: true, force: true });
  git(repo, ["clone", "-q", "--bare", ".", remoteDir]);
  git(repo, ["remote", "add", "origin", remoteDir]);
  git(repo, ["fetch", "-q", "origin"]);
  git(repo, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);

  const other = `${remoteDir}-clone`;
  rmSync(other, { recursive: true, force: true });
  git(repo, ["clone", "-q", remoteDir, other]);
  git(other, ["config", "core.autocrlf", "false"]);
  for (const [i, step] of REMOTE_ONLY.entries()) {
    writeFiles(other, { [`docs/release-notes-${i + 1}.md`]: `# ${step.message}\n` });
    git(other, ["add", "-A"]);
    commitAs(other, step, now);
  }
  git(other, ["push", "-q", "origin", "main"]);
  rmSync(other, { recursive: true, force: true });
  git(repo, ["fetch", "-q", "origin"]);

  writeFiles(repo, { "src/cart/coupons.ts": "export function validateCoupon() {}\n" });
  git(repo, ["add", "src/cart/coupons.ts"]);
  commitAs(repo, { author: "ada", daysAgo: 0.05, message: "Coupon validation" }, now, ["src/cart/coupons.ts"]);
}

/**
 * A workspace folder holding the fixture repo and linked worktrees next to it
 * (`<root>/orbit-shop`, `<root>/orbit-shop-<name>`), the layout parallel agents use.
 * Each worktree gets its own branch and the given uncommitted files.
 * @param {Record<string, Record<string, string>>} worktrees name → { path: content }
 */
export function buildWorktreeWorkspace(root, worktrees = {}, now = Date.now()) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const main = buildFixtureRepo(join(root, "orbit-shop"), now);
  const paths = {};
  for (const [name, files] of Object.entries(worktrees)) {
    const dir = join(root, `orbit-shop-${name}`);
    git(main, ["worktree", "add", "-q", dir, "-b", `feature/${name}`]);
    git(dir, ["config", "core.autocrlf", "false"]);
    writeFiles(dir, files);
    paths[name] = dir;
  }
  return { root, main, worktrees: paths };
}

const REMOTE_ONLY = [
  { author: "bo", daysAgo: 0.3, message: "Release notes for 1.1" },
  { author: "carmen", daysAgo: 0.2, message: "Search tuning notes" },
  { author: "bo", daysAgo: 0.1, message: "Payment FAQ" },
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const target = resolve(process.argv[2] ?? join(repoRoot, ".scratch/claude/demo/orbit-shop"));
  buildFixtureRepo(target);
  console.log(target);
  console.log(git(target, ["log", "--format=%ar  %an  %s"]));
  console.log(git(target, ["status", "--short"]));
}
