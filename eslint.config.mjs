import typescriptEslint from "typescript-eslint";

// All settings access funnels through ConfigService (see CLAUDE.md).
const NO_RAW_CONFIG = {
    selector: "CallExpression[callee.object.property.name='workspace'][callee.property.name='getConfiguration']",
    message: "Read settings through ConfigService, not vscode.workspace.getConfiguration directly (see CLAUDE.md).",
};

// Hand-rolled git calls drifted apart and missed the timeout and GitError
// handling. Any call taking the literal "git" as its first argument — spawn,
// execFile, a promisified alias — goes through spawnGitSettled / execGitWithArgs instead.
const NO_RAW_GIT = {
    selector: "CallExpression[arguments.0.value='git']",
    message: "Run git through execGitWithArgs / spawnGitSettled (src/git/), not child_process directly (see CLAUDE.md).",
};

export default [{
    // Directories that must never be linted regardless of how ESLint is invoked
    ignores: [
        "node_modules/**",
        "out/**",
        "dist/**",
        "coverage/**",
        "media/**",       // compiled webview bundles
        "**/*.js",        // compiled output; source is all .ts
    ],
}, {
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
        parserOptions: {
            // Type-aware linting. projectService resolves each file to its
            // nearest tsconfig (root for extension, src/webview for bundles),
            // so the two configs are handled automatically.
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        // Type-aware: the project's #1 footgun. This is heavily async,
        // git-spawning code whose refreshEpoch/RefreshCancelledError design
        // throws across async boundaries — a detached refresh promise becomes
        // an unhandled rejection with no handler. Fire-and-forget must be an
        // explicit `void`.
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-misused-promises": "error",

        // Disable the base rule — the TS-aware version handles everything below
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": ["warn", {
            vars: "all",
            args: "after-used",
            // Prefix with _ to intentionally suppress (e.g. _event, _item)
            varsIgnorePattern: "^_",
            argsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
            ignoreRestSiblings: true,
        }],

        curly: "off",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, {
    // `no-restricted-syntax` is one rule: a later config block for the same
    // files replaces an earlier one instead of adding to it. So each file group
    // below lists every restriction that applies to it.
    files: ["**/*.ts"],
    ignores: ["src/config/configService.ts", "src/git/gitSpawn.ts", "src/test/**"],
    rules: { "no-restricted-syntax": ["error", NO_RAW_CONFIG, NO_RAW_GIT] },
}, {
    // The one allowed caller of the raw settings API.
    files: ["src/config/configService.ts"],
    rules: { "no-restricted-syntax": ["error", NO_RAW_GIT] },
}, {
    // The one allowed git spawner.
    files: ["src/git/gitSpawn.ts"],
    rules: { "no-restricted-syntax": ["error", NO_RAW_CONFIG] },
}];