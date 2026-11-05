// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Joins stills (PNG or JPEG) into an animated GIF. GIF because it is the one animated
// format GitHub, the VS Code Marketplace and Open VSX all play.

import gifenc from "gifenc"; // CommonJS: no named exports under Node's ESM loader

const { applyPalette, GIFEncoder, quantize } = gifenc;

/**
 * @param {import("playwright-core").Page} page a page from openCanvasPage (annotate.mjs): stills are decoded with its canvas, so no image library is needed
 * @param {Array<{ png: Buffer, holdMs: number, fadeMs?: number }>} frames `png`: PNG or JPEG bytes. `fadeMs` crossfades into the next frame (default: hard cut)
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
  return encodeRgbaGif(decoded, width, height);
}

/**
 * The encoder proper, on raw pixels: no page needed.
 * @param {Array<{ rgba: Uint8Array, holdMs: number, fadeMs?: number }>} decoded
 */
export function encodeRgbaGif(decoded, width, height) {
  const gif = GIFEncoder();
  let previous;
  const write = (rgba, delay) => {
    if (!previous) {
      const palette = quantize(rgba, 256);
      gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay });
      previous = rgba;
      return;
    }
    // Store only what changed since the previous frame; the rest is transparent and
    // the previous frame shows through (dispose 1 = keep it). Compared against the
    // previous *source* frame: against its quantized version, palette rounding would
    // mark every pixel of a held frame as changed.
    const pixels = width * height;
    const changed = new Uint8Array(pixels);
    let changedCount = 0;
    for (let p = 0; p < pixels; p++) {
      const i = p * 4;
      if (rgba[i] !== previous[i] || rgba[i + 1] !== previous[i + 1] || rgba[i + 2] !== previous[i + 2]) {
        changed[p] = 1;
        changedCount++;
      }
    }
    // The palette is built from the changed pixels only: they're all this frame shows.
    const sample = new Uint8Array(Math.max(1, changedCount) * 4);
    for (let p = 0, s = 0; p < pixels; p++) {
      if (changed[p]) { sample.set(rgba.subarray(p * 4, p * 4 + 4), s); s += 4; }
    }
    const palette = quantize(sample, 255);
    const transparentIndex = palette.length;
    palette.push([0, 0, 0]);
    const index = applyPalette(rgba, palette.slice(0, transparentIndex));
    for (let p = 0; p < pixels; p++) {
      if (!changed[p]) { index[p] = transparentIndex; }
    }
    gif.writeFrame(index, width, height, { palette, delay, transparent: true, transparentIndex, dispose: 1 });
    previous = rgba;
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

/**
 * Decodes the GIF with the page's ImageDecoder and compares each held frame with its
 * source still. Catches a broken transparency/dispose setup, which no viewer that
 * shows only the first frame would reveal.
 * @returns {Promise<{ frameCount: number, keyFrameErrors: number[], frames: Buffer[] }>} mean abs channel error per held frame (0–255), and every decoded frame as PNG
 */
export async function verifyGif(page, gifBytes, sourceFrames) {
  const sources = [];
  for (const f of sourceFrames) { sources.push((await decodePng(page, f.png)).rgba); }
  const fadeSteps = sourceFrames.map(f => (f.fadeMs ? Math.max(2, Math.round(f.fadeMs / 40)) - 1 : 0));
  if (!(await page.evaluate(() => typeof ImageDecoder !== "undefined"))) {
    throw new Error("verifyGif needs ImageDecoder, which exists only in a secure context: use a page from openCanvasPage (annotate.mjs)");
  }
  const { frameCount, decoded } = await page.evaluate(async b64 => {
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const decoder = new ImageDecoder({ data, type: "image/gif" });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack.frameCount;
    const out = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      canvas.getContext("2d").drawImage(image, 0, 0);
      image.close();
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let j = 0; j < bytes.length; j += 0x8000) { binary += String.fromCharCode(...bytes.subarray(j, j + 0x8000)); }
      out.push(btoa(binary));
    }
    return { frameCount: count, decoded: out };
  }, gifBytes.toString("base64"));
  const frames = decoded.map(b => Buffer.from(b, "base64"));
  const keyFrameErrors = [];
  let gifIndex = 0;
  for (let k = 0; k < sources.length; k++) {
    const { rgba } = await decodePng(page, frames[gifIndex]);
    let sum = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      sum += Math.abs(rgba[i] - sources[k][i]) + Math.abs(rgba[i + 1] - sources[k][i + 1]) + Math.abs(rgba[i + 2] - sources[k][i + 2]);
    }
    keyFrameErrors.push(Number((sum / (rgba.length / 4 * 3)).toFixed(2)));
    gifIndex += 1 + fadeSteps[k];
  }
  return { frameCount, keyFrameErrors, frames };
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
  }, `data:${png[0] === 0xff && png[1] === 0xd8 ? "image/jpeg" : "image/png"};base64,${png.toString("base64")}`);
  return { width, height, rgba: new Uint8Array(Buffer.from(base64, "base64")) };
}
