/**
 * Shared horizontal pan/scroll controller for webview charts.
 * Manages a scrollbar thumb, track clicks, wheel panning, and thumb dragging.
 */
export class PanController {
  private _offset = Number.MAX_SAFE_INTEGER; // MAX = scroll to end (newest)
  private _dragStart: { x: number; offset: number } | null = null;

  constructor(
    private readonly scrollbar: HTMLElement,
    private readonly thumb: HTMLElement,
    private readonly wheelTarget: HTMLElement,
    private readonly onPan: () => void,
    private readonly getDataLength: () => number,
    private readonly getMaxTicks: () => number,
  ) {
    // Thumb drag
    this.thumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragStart = { x: e.clientX, offset: this._offset };
    });

    document.addEventListener("mousemove", (e) => {
      if (!this._dragStart) { return; }
      const trackW = this.scrollbar.clientWidth;
      const total = this.getDataLength();
      const maxTicks = this.getMaxTicks();
      const ratio = maxTicks / total;
      const thumbW = Math.max(20, Math.round(ratio * trackW));
      const maxThumbLeft = trackW - thumbW;
      const maxOff = total - maxTicks;
      if (maxOff <= 0 || maxThumbLeft <= 0) { return; }

      const dx = e.clientX - this._dragStart.x;
      this._offset = Math.round(this._dragStart.offset + (dx / maxThumbLeft) * maxOff);
      this.onPan();
    });

    document.addEventListener("mouseup", () => {
      this._dragStart = null;
    });

    // Track click (jump to position)
    this.scrollbar.addEventListener("mousedown", (e) => {
      if (e.target === this.thumb) { return; }
      const rect = this.scrollbar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const trackW = rect.width;
      const total = this.getDataLength();
      const maxOff = total - this.getMaxTicks();
      if (maxOff <= 0) { return; }

      this._offset = Math.round((clickX / trackW) * maxOff);
      this.onPan();
    });

    // Wheel panning (shift+wheel or trackpad horizontal swipe)
    this.wheelTarget.addEventListener("wheel", (e) => {
      const maxTicks = this.getMaxTicks();
      if (this.getDataLength() <= maxTicks) { return; }
      const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (delta === 0) { return; }
      e.preventDefault();
      const step = Math.max(1, Math.round(maxTicks * 0.05));
      this._offset += delta > 0 ? step : -step;
      this.onPan();
    }, { passive: false });
  }

  get offset(): number { return this._offset; }
  set offset(v: number) { this._offset = v; }

  /** Clamp offset and update scrollbar thumb position. Returns the clamped page start index. */
  update(totalDataLength: number): number {
    const maxTicks = this.getMaxTicks();
    if (totalDataLength <= maxTicks) {
      this.scrollbar.style.display = "none";
      return 0;
    }
    const maxOffset = Math.max(0, totalDataLength - maxTicks);
    this._offset = Math.max(0, Math.min(this._offset, maxOffset));

    this.scrollbar.style.display = "block";
    const trackW = this.scrollbar.clientWidth;
    const ratio = maxTicks / totalDataLength;
    const thumbW = Math.max(20, Math.round(ratio * trackW));
    const maxThumbLeft = trackW - thumbW;
    const thumbLeft = maxOffset > 0 ? Math.round((this._offset / maxOffset) * maxThumbLeft) : 0;
    this.thumb.style.width = thumbW + "px";
    this.thumb.style.left = thumbLeft + "px";

    return this._offset;
  }
}
