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
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

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

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];