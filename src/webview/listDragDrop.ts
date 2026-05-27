/**
 * Reusable HTML5 drag-and-drop wiring for list-shaped UIs in webviews.
 *
 * Decouples the drag mechanics (event handling, drop-target math, visual
 * indicator class management) from the list itself — works with any
 * container of rows (table tbody, ul, div). Consumers supply selectors,
 * an id extractor, and a callback that receives `(itemId, targetIndex)`
 * after a successful drop. Styling is left to the consumer: the library
 * just toggles CSS classes (default names: `list-dnd-dragging`,
 * `list-dnd-drop-above`, `list-dnd-drop-below`).
 *
 * Design choices:
 *  - Drag arms only when the user mousedowns on a designated handle, so
 *    interacting with inputs / buttons in the row doesn't start a drag.
 *  - The drop math returns `targetIndex` in `Array.splice` terms — same
 *    semantics as `arr.splice(oldIdx, 1); arr.splice(targetIndex, 0, item)`.
 *    Off-by-one handling lives here so consumers don't need it.
 *  - `refresh()` is required after every re-render. The container's rows
 *    are not observed — call it from your render loop.
 */
export interface ListDragDropOptions {
  /** Selector matching the draggable rows inside the container. */
  rowSelector: string;
  /**
   * Selector for the drag handle inside a row. Only `mousedown` on this
   * element arms the row for dragging. Browsers won't start a drag until
   * `draggable` is true at the moment the gesture begins.
   */
  handleSelector: string;
  /**
   * Extract a stable item id from a row element. Return `null` for rows
   * that should not participate in drag-and-drop (e.g. draft rows with no
   * persisted id yet).
   */
  getItemId: (row: HTMLElement) => string | null;
  /**
   * Called after a successful drop. `targetIndex` is the destination index
   * **in the final array** — matches the canonical splice idiom:
   *   `arr.splice(oldIdx, 1); arr.splice(targetIndex, 0, item)`
   */
  onMove: (itemId: string, targetIndex: number) => void;
  /** Class names applied during drag. Override to fit existing CSS. */
  classNames?: {
    dragging?: string;
    dropAbove?: string;
    dropBelow?: string;
  };
}

export interface ListDragDropHandle {
  /** Re-scan rows after a re-render. Idempotent — re-attaches listeners. */
  refresh: () => void;
  /** Remove every listener and indicator the library added. */
  dispose: () => void;
}

export function enableListDragDrop(
  container: HTMLElement,
  options: ListDragDropOptions,
): ListDragDropHandle {
  const cls = {
    dragging: options.classNames?.dragging ?? "list-dnd-dragging",
    dropAbove: options.classNames?.dropAbove ?? "list-dnd-drop-above",
    dropBelow: options.classNames?.dropBelow ?? "list-dnd-drop-below",
  };

  // Shared state across rows during one drag gesture.
  let draggedId: string | null = null;
  let draggedFromIndex = -1;

  const teardown: Array<() => void> = [];

  function clearIndicators(): void {
    for (const el of container.querySelectorAll<HTMLElement>(`.${cls.dropAbove}, .${cls.dropBelow}`)) {
      el.classList.remove(cls.dropAbove, cls.dropBelow);
    }
  }

  function detach(): void {
    while (teardown.length) {
      const fn = teardown.pop();
      try { fn?.(); } catch { /* swallow — best-effort cleanup */ }
    }
    clearIndicators();
  }

  function attach(): void {
    detach();

    const rows = Array.from(container.querySelectorAll<HTMLElement>(options.rowSelector));
    rows.forEach((row, idx) => {
      const id = options.getItemId(row);
      if (id === null) { return; }

      // Arm the row only while the user is holding the handle. Without this,
      // dragging from any cell (including inputs and buttons) would steal the
      // gesture. We reset on global mouseup so a click-without-drag still
      // disarms.
      const handle = row.querySelector<HTMLElement>(options.handleSelector);
      const onHandleDown = (): void => { row.draggable = true; };
      const onGlobalUp = (): void => {
        // Defer one tick so the browser sees `draggable=true` when dragstart
        // fires (which happens after mousedown but before this mouseup).
        setTimeout(() => { row.draggable = false; }, 0);
      };
      if (handle) {
        handle.addEventListener("mousedown", onHandleDown);
        document.addEventListener("mouseup", onGlobalUp);
        teardown.push(() => {
          handle.removeEventListener("mousedown", onHandleDown);
          document.removeEventListener("mouseup", onGlobalUp);
        });
      }

      const onDragStart = (e: DragEvent): void => {
        draggedId = id;
        draggedFromIndex = idx;
        e.dataTransfer?.setData("text/plain", id);
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; }
        row.classList.add(cls.dragging);
      };

      const onDragEnter = (e: DragEvent): void => {
        if (!draggedId || draggedId === id) { return; }
        // preventDefault on dragenter is required on some browsers to allow
        // a later drop. Cheap belt-and-suspenders alongside dragover.
        e.preventDefault();
      };

      const onDragOver = (e: DragEvent): void => {
        if (!draggedId || draggedId === id) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = "move"; }
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        row.classList.toggle(cls.dropAbove, above);
        row.classList.toggle(cls.dropBelow, !above);
        // Strip indicators from any other row that still has one.
        for (const other of rows) {
          if (other !== row) {
            other.classList.remove(cls.dropAbove, cls.dropBelow);
          }
        }
      };

      const onDragLeave = (e: DragEvent): void => {
        // dragleave fires when the cursor enters a child element of the row
        // too. Only clear the indicator if the cursor truly left the row.
        const next = e.relatedTarget as Node | null;
        if (next && row.contains(next)) { return; }
        row.classList.remove(cls.dropAbove, cls.dropBelow);
      };

      const onDrop = (e: DragEvent): void => {
        e.preventDefault();
        if (!draggedId || draggedId === id) { return; }
        const above = row.classList.contains(cls.dropAbove);
        // Translate "drop above/below row K from source J" into a splice index.
        // Forward move (J < K): removal shifts every subsequent index down by 1.
        // Backward move (J > K): no shift, dropping above means landing at K.
        const targetIndex = draggedFromIndex < idx
          ? (above ? idx - 1 : idx)
          : (above ? idx : idx + 1);
        const movedId = draggedId;
        row.classList.remove(cls.dropAbove, cls.dropBelow);
        options.onMove(movedId, targetIndex);
      };

      const onDragEnd = (): void => {
        row.classList.remove(cls.dragging);
        row.draggable = false;
        draggedId = null;
        draggedFromIndex = -1;
        clearIndicators();
      };

      row.addEventListener("dragstart", onDragStart);
      row.addEventListener("dragenter", onDragEnter);
      row.addEventListener("dragover", onDragOver);
      row.addEventListener("dragleave", onDragLeave);
      row.addEventListener("drop", onDrop);
      row.addEventListener("dragend", onDragEnd);
      teardown.push(() => {
        row.removeEventListener("dragstart", onDragStart);
        row.removeEventListener("dragenter", onDragEnter);
        row.removeEventListener("dragover", onDragOver);
        row.removeEventListener("dragleave", onDragLeave);
        row.removeEventListener("drop", onDrop);
        row.removeEventListener("dragend", onDragEnd);
      });
    });
  }

  attach();
  return {
    refresh: attach,
    dispose: detach,
  };
}
