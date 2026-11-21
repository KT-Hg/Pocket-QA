/**
 * screenshot/diff.js — pixel diff of two screenshots.
 */

import { uint8ToBase64 } from './base64.js';
import { diffPixels } from '../../shared/pixel-diff.js';

/* ── Image Diff ─────────────────────────────────────────────────────────────── */

/**
 * Pixel-diff two screenshots and return a highlighted diff image
 * (shared/pixel-diff.js paints it).
 *
 * Images of two sizes are compared over the area they share (`sharedOnly`, the
 * default): a page one line longer used to have its extra strip, and everything
 * the extra line pushed down, counted as changed. With `sharedOnly` off they are
 * compared over the larger size, the missing part counting as changed. The
 * caller gets both sizes back and says when they differ.
 *
 * @param {string} dataUrlA   - Base image (data URL).
 * @param {string} dataUrlB   - Comparison image (data URL).
 * @param {number} threshold  - Per-channel average diff that counts as "changed".
 * @param {{ignore?: {x:number,y:number,w:number,h:number}[], sharedOnly?: boolean}} [opts]
 *        ignore: boxes in A's pixels left out of the comparison
 * @returns {Promise<{ diffUrl: string, changed: number, total: number, pct: string,
 *          sizeA: {w:number,h:number}, sizeB: {w:number,h:number} }>}
 */
export async function compareScreenshots(dataUrlA, dataUrlB, threshold, { ignore = [], sharedOnly = true } = {}) {
  const toBitmap = async (url) => {
    const blob = await fetch(url).then(r => r.blob());
    return createImageBitmap(blob);
  };
  const [bmA, bmB] = await Promise.all([toBitmap(dataUrlA), toBitmap(dataUrlB)]);
  const pick = sharedOnly ? Math.min : Math.max;
  const w = pick(bmA.width,  bmB.width);
  const h = pick(bmA.height, bmB.height);

  const read = (bm) => {
    const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
    x.drawImage(bm, 0, 0); return x.getImageData(0, 0, w, h);
  };
  const [dA, dB] = [read(bmA), read(bmB)];
  const { out, changed, total } = diffPixels(dA.data, dB.data, w, h, { threshold, ignore });

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const ab = await blob.arrayBuffer();
  const diffUrl = 'data:image/png;base64,' + uint8ToBase64(new Uint8Array(ab));
  return {
    diffUrl, changed, total, pct: total ? ((changed / total) * 100).toFixed(2) : '0.00',
    sizeA: { w: bmA.width, h: bmA.height }, sizeB: { w: bmB.width, h: bmB.height },
  };
}
