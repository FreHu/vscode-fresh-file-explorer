// Builds the shared per-bucket TextEditorDecorationType arrays for the blame
// heatmap (age1…age8 and the parallel added1…added8 palette). Extracted from
// BlameHeatmapController so the controller doesn't carry the decoration-type
// construction boilerplate.

import * as vscode from "vscode";

import { HEATMAP_BUCKET_COUNT } from "./heatmapUtils";
import { gutterBarSvg } from "./heatmapSvg";
import { ConfigService } from "../config/configService";
import { hexToRgba } from "../utils/colorUtils";

/** Wrap a pure SVG string in a `data:image/svg+xml` gutter icon URI. */
function makeGutterIconUri(hexColor: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml,${gutterBarSvg(hexColor)}`);
}

function buildBucketTypes(
  colors: string[],
  idPrefix: "age" | "added",
  opacity: number,
): vscode.TextEditorDecorationType[] {
  return Array.from({ length: HEATMAP_BUCKET_COUNT }, (_, i) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: makeGutterIconUri(colors[i]),
      gutterIconSize: "contain",
      backgroundColor: hexToRgba(colors[i], opacity),
      overviewRulerColor: new vscode.ThemeColor(`freshFileExplorer.heatmap.${idPrefix}${i + 1}`),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  );
}

/** Build both palettes (modified/age and pure-addition) from current config. */
export function buildDecorationTypes(): {
  decorationTypes: vscode.TextEditorDecorationType[];
  addedDecorationTypes: vscode.TextEditorDecorationType[];
} {
  const opacity = ConfigService.getBlameHeatmapBackgroundOpacity();
  return {
    decorationTypes: buildBucketTypes(ConfigService.getBlameHeatmapAgeColors(), "age", opacity),
    addedDecorationTypes: buildBucketTypes(ConfigService.getBlameHeatmapAddedColors(), "added", opacity),
  };
}
