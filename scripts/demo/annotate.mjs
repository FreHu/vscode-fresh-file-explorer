// Scenes annotate through this file: the copied library with VS Code's editor targets
// (editorLine, editorLines, editorGutter) added. The library itself lives in
// annotated-screenshots/, copied from https://github.com/FreHu/annotated-screenshots.

import { annotate as annotateWith, clearAnnotations } from "./annotated-screenshots/annotate.mjs";
import { resolveEditorTarget } from "./annotated-screenshots/vscode-targets.mjs";

export function annotate(page, annotations) {
  return annotateWith(page, annotations, { resolve: resolveEditorTarget });
}

export { clearAnnotations };
