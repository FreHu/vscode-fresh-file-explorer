import * as assert from "assert";
import * as vscode from "vscode";

import { DeletionMarkers, DeletionDecoration } from "../heatmap/deletionMarkers";

/**
 * Registry semantics for the deleted-lines gutter markers. Decoration types
 * are live resources — every path that replaces or removes a marker must
 * dispose its type, or stale badges keep rendering in every editor.
 */
suite("deletion markers", () => {
  /** A DeletionDecoration whose type counts disposals instead of touching VS Code. */
  function fakeMarker(anchorLine0: number, lines: string[], disposed: { count: number }): DeletionDecoration {
    return {
      type: { dispose: () => { disposed.count++; } } as vscode.TextEditorDecorationType,
      options: { range: new vscode.Range(anchorLine0, 0, anchorLine0, 0) },
      lines,
    };
  }

  test("replaceFor disposes the previous set's types", () => {
    const markers = new DeletionMarkers();
    const oldDisposed = { count: 0 };
    markers.replaceFor("/f.ts", [fakeMarker(1, ["a"], oldDisposed), fakeMarker(5, ["b"], oldDisposed)]);

    markers.replaceFor("/f.ts", [fakeMarker(2, ["c"], { count: 0 })]);

    assert.strictEqual(oldDisposed.count, 2, "both old types must be disposed");
    assert.deepStrictEqual(markers.linesFor("/f.ts"), [3], "only the new marker remains (1-based)");
  });

  test("replaceFor with an empty set clears the file's markers", () => {
    const markers = new DeletionMarkers();
    const disposed = { count: 0 };
    markers.replaceFor("/f.ts", [fakeMarker(0, ["a"], disposed)]);

    markers.replaceFor("/f.ts", []);

    assert.strictEqual(disposed.count, 1);
    assert.deepStrictEqual(markers.linesFor("/f.ts"), []);
  });

  test("disposeFor disposes every type and forgets the file", () => {
    const markers = new DeletionMarkers();
    const disposed = { count: 0 };
    markers.replaceFor("/f.ts", [fakeMarker(0, ["a"], disposed), fakeMarker(3, ["b"], disposed)]);

    markers.disposeFor("/f.ts");

    assert.strictEqual(disposed.count, 2);
    assert.deepStrictEqual(markers.linesFor("/f.ts"), []);
    assert.strictEqual(markers.findAt("/f.ts", 1), undefined);
  });

  test("disposeFor leaves other files' markers alone", () => {
    const markers = new DeletionMarkers();
    const disposed = { count: 0 };
    markers.replaceFor("/a.ts", [fakeMarker(0, ["a"], disposed)]);
    markers.replaceFor("/b.ts", [fakeMarker(0, ["b"], disposed)]);

    markers.disposeFor("/a.ts");

    assert.strictEqual(disposed.count, 1);
    assert.deepStrictEqual(markers.linesFor("/b.ts"), [1]);
  });

  test("dismiss removes and disposes only the matching marker", () => {
    const markers = new DeletionMarkers();
    const disposed = { count: 0 };
    markers.replaceFor("/f.ts", [fakeMarker(1, ["a"], disposed), fakeMarker(5, ["b"], disposed)]);

    assert.strictEqual(markers.dismiss("/f.ts", 1), true);
    assert.strictEqual(disposed.count, 1);
    assert.deepStrictEqual(markers.linesFor("/f.ts"), [6]);

    assert.strictEqual(markers.dismiss("/f.ts", 99), false, "no marker at that anchor");
    assert.strictEqual(disposed.count, 1);
  });

  test("findAt looks up by 1-based line and returns the retained content", () => {
    const markers = new DeletionMarkers();
    markers.replaceFor("/f.ts", [fakeMarker(4, ["deleted one", "deleted two"], { count: 0 })]);

    const hit = markers.findAt("/f.ts", 5);
    assert.deepStrictEqual(hit?.lines, ["deleted one", "deleted two"]);
    assert.strictEqual(markers.findAt("/f.ts", 4), undefined, "line numbers are 1-based");
  });

  test("dispose disposes across all files", () => {
    const markers = new DeletionMarkers();
    const disposed = { count: 0 };
    markers.replaceFor("/a.ts", [fakeMarker(0, ["a"], disposed)]);
    markers.replaceFor("/b.ts", [fakeMarker(1, ["b"], disposed), fakeMarker(2, ["c"], disposed)]);

    markers.dispose();

    assert.strictEqual(disposed.count, 3);
    assert.deepStrictEqual(markers.linesFor("/a.ts"), []);
    assert.deepStrictEqual(markers.linesFor("/b.ts"), []);
  });

  test("build clamps anchors into the document and retains deleted content", () => {
    // Real decoration types — dispose them at the end.
    const built = DeletionMarkers.build(
      [
        { afterNewLine1: 3, count: 1, lines: ["mid"] },
        { afterNewLine1: 999, count: 2, lines: ["past", "eof"] }, // beyond the 10-line doc
      ],
      10,
    );
    try {
      assert.strictEqual(built.length, 2);
      assert.strictEqual(built[0].options.range.start.line, 2, "afterNewLine1=3 anchors at 0-based line 2");
      assert.ok(built[1].options.range.start.line < 10, "anchor beyond EOF is clamped into the document");
      assert.deepStrictEqual(built[1].lines, ["past", "eof"]);
    } finally {
      for (const d of built) { d.type.dispose(); }
    }
  });
});
