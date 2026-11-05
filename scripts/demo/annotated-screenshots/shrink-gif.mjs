// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Shrinks an existing GIF: scales it down, keeps every Nth frame, and re-encodes it
// storing only changed pixels. For images that can't be regenerated from a scene.
// Usage: node shrink-gif.mjs <in.gif> <out.gif> [--width 1000] [--every 2]

import { readFileSync, writeFileSync } from "node:fs";
import omggif from "omggif";
import { encodeRgbaGif } from "./gif.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const targetWidth = option("--width", 1000);
const every = option("--every", 2);
const [input, output] = args;
if (!input || !output) {
  console.error("usage: node scripts/demo/shrinkGif.mjs <in.gif> <out.gif> [--width 1000] [--every 2]");
  process.exit(1);
}

const source = readFileSync(input);
const reader = new omggif.GifReader(source);
const { width, height } = reader;
const outWidth = Math.min(targetWidth, width);
const outHeight = Math.round(height * outWidth / width);

// Composite every frame onto a running canvas (frames may cover only part of it).
const canvas = new Uint8Array(width * height * 4);
const shown = [];
for (let i = 0; i < reader.numFrames(); i++) {
  const info = reader.frameInfo(i);
  const before = info.disposal === 3 ? canvas.slice() : undefined;
  reader.decodeAndBlitFrameRGBA(i, canvas);
  shown.push({ rgba: canvas.slice(), delayMs: info.delay * 10 });
  if (info.disposal === 2) { clearRect(canvas, width, info); }
  if (before) { canvas.set(before); }
}

// Keep every Nth frame, each holding for the frames it replaces.
const kept = [];
for (let i = 0; i < shown.length; i += every) {
  const group = shown.slice(i, i + every);
  kept.push({ rgba: group[0].rgba, holdMs: group.reduce((sum, f) => sum + f.delayMs, 0) });
}

const frames = [];
for (const f of kept) {
  const rgba = downscale(f.rgba, width, height, outWidth, outHeight);
  const last = frames[frames.length - 1];
  if (last && equal(last.rgba, rgba)) { last.holdMs += f.holdMs; continue; }
  frames.push({ rgba, holdMs: f.holdMs });
}

const out = encodeRgbaGif(frames, outWidth, outHeight);
writeFileSync(output, out);
console.log(`${width}x${height}, ${shown.length} frames, ${Math.round(source.length / 1024)} KB → ` +
  `${outWidth}x${outHeight}, ${frames.length} frames, ${Math.round(out.length / 1024)} KB`);

function clearRect(rgba, stride, { x, y, width: w, height: h }) {
  for (let row = y; row < y + h; row++) { rgba.fill(0, (row * stride + x) * 4, (row * stride + x + w) * 4); }
}

function equal(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
  return true;
}

/** Area-averaging downscale (each output pixel averages the source pixels it covers): keeps thin text legible. */
function downscale(src, w, h, w2, h2) {
  const horizontal = resampleAxis(src, w, h, w2, true);
  return resampleAxis(horizontal, w2, h, h2, false);
}

function resampleAxis(src, w, h, size, alongX) {
  const from = alongX ? w : h;
  const out = new Uint8Array((alongX ? size * h : w * size) * 4);
  const scale = from / size;
  const lines = alongX ? h : w;
  const acc = new Float64Array(4);
  for (let line = 0; line < lines; line++) {
    for (let d = 0; d < size; d++) {
      const start = d * scale;
      const end = start + scale;
      acc.fill(0);
      for (let s = Math.floor(start); s < Math.ceil(end); s++) {
        const weight = Math.min(end, s + 1) - Math.max(start, s);
        const i = (alongX ? line * w + s : s * w + line) * 4;
        for (let c = 0; c < 4; c++) { acc[c] += src[i + c] * weight; }
      }
      const o = (alongX ? line * size + d : d * w + line) * 4;
      for (let c = 0; c < 4; c++) { out[o + c] = Math.round(acc[c] / scale); }
    }
  }
  return out;
}
