import * as vscode from "vscode";

import { deletionBadgeSvg } from "./heatmapSvg";
import { clampDeletionLineIndex } from "./blameHeatmapCompute";

/** A dynamically-created decoration type + options pair for a single deletion marker. */
export interface DeletionDecoration {
  type: vscode.TextEditorDecorationType;
  options: vscode.DecorationOptions;
  /** The deleted line content, retained so gutter-menu actions can copy/restore without re-fetching. */
  lines: string[];
}

/** Wrap the deletion-badge SVG in a `data:image/svg+xml` gutter icon URI. */
function makeDeletionGutterIcon(count: number): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml,${deletionBadgeSvg(count)}`);
}

/**
 * Owns the branch-mode "deleted lines" gutter markers: one dynamically-created
 * decoration type per deletion (so the badge can show the specific count), the
 * per-file registry of live markers, and their disposal.
 *
 * Decoration types are resources — a type that isn't disposed keeps its badge
 * rendered in every editor. Keeping every live type in one registry makes
 * "deactivate ⇒ dispose" a single call instead of a rule each bail-out path
 * has to remember.
 */
export class DeletionMarkers implements vscode.Disposable {
  private readonly byFile = new Map<string, DeletionDecoration[]>();

  /**
   * Build markers for a file's deletion hunks. Each deletion gets its own
   * decoration type so the gutter badge can show the specific count (e.g. "36").
   * The user-facing actions live in the gutter right-click menu
   * (`editor/lineNumber/context`); no hover message is set because the
   * decoration's zero-width range never triggers one anyway.
   */
  static build(
    deletions: { afterNewLine1: number; count: number; lines: string[] }[],
    lineCount: number,
  ): DeletionDecoration[] {
    return deletions.map(({ afterNewLine1, count, lines }) => {
      const lineIndex = clampDeletionLineIndex(afterNewLine1, lineCount);
      return {
        type: vscode.window.createTextEditorDecorationType({
          gutterIconPath: makeDeletionGutterIcon(count),
          gutterIconSize: "contain",
        }),
        options: { range: new vscode.Range(lineIndex, 0, lineIndex, 0) },
        lines,
      };
    });
  }

  /** Install a file's markers, disposing any previous set for that file first. */
  replaceFor(fsPath: string, deletions: DeletionDecoration[]): void {
    this.disposeFor(fsPath);
    if (deletions.length > 0) {
      this.byFile.set(fsPath, deletions);
    }
  }

  /** Paint the file's markers into an editor (initial apply and cache-restore repaint). */
  applyTo(editor: vscode.TextEditor): void {
    for (const d of this.byFile.get(editor.document.uri.fsPath) ?? []) {
      editor.setDecorations(d.type, [d.options]);
    }
  }

  /**
   * Remove the markers from one editor instance without disposing the types
   * (other editors with the same fsPath keep theirs).
   */
  clearFromEditor(editor: vscode.TextEditor): void {
    for (const d of this.byFile.get(editor.document.uri.fsPath) ?? []) {
      editor.setDecorations(d.type, []);
    }
  }

  /**
   * Dispose all of a file's marker types, automatically removing their
   * decorations from every editor.
   */
  disposeFor(fsPath: string): void {
    for (const d of this.byFile.get(fsPath) ?? []) {
      d.type.dispose();
    }
    this.byFile.delete(fsPath);
  }

  /**
   * Remove the single marker anchored at `anchorLineIndex` (0-based) and
   * dispose its type. Returns true when a marker was removed.
   */
  dismiss(fsPath: string, anchorLineIndex: number): boolean {
    const deletions = this.byFile.get(fsPath);
    if (!deletions) { return false; }
    const idx = deletions.findIndex(d => d.options.range.start.line === anchorLineIndex);
    if (idx === -1) { return false; }
    // Disposing the type automatically removes its decoration from all editors.
    deletions[idx].type.dispose();
    deletions.splice(idx, 1);
    return true;
  }

  /** The marker at the given 1-based line, if any. */
  findAt(fsPath: string, lineNumber1Based: number): DeletionDecoration | undefined {
    const target0 = lineNumber1Based - 1;
    return this.byFile.get(fsPath)?.find(d => d.options.range.start.line === target0);
  }

  /** 1-based line numbers of the file's markers (drives the gutter-menu context key). */
  linesFor(fsPath: string): number[] {
    return (this.byFile.get(fsPath) ?? []).map(d => d.options.range.start.line + 1);
  }

  dispose(): void {
    for (const deletions of this.byFile.values()) {
      for (const d of deletions) { d.type.dispose(); }
    }
    this.byFile.clear();
  }
}
