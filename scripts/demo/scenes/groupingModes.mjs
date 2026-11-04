import { parkMouse, runCommand } from "../vscodeActions.mjs";

/** The grouping-mode quick pick → docs/img/grouping-modes.png */
export default {
  output: "grouping-modes.png",
  async capture(page) {
    await runCommand(page, "Set Grouping Mode");
    const picker = page.locator(".quick-input-widget");
    await picker.locator(".monaco-list-row", { hasText: "Author" }).waitFor();
    await parkMouse(page);
    return picker.screenshot();
  },
};
