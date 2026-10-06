/**
 * screenshot/diff.js — pixel diff of two screenshots.
 */

import { uint8ToBase64 } from './base64.js';

/* ── Image Diff ─────────────────────────────────────────────────────────────── */

/**
 * Pixel-diff two screenshots and return a highlighted diff image.
 *
 * Pixels whose per-channel average deviation exceeds `threshold` (0–255) are
 * painted magenta; unchanged pixels are dimmed to 40% to make differences
 * stand out visually. Both bitmaps are normalised to the same (max) dimensions
 * so images from different viewport sizes can still be compared.
 *
 * @param {string} dataUrlA   - Base image (data URL).
 * @param {string} dataUrlB   - Comparison image (data URL).
 * @param {number} threshold  - Per-channel average diff that counts as "changed".
 * @returns {{ diffUrl: string, changed: number, total: number, pct: string }}
 */
export async function compareScreenshots(dataUrlA, dataUrlB, threshold) {
  const toBitmap = async (url) => {
    const blob = await fetch(url).then(r => r.blob());
    return createImageBitmap(blob);
  };
  const [bmA, bmB] = await Promise.all([toBitmap(dataUrlA), toBitmap(dataUrlB)]);
  const w = Math.max(bmA.width,  bmB.width);
  const h = Math.max(bmA.height, bmB.height);

  const read = (bm) => {
    const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
    x.drawImage(bm, 0, 0); return x.getImageData(0, 0, w, h);
  };
  const [dA, dB] = [read(bmA), read(bmB)];

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  let changed = 0;
  for (let i = 0; i < dA.data.length; i += 4) {
    const diff = (Math.abs(dA.data[i]-dB.data[i]) + Math.abs(dA.data[i+1]-dB.data[i+1]) + Math.abs(dA.data[i+2]-dB.data[i+2])) / 3;
    if (diff > threshold) {
      img.data[i]=255; img.data[i+1]=0; img.data[i+2]=220; img.data[i+3]=255;
      changed++;
    } else {
      img.data[i]=dA.data[i]*0.4; img.data[i+1]=dA.data[i+1]*0.4;
      img.data[i+2]=dA.data[i+2]*0.4; img.data[i+3]=dA.data[i+3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const ab = await blob.arrayBuffer();
  const diffUrl = 'data:image/png;base64,' + uint8ToBase64(new Uint8Array(ab));
  return { diffUrl, changed, total: w * h, pct: ((changed / (w * h)) * 100).toFixed(2) };
}
