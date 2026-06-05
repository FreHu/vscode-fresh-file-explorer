import typescriptEslint from "typescript-eslint";

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
}];