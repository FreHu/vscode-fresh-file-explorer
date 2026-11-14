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

// The chevron is two 1.5px gradient strokes in currentColor, so it follows the theme
// without an image or a wrapper element.
const CHEVRON_STROKE = "transparent calc(50% - 0.75px), currentColor calc(50% - 0.75px), currentColor calc(50% + 0.75px), transparent calc(50% + 0.75px)";

/** A `<select>` shaped like the Settings editor's dropdown: 26px, rounded, chevron on the right. */
export const SELECT_CONTROL = decls(
  "appearance: none;",
  "box-sizing: border-box;",
  "height: 26px;",
  "padding: 2px 26px 2px 8px;",
  "border-radius: 4px;",
  "cursor: pointer;",
  "background-color: var(--vscode-dropdown-background);",
  `background-image: linear-gradient(45deg, ${CHEVRON_STROKE}), linear-gradient(-45deg, ${CHEVRON_STROKE});`,
  "background-size: 6px 6px;",
  "background-position: right 15px center, right 9px center;",
  "background-repeat: no-repeat;",
  "color: var(--vscode-dropdown-foreground);",
  "border: 1px solid var(--vscode-dropdown-border);",
  "font-family: var(--vscode-font-family);",
  "font-size: var(--vscode-font-size);",
);

/** A text or number input shaped like the Settings editor's input box: 26px, rounded. */
export const INPUT_CONTROL = decls(
  "box-sizing: border-box;",
  "height: 26px;",
  "padding: 4px 6px;",
  "border-radius: 4px;",
  "background: var(--vscode-input-background);",
  "color: var(--vscode-input-foreground);",
  "border: 1px solid var(--vscode-input-border, transparent);",
  "font-family: var(--vscode-font-family);",
  "font-size: var(--vscode-font-size);",
);

/** Keyboard-focus ring drawn inside the control's border. */
export const FOCUS_OUTLINE = decls(
  "outline: 1px solid var(--vscode-focusBorder);",
  "outline-offset: -1px;",
);
