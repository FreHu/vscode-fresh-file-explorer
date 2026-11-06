// CSS declaration blocks for the webview panels' form controls, themed from
// VS Code's colour variables. Interpolate inside a rule; sizing (padding,
// width) and disabled states stay with each panel.

const decls = (...lines: string[]): string => lines.join("\n      ");

/** A filled button in the theme's primary button colours. */
export const PRIMARY_BUTTON = decls(
  "background: var(--vscode-button-background);",
  "color: var(--vscode-button-foreground);",
  "border: none;",
  "cursor: pointer;",
  "font-family: var(--vscode-font-family);",
  "font-size: var(--vscode-font-size);",
  "font-weight: 600;",
);

/** Text input or select in the theme's dropdown colours. */
export const DROPDOWN_CONTROL = decls(
  "background: var(--vscode-dropdown-background);",
  "color: var(--vscode-dropdown-foreground);",
  "border: 1px solid var(--vscode-dropdown-border);",
  "font-family: var(--vscode-font-family);",
  "font-size: var(--vscode-font-size);",
);

/** Text input or select in the theme's input-box colours. */
export const INPUT_CONTROL = decls(
  "background: var(--vscode-input-background);",
  "color: var(--vscode-input-foreground);",
  "border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));",
  "font-family: var(--vscode-font-family);",
  "font-size: var(--vscode-font-size);",
);

/** Keyboard-focus ring drawn inside the control's border. */
export const FOCUS_OUTLINE = decls(
  "outline: 1px solid var(--vscode-focusBorder);",
  "outline-offset: -1px;",
);
