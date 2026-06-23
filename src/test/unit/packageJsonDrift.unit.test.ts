import * as assert from "assert";
import { Commands } from "../../commands/commandConstants";
import { ConfigKeys, CONFIG_SECTION } from "../../config/configKeyConstants";
import { ContextKeys, OWNED_NAMESPACES } from "../../extension/contextKeyConstants";
import { TreeItemContextValues } from "../../fresh-files/treeItemConstants";
import { BranchCompareContextValues } from "../../branch-compare/branchCompareConstants";
import { DiffSearchContextValues } from "../../diff-search/diffSearchConstants";
import { DEFAULT_TIME_WINDOWS } from "../../fresh-files/timeWindowUtils";
import * as fs from "fs";
import * as path from "path";
import {
  loadManifest,
  manifestDir,
  loadNlsKeys,
  declaredCommandIds,
  referencedCommandIds,
  configProperties,
  valueMatchesType,
  referencedContextKeys,
  referencedViewItemContextValues,
  declaredSubmenuIds,
  referencedSubmenuIds,
  menuGroupKeys,
  referencedAssetPaths,
  declaredViewIds,
  declaredViewContainerIds,
  viewLocationKeys,
  viewsWelcomeViewRefs,
  activationCommandRefs,
  activationViewRefs,
  nlsPlaceholders,
  versionFloor,
} from "../manifest";

// Drift checks: these read package.json off disk and import the
// vscode-free contribution constants, so they run under plain mocha

const manifest = loadManifest();
const commandConstants = Object.values(Commands) as string[];
const configKeyConstants = Object.values(ConfigKeys) as string[];

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      dupes.add(v);
    }
    seen.add(v);
  }
  return [...dupes];
}

/** Is this contributed id one this extension owns (vs a built-in)? */
function isOwned(id: string): boolean {
  return OWNED_NAMESPACES.some(ns => id.startsWith(ns));
}

suite("Commands ↔ package.json", () => {
  const declared = declaredCommandIds(manifest);

  test("every Commands constant is declared in package.json", () => {
    const missing = commandConstants.filter(c => !declared.includes(c));
    assert.deepStrictEqual(missing, [], `not declared in package.json: ${missing.join(", ")}`);
  });

  test("every declared command is in the Commands constant", () => {
    const missing = declared.filter(c => !commandConstants.includes(c));
    assert.deepStrictEqual(missing, [], `declared but not in Commands: ${missing.join(", ")}`);
  });

  test("no duplicate command ids in package.json", () => {
    assert.deepStrictEqual(duplicates(declared), [], "duplicate ids in contributes.commands");
  });

  test("no duplicate values in the Commands constant", () => {
    assert.deepStrictEqual(duplicates(commandConstants), [], "two Commands keys share a value");
  });
});

suite("Command references (menus + keybindings)", () => {
  const declared = declaredCommandIds(manifest);

  // Only our own commands must be declared in contributes.commands. Menus and
  // keybindings may legitimately reference built-in VS Code commands
  // (workbench.*, editor.*, etc.), which we neither declare nor own — so scope
  // the check to the extension namespace. A typo in one of our ids stays
  // namespaced and is still caught; a built-in ref is correctly ignored.
  test("every referenced freshFileExplorer command is declared", () => {
    const refs = referencedCommandIds(manifest).filter(isOwned);
    const dangling = refs.filter(c => !declared.includes(c));
    assert.deepStrictEqual(
      dangling,
      [],
      `menu/keybinding points at undeclared command(s): ${dangling.join(", ")}`
    );
  });
});

suite("Config keys ↔ package.json", () => {
  const props = configProperties(manifest);
  const configuredKeys = Object.keys(props);

  test("every ConfigKeys constant is declared in package.json", () => {
    const missing = configKeyConstants.filter(k => !configuredKeys.includes(k));
    assert.deepStrictEqual(missing, [], `not configured: ${missing.join(", ")}`);
  });

  test("every configured key is in the ConfigKeys constant", () => {
    const missing = configuredKeys.filter(k => !configKeyConstants.includes(k));
    assert.deepStrictEqual(missing, [], `configured but not in ConfigKeys: ${missing.join(", ")}`);
  });

  test("no duplicate values in the ConfigKeys constant", () => {
    assert.deepStrictEqual(duplicates(configKeyConstants), [], "two ConfigKeys keys share a value");
  });

  test("every configured key is namespaced under the config section", () => {
    const stray = configuredKeys.filter(k => !k.startsWith(`${CONFIG_SECTION}.`));
    assert.deepStrictEqual(stray, [], `not under "${CONFIG_SECTION}.": ${stray.join(", ")}`);
  });

  test("every setting's default matches its declared type", () => {
    const mismatches = Object.entries(props)
      .filter(([, prop]) => "default" in prop)
      .filter(([, prop]) => !valueMatchesType(prop.default, prop.type))
      .map(([key, prop]) => `${key} (type=${prop.type}, default=${JSON.stringify(prop.default)})`);
    assert.deepStrictEqual(mismatches, [], `default does not match type: ${mismatches.join("; ")}`);
  });

  test("every enum setting's enumDescriptions (if present) matches its enum length", () => {
    const mismatches = Object.entries(props)
      .filter(([, prop]) => Array.isArray(prop.enum) && Array.isArray(prop.enumDescriptions))
      .filter(([, prop]) => prop.enum!.length !== prop.enumDescriptions!.length)
      .map(([key, prop]) => `${key} (enum=${prop.enum!.length}, enumDescriptions=${prop.enumDescriptions!.length})`);
    assert.deepStrictEqual(mismatches, [], `enum/enumDescriptions length drift: ${mismatches.join("; ")}`);
  });

  test("every enum setting's default is one of its enum values", () => {
    const mismatches = Object.entries(props)
      .filter(([, prop]) => Array.isArray(prop.enum) && "default" in prop)
      .filter(([, prop]) => !prop.enum!.includes(prop.default))
      .map(([key, prop]) => `${key} (default=${JSON.stringify(prop.default)}, enum=${JSON.stringify(prop.enum)})`);
    assert.deepStrictEqual(mismatches, [], `default not in enum: ${mismatches.join("; ")}`);
  });
});

suite("Context keys (when clauses) ↔ ContextManager", () => {
  const contextKeyConstants = Object.values(ContextKeys) as string[];

  // A `when` clause that references a freshFileExplorer.* context key not set
  // anywhere (typo, or renamed on only one side) silently disables
  // the menu/binding. We can't see the runtime setContext calls from disk, but
  // funnelling every key through ContextManager (which uses these constants)
  // makes the constant the single source of truth — so a `when` reference that
  // isn't a known constant is a drift. One direction only: not every key is
  // used in a `when` (e.g. selectedFile is consumed by other extensions).
  test("every context key referenced in a when clause is a known ContextKeys constant", () => {
    const referenced = referencedContextKeys(manifest, OWNED_NAMESPACES);
    const unknown = referenced.filter(k => !contextKeyConstants.includes(k));
    assert.deepStrictEqual(
      unknown,
      [],
      `when clause references unknown context key(s): ${unknown.join(", ")}`
    );
  });

  test("no duplicate values in the ContextKeys constant", () => {
    assert.deepStrictEqual(duplicates(contextKeyConstants), [], "two ContextKeys keys share a value");
  });
});

suite("Submenus (contributes.submenus ↔ menus)", () => {
  const declared = declaredSubmenuIds(manifest);

  test("every referenced submenu resolves to a declared submenu", () => {
    const dangling = referencedSubmenuIds(manifest).filter(id => !declared.includes(id));
    assert.deepStrictEqual(dangling, [], `menu item opens undeclared submenu(s): ${dangling.join(", ")}`);
  });

  test("every declared submenu is referenced by a menu item", () => {
    const orphans = declared.filter(id => !referencedSubmenuIds(manifest).includes(id));
    assert.deepStrictEqual(orphans, [], `declared submenu(s) never used in a menu: ${orphans.join(", ")}`);
  });

  // A submenu's child items live under a menu-group key equal to its ID. Built-in
  // locations (editor/title, view/item/context, …) are not ours; any group key
  // under our namespace must therefore be a declared submenu — catching a typo in
  // the key that would silently orphan the submenu's items.
  test("every namespaced menu-group key is a declared submenu", () => {
    const orphanKeys = menuGroupKeys(manifest)
      .filter(isOwned)
      .filter(k => !declared.includes(k));
    assert.deepStrictEqual(orphanKeys, [], `menu-group key has no matching submenu declaration: ${orphanKeys.join(", ")}`);
  });

  test("no duplicate submenu ids", () => {
    assert.deepStrictEqual(duplicates(declared), [], "duplicate ids in contributes.submenus");
  });
});

suite("Tree contextValues (viewItem in when clauses) ↔ code", () => {
  // Every contextValue the code assigns to a tree item, from the vscode-free
  // constants modules. A `when` clause's `viewItem == X` (or `=~ /…(X)…/`) that
  // isn't one of these targets a contextValue the code never produces, so the
  // menu entry silently never appears. One direction only: plenty of
  // contextValues legitimately have no menu (group headers, submodules, …), so
  // we do NOT require every produced value to be referenced.
  const produced = [
    ...Object.values(TreeItemContextValues),
    ...Object.values(BranchCompareContextValues),
    ...Object.values(DiffSearchContextValues),
  ] as string[];

  test("every viewItem contextValue in a when clause is produced by the code", () => {
    const unknown = referencedViewItemContextValues(manifest).filter(v => !produced.includes(v));
    assert.deepStrictEqual(
      unknown,
      [],
      `when clause matches contextValue(s) the code never sets: ${unknown.join(", ")}`
    );
  });

  test("no duplicate values across the contextValue constant modules", () => {
    assert.deepStrictEqual(duplicates(produced), [], "two contextValue constants share a string");
  });
});

suite("Manifest assets & integrity", () => {
  test("every referenced file path exists on disk", () => {
    const root = manifestDir();
    const missing = referencedAssetPaths(manifest).filter(rel => !fs.existsSync(path.join(root, rel)));
    assert.deepStrictEqual(missing, [], `manifest references missing file(s): ${missing.join(", ")}`);
  });

  test("numeric setting defaults fall within [minimum, maximum]", () => {
    const props = configProperties(manifest);
    const bad: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      const { default: def, minimum: min, maximum: max } = prop;
      if (typeof min === "number" && typeof max === "number" && min > max) {
        bad.push(`${key} (minimum ${min} > maximum ${max})`);
      }
      if (typeof def === "number") {
        if (typeof min === "number" && def < min) {
          bad.push(`${key} (default ${def} < minimum ${min})`);
        }
        if (typeof max === "number" && def > max) {
          bad.push(`${key} (default ${def} > maximum ${max})`);
        }
      }
    }
    assert.deepStrictEqual(bad, [], `numeric default/min/max issue(s): ${bad.join("; ")}`);
  });

  test("timeWindows default matches the DEFAULT_TIME_WINDOWS constant", () => {
    const props = configProperties(manifest);
    const manifestDefault = props[ConfigKeys.TIME_WINDOWS]?.default;
    assert.deepStrictEqual(
      manifestDefault,
      DEFAULT_TIME_WINDOWS,
      "package.json timeWindows default drifted from the DEFAULT_TIME_WINDOWS constant",
    );
  });

  test("@types/vscode floor does not exceed the engines.vscode floor", () => {
    const engines = versionFloor(manifest.engines?.vscode);
    const types = versionFloor(manifest.devDependencies?.["@types/vscode"]);
    assert.ok(engines, "engines.vscode must be a parseable version range");
    assert.ok(types, "@types/vscode must be a parseable version range");
    // types newer than the engines floor lets you compile against APIs that
    // don't exist on the minimum VS Code you claim to support → runtime crash.
    const exceeds =
      types!.major > engines!.major ||
      (types!.major === engines!.major && types!.minor > engines!.minor) ||
      (types!.major === engines!.major && types!.minor === engines!.minor && types!.patch > engines!.patch);
    assert.ok(
      !exceeds,
      `@types/vscode floor ${manifest.devDependencies?.["@types/vscode"]} exceeds engines.vscode ${manifest.engines?.vscode}`
    );
  });

  // We can't validate a view's container key against an allowlist: built-in
  // containers (explorer, scm, …) aren't enumerable from disk, and VS Code
  // forbids dots in custom container ids (/^[a-z0-9_-]+$/i), so we can't tell
  // custom containers apart by namespace either. The sound check is the inverse
  // — every declared custom container must host a view. A typo'd view→container
  // reference trips it: the real container is left view-less (the typo'd key
  // silently falls back to Explorer).
  test("every declared view container hosts at least one view", () => {
    const used = new Set(viewLocationKeys(manifest));
    const orphans = declaredViewContainerIds(manifest).filter(id => !used.has(id));
    assert.deepStrictEqual(orphans, [], `declared container(s) with no views: ${orphans.join(", ")}`);
  });

  test("every viewsWelcome targets a declared view", () => {
    const views = declaredViewIds(manifest);
    const dangling = viewsWelcomeViewRefs(manifest).filter(v => !views.includes(v));
    assert.deepStrictEqual(dangling, [], `viewsWelcome for undeclared view(s): ${dangling.join(", ")}`);
  });

  test("activationEvents onCommand/onView reference declared contributions", () => {
    const commands = declaredCommandIds(manifest);
    const views = declaredViewIds(manifest);
    const badCmd = activationCommandRefs(manifest).filter(c => !commands.includes(c));
    const badView = activationViewRefs(manifest).filter(v => !views.includes(v));
    assert.deepStrictEqual(
      { badCmd, badView },
      { badCmd: [], badView: [] },
      `activationEvents reference undeclared contributions`
    );
  });

  test("no duplicate keybindings (same key + when)", () => {
    const sigs = (manifest.contributes?.keybindings ?? []).map(kb => `${kb.key ?? ""}|${kb.when ?? ""}`);
    assert.deepStrictEqual(duplicates(sigs), [], "conflicting keybindings share key + when");
  });

  test("every %nls% placeholder resolves to a package.nls.json key", () => {
    const placeholders = nlsPlaceholders(manifest);
    const nlsKeys = loadNlsKeys();
    if (placeholders.length === 0) {
      assert.strictEqual(nlsKeys, null, "package.nls.json present but no %placeholders% use it");
      return;
    }
    assert.ok(nlsKeys, "manifest uses %placeholders% but package.nls.json is missing");
    const missing = placeholders.filter(p => !nlsKeys!.includes(p));
    assert.deepStrictEqual(missing, [], `%placeholder% with no nls key: ${missing.join(", ")}`);
  });
});
