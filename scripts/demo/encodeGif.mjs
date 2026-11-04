// Joins still PNGs into an animated GIF. GIF because it is the one animated
// format GitHub, the VS Code Marketplace and Open VSX all play.

import gifenc from "gifenc"; // CommonJS: no named exports under Node's ESM loader

const { applyPalette, GIFEncoder, quantize } = gifenc;

/**
 * @param {import("playwright-core").Page} page any open page: PNGs are decoded with its canvas, so no image library is needed
 * @param {Array<{ png: Buffer, holdMs: number, fadeMs?: number }>} frames `fadeMs` crossfades into the next frame (default: hard cut)
 */
export async function encodeGif(page, frames) {
  const decoded = [];
  for (const frame of frames) {
    decoded.push({ ...frame, ...(await decodePng(page, frame.png)) });
  }
  const { width, height } = decoded[0];
  if (decoded.some(f => f.width !== width || f.height !== height)) {
    throw new Error("all frames must have the same size");
  }

  const gif = GIFEncoder();
  const write = (rgba, delay) => {
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay });
  };
  for (let i = 0; i < decoded.length; i++) {
    const frame = decoded[i];
    write(frame.rgba, frame.holdMs);
    const next = decoded[(i + 1) % decoded.length];
    const steps = frame.fadeMs ? Math.max(2, Math.round(frame.fadeMs / 40)) : 0;
    for (let s = 1; s < steps; s++) {
      write(blend(frame.rgba, next.rgba, s / steps), 40);
    }
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function blend(a, b, t) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) { out[i] = a[i] + (b[i] - a[i]) * t; }
  return out;
}

async function decodePng(page, png) {
  const { width, height, base64 } = await page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const bytes = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
    // Chunked: String.fromCharCode(...bytes) overflows the call stack on large frames.
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) { binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
    return { width: canvas.width, height: canvas.height, base64: btoa(binary) };
  }, `data:image/png;base64,${png.toString("base64")}`);
  return { width, height, rgba: new Uint8Array(Buffer.from(base64, "base64")) };
}
