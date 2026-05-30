// Reads and dissects package.json WITHOUT the `vscode` API — just `fs`.
// This is what lets the drift checks run as a fast, host-free unit tier
// (plain mocha, no Extension Host): the manifest is plain data on disk, and
// the contribution constants it's compared against are vscode-free too.

import * as fs from "fs";
import * as path from "path";

interface CommandContribution {
  command: string;
  title?: string;
  icon?: string | { light?: string; dark?: string };
}

interface MenuItem {
  command?: string;
  /** Alternate command, triggered when the menu is opened with Alt held. */
  alt?: string;
  submenu?: string;
  when?: string;
}

interface Keybinding {
  command?: string;
  key?: string;
  when?: string;
}

interface ConfigProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  enumDescriptions?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
}

/** `contributes.configuration` may be a single object OR an array of objects. */
type ConfigurationContribution =
  | { title?: string; properties?: Record<string, ConfigProperty> }
  | Array<{ title?: string; properties?: Record<string, ConfigProperty> }>;

interface ViewContribution {
  id?: string;
  when?: string;
  icon?: string;
}

interface ViewsWelcomeContribution {
  view?: string;
  when?: string;
}

interface SubmenuContribution {
  id: string;
  label?: string;
  icon?: string | { light?: string; dark?: string };
}

interface ViewContainerContribution {
  id?: string;
  icon?: string;
}

interface PathContribution {
  path?: string;
}

interface Contributes {
  commands?: CommandContribution[];
  menus?: Record<string, MenuItem[]>;
  keybindings?: Keybinding[];
  configuration?: ConfigurationContribution;
  views?: Record<string, ViewContribution[]>;
  viewsWelcome?: ViewsWelcomeContribution[];
  submenus?: SubmenuContribution[];
  viewsContainers?: Record<string, ViewContainerContribution[]>;
  themes?: PathContribution[];
  iconThemes?: PathContribution[];
  grammars?: PathContribution[];
  snippets?: PathContribution[];
}

export interface Manifest {
  name: string;
  version: string;
  main?: string;
  browser?: string;
  icon?: string;
  l10n?: string;
  engines?: { vscode?: string };
  devDependencies?: Record<string, string>;
  activationEvents?: string[];
  contributes?: Contributes;
}

/** The extension root — where package.json lives. When compiled, this module
 *  is at `out/test/manifest.js`, so the root is two levels up. Asset paths in
 *  the manifest are resolved relative to here. */
export function manifestDir(): string {
  return path.join(__dirname, "..", "..");
}

/** Load the extension's package.json from the repo root. */
export function loadManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(manifestDir(), "package.json"), "utf8")) as Manifest;
}

/** Keys of `package.nls.json` (the NLS message bundle), or null if absent. */
export function loadNlsKeys(): string[] | null {
  const nlsPath = path.join(manifestDir(), "package.nls.json");
  if (!fs.existsSync(nlsPath)) {
    return null;
  }
  return Object.keys(JSON.parse(fs.readFileSync(nlsPath, "utf8")) as Record<string, unknown>);
}

/** Command IDs declared in `contributes.commands` (may contain duplicates —
 *  callers that care should check). */
export function declaredCommandIds(manifest: Manifest): string[] {
  return (manifest.contributes?.commands ?? []).map(c => c.command);
}

/** Every command ID referenced from a menu item or keybinding. These must
 *  resolve to a declared command, or the menu/binding silently does nothing. */
export function referencedCommandIds(manifest: Manifest): string[] {
  const refs: string[] = [];
  const menus = manifest.contributes?.menus ?? {};
  for (const items of Object.values(menus)) {
    for (const item of items) {
      if (item.command) {
        refs.push(item.command);
      }
      if (item.alt) {
        refs.push(item.alt);
      }
    }
  }
  for (const binding of manifest.contributes?.keybindings ?? []) {
    if (binding.command) {
      refs.push(binding.command);
    }
  }
  return refs;
}

/** Flatten `contributes.configuration` (object OR array form) to a single
 *  map of setting key -> property definition. */
export function configProperties(manifest: Manifest): Record<string, ConfigProperty> {
  const config = manifest.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : config ? [config] : [];
  const merged: Record<string, ConfigProperty> = {};
  for (const block of blocks) {
    Object.assign(merged, block.properties ?? {});
  }
  return merged;
}

/** Does a JSON value match a declared VS Code setting `type`? `type` may be a
 *  string or an array of allowed types (e.g. ["string", "null"]). */
export function valueMatchesType(value: unknown, type: string | string[] | undefined): boolean {
  if (type === undefined) {
    return true; // no declared type to violate
  }
  const types = Array.isArray(type) ? type : [type];
  return types.some(t => matchesSingleType(value, t));
}

function matchesSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword — don't fail on it
  }
}

/** Submenu IDs declared in `contributes.submenus`. */
export function declaredSubmenuIds(manifest: Manifest): string[] {
  return (manifest.contributes?.submenus ?? []).map(s => s.id);
}

/** Submenu IDs referenced from a menu item's `submenu` field. Each must
 *  resolve to a declared submenu, or the entry opens an empty/missing menu. */
export function referencedSubmenuIds(manifest: Manifest): string[] {
  const refs: string[] = [];
  for (const items of Object.values(manifest.contributes?.menus ?? {})) {
    for (const item of items) {
      if (item.submenu) {
        refs.push(item.submenu);
      }
    }
  }
  return refs;
}

/** The keys of `contributes.menus` — each is either a built-in menu location
 *  (e.g. `editor/title`, `view/item/context`) or one of our own submenu IDs
 *  (where that submenu's child items live). */
export function menuGroupKeys(manifest: Manifest): string[] {
  return Object.keys(manifest.contributes?.menus ?? {});
}

/** Every `when` clause string across menus, keybindings, views, and welcome
 *  views — the places a context key can be referenced. */
export function collectWhenClauses(manifest: Manifest): string[] {
  const c = manifest.contributes;
  const whens: string[] = [];
  const push = (w?: string): void => {
    if (w) {
      whens.push(w);
    }
  };
  for (const items of Object.values(c?.menus ?? {})) {
    for (const item of items) {
      push(item.when);
    }
  }
  for (const binding of c?.keybindings ?? []) {
    push(binding.when);
  }
  for (const views of Object.values(c?.views ?? {})) {
    for (const view of views) {
      push(view.when);
    }
  }
  for (const welcome of c?.viewsWelcome ?? []) {
    push(welcome.when);
  }
  return whens;
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Context keys (under one of `namespaces`, e.g. "freshFileExplorer.") that are
 * REFERENCED in a `when` clause. A `when` clause mixes three dotted-token
 * shapes: our context keys, view ids (`view == freshFileExplorer.branchCompare`),
 * and tree-item contextValues (`viewItem == freshFileExplorer.branchCompare.file`).
 * The latter two only ever appear as the right-hand side of a `==` / `!=` / `=~`
 * comparison, so we strip every comparison's RHS first, then any namespaced
 * token left standing is a genuine context-key reference (bare, negated with
 * `!`, or an `in`/`&&` operand). Erring toward dropping (a key compared as an
 * RHS would be missed) keeps the check free of false positives.
 */
/**
 * Tree-item contextValues referenced by `viewItem` in `when` clauses. Two
 * shapes appear: `viewItem == foo` and `viewItem =~ /^<prefix>(a|b|c)$/`. Each
 * must be a contextValue the code actually assigns, or the menu entry silently
 * never shows. Only the equality/regex RHS is read — never the bare key — so a
 * context key in the same clause isn't mistaken for a contextValue.
 */
export function referencedViewItemContextValues(manifest: Manifest): string[] {
  const values = new Set<string>();
  for (const when of collectWhenClauses(manifest)) {
    for (const m of when.matchAll(/viewItem\s*==\s*'?([\w.]+)'?/g)) {
      values.add(m[1]);
    }
    for (const m of when.matchAll(/viewItem\s*=~\s*\/([^/]+)\//g)) {
      const body = m[1];
      // ^<prefix>(alt1|alt2|...)$ — prefix may be an escaped dotted string.
      const grouped = body.match(/^\^([^(]*)\(([^)]*)\)\$?$/);
      if (grouped) {
        const prefix = grouped[1].replace(/\\(.)/g, "$1");
        for (const alt of grouped[2].split("|")) {
          values.add(prefix + alt);
        }
        continue;
      }
      // Plain literal regex, e.g. /^foo$/.
      const literal = body.replace(/^\^/, "").replace(/\$$/, "").replace(/\\(.)/g, "$1");
      if (/^[\w.]+$/.test(literal)) {
        values.add(literal);
      }
    }
  }
  return [...values];
}

export function referencedContextKeys(manifest: Manifest, namespaces: readonly string[]): string[] {
  const rhs = /(?:==|!=|=~)\s*(?:\/[^/]*\/|'[^']*'|"[^"]*"|[^\s)]+)/g;
  const nsAlt = namespaces.map(escapeForRegExp).join("|");
  const tokenRe = new RegExp(`(?:${nsAlt})[A-Za-z0-9_.]+`, "g");
  const keys = new Set<string>();
  for (const when of collectWhenClauses(manifest)) {
    const cleaned = when.replace(rhs, " ");
    for (const match of cleaned.match(tokenRe) ?? []) {
      keys.add(match);
    }
  }
  return [...keys];
}

/** Does a manifest string value look like a relative file path (vs a codicon
 *  reference like `$(git-compare)`, a URL, or a plain identifier)? */
function looksLikeAssetPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("$(") &&
    !/^[a-z]+:\/\//i.test(value) &&
    /[/.]/.test(value)
  );
}

/** Every relative file path the manifest references as an AUTHORED asset — the
 *  icon, command/view/container/submenu icons, theme/grammar/snippet paths.
 *  Each must exist on disk or the extension ships a broken reference. Build
 *  outputs (`main`, `browser`) are deliberately excluded: they're produced by
 *  the build, not authored, so checking them would couple this fast, host-free
 *  test to a prior build step. */
export function referencedAssetPaths(manifest: Manifest): string[] {
  const paths: string[] = [];
  const add = (v: unknown): void => {
    if (looksLikeAssetPath(v)) {
      paths.push(v);
    }
  };
  const addIcon = (icon: string | { light?: string; dark?: string } | undefined): void => {
    if (typeof icon === "string") {
      add(icon);
    } else if (icon) {
      add(icon.light);
      add(icon.dark);
    }
  };

  add(manifest.icon);
  add(manifest.l10n);

  const c = manifest.contributes ?? {};
  for (const cmd of c.commands ?? []) {
    addIcon(cmd.icon);
  }
  for (const views of Object.values(c.views ?? {})) {
    for (const view of views) {
      add(view.icon);
    }
  }
  for (const containers of Object.values(c.viewsContainers ?? {})) {
    for (const container of containers) {
      add(container.icon);
    }
  }
  for (const submenu of c.submenus ?? []) {
    addIcon(submenu.icon);
  }
  for (const list of [c.themes, c.iconThemes, c.grammars, c.snippets]) {
    for (const entry of list ?? []) {
      add(entry.path);
    }
  }
  return [...new Set(paths)];
}

/** View IDs declared in `contributes.views`. */
export function declaredViewIds(manifest: Manifest): string[] {
  return Object.values(manifest.contributes?.views ?? {})
    .flat()
    .map(v => v.id)
    .filter((id): id is string => !!id);
}

/** View-container IDs declared in `contributes.viewsContainers`. */
export function declaredViewContainerIds(manifest: Manifest): string[] {
  return Object.values(manifest.contributes?.viewsContainers ?? {})
    .flat()
    .map(v => v.id)
    .filter((id): id is string => !!id);
}

/** The keys of `contributes.views` — the container each view group is placed
 *  into (a built-in location like `explorer`, or a declared custom container). */
export function viewLocationKeys(manifest: Manifest): string[] {
  return Object.keys(manifest.contributes?.views ?? {});
}

/** View IDs referenced by `contributes.viewsWelcome[].view`. */
export function viewsWelcomeViewRefs(manifest: Manifest): string[] {
  return (manifest.contributes?.viewsWelcome ?? [])
    .map(w => w.view)
    .filter((v): v is string => !!v);
}

/** `activationEvents` of the form `onCommand:<id>`, returning the command IDs. */
export function activationCommandRefs(manifest: Manifest): string[] {
  return (manifest.activationEvents ?? [])
    .filter(e => e.startsWith("onCommand:"))
    .map(e => e.slice("onCommand:".length));
}

/** `activationEvents` of the form `onView:<id>`, returning the view IDs. */
export function activationViewRefs(manifest: Manifest): string[] {
  return (manifest.activationEvents ?? [])
    .filter(e => e.startsWith("onView:"))
    .map(e => e.slice("onView:".length));
}

/** Every `%placeholder%` NLS token used in any string value of the manifest. */
export function nlsPlaceholders(manifest: Manifest): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(/%([\w.]+)%/g)) {
        found.add(m[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(manifest);
  return [...found];
}

/** Parse the lowest version a dependency/engine range allows (the floor of a
 *  `^`/`~`/`>=` range, or an exact version). Null if unparseable. */
export function versionFloor(range: string | undefined): { major: number; minor: number; patch: number } | null {
  if (!range) {
    return null;
  }
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(range);
  if (!match) {
    return null;
  }
  return { major: +match[1], minor: +match[2], patch: match[3] ? +match[3] : 0 };
}
