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
    "docs/architecture.md": "# Architecture\n",
    "src/checkout/payment.ts": PAYMENT_V1,
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
    const { name, email } = AUTHORS[step.author];
    const date = new Date(now - step.daysAgo * DAY_MS).toISOString();
    git(target, ["commit", "-q", "-m", step.message], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date,
    });
    if (step.tag) { git(target, ["tag", step.tag]); }
  }

  writeFiles(target, PENDING.staged);
  git(target, ["add", "-A"]);
  writeFiles(target, PENDING.modified);
  writeFiles(target, PENDING.untracked);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const target = resolve(process.argv[2] ?? join(repoRoot, ".scratch/claude/demo/orbit-shop"));
  buildFixtureRepo(target);
  console.log(target);
  console.log(git(target, ["log", "--format=%ar  %an  %s"]));
  console.log(git(target, ["status", "--short"]));
}
