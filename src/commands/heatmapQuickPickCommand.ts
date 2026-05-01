import * as vscode from "vscode";
import { ConfigService } from "../config/configService";
import { BlameHeatmapController } from "../heatmap/blameHeatmapController";

type ActionId =
  | "age"
  | "branchSaved"
  | "branchPick"
  | "off"
  | "diff"
  | "clearBaseline"
  | "toggleAutoApply";
type ActionItem = vscode.QuickPickItem & { id: ActionId };
type SeparatorItem = vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator };
type HeatmapPickItem = ActionItem | SeparatorItem;

const sep = (label: string): SeparatorItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

export async function showBlameHeatmapPicker(controller: BlameHeatmapController): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  const { activeMode, savedBaseRef, autoApply } = controller.getPickerSnapshot(editor);

  const items: HeatmapPickItem[] = [];

  // ── Modes ──────────────────────────────────────────────────────────────────
  items.push(sep("Modes"));
  items.push({
    label: activeMode === "absolute" ? "$(check) Age" : "$(history) Age",
    description: "Colorize lines by commit age",
    id: "age",
  });

  if (savedBaseRef) {
    items.push({
      label: activeMode === "branch"
        ? `$(check) Branch / Tag — saved: ${savedBaseRef}`
        : `$(git-branch) Branch / Tag — saved: ${savedBaseRef}`,
      description: "Apply branch mode using the saved baseline",
      id: "branchSaved",
    });
    items.push({
      label: "$(git-branch) Pick branch / tag…",
      description: "Choose a different baseline",
      id: "branchPick",
    });
  } else {
    items.push({
      label: "$(git-branch) Pick branch / tag…",
      description: "Colorize lines changed since a branch or tag",
      id: "branchPick",
    });
  }

  if (activeMode) {
    items.push({
      label: "$(circle-slash) Turn off",
      description: `Clear ${activeMode === "absolute" ? "Age" : "Branch"} decorations on this file`,
      id: "off",
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  items.push(sep("Actions"));
  items.push({
    label: "$(diff) Diff vs baseline",
    description: savedBaseRef
      ? `Open a diff editor against ${savedBaseRef}`
      : "Open a diff editor (prompts for a baseline on first use)",
    id: "diff",
  });
  if (savedBaseRef) {
    items.push({
      label: `$(trash) Clear saved baseline (${savedBaseRef})`,
      description: "Forget the saved ref. Branch mode will prompt next time.",
      id: "clearBaseline",
    });
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  items.push(sep("Settings"));
  items.push({
    label: autoApply ? "$(eye) Auto-apply: on" : "$(eye-closed) Auto-apply: off",
    description: autoApply
      ? "Click to disable. Newly opened files won't auto-decorate."
      : "Click to enable. Newly opened files will reapply the last mode.",
    id: "toggleAutoApply",
  });

  const placeHolder =
    activeMode === "absolute" ? "Heatmap: Age active"
    : activeMode === "branch" && savedBaseRef ? `Heatmap: vs ${savedBaseRef}`
    : activeMode === "branch" ? "Heatmap: branch mode active"
    : "Heatmap: off";

  const picked = await vscode.window.showQuickPick(items, {
    title: "Blame Heatmap",
    placeHolder,
  });

  if (!picked || !("id" in picked)) { return; }

  switch (picked.id) {
    case "age":
      await controller.applyMode(editor, "absolute");
      break;
    case "branchSaved":
      await controller.applyMode(editor, "branch");
      break;
    case "branchPick":
      await controller.selectBranchMode(editor);
      break;
    case "off":
      controller.turnOff(editor);
      break;
    case "diff":
      await controller.openBaselineDiff(editor);
      break;
    case "clearBaseline":
      controller.clearSavedBaseRef(editor);
      break;
    case "toggleAutoApply":
      await ConfigService.setBlameHeatmapAutoApply(!autoApply);
      break;
  }
}
