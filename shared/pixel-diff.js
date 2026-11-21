/**
 * pixel-diff.js — the pixel comparison behind Image Diff (bg/screenshot/diff.js).
 *
 * A pixel counts as changed when its RGB channels differ by more than `threshold`
 * on average; it is painted magenta, and an unchanged one is A dimmed to 40 %.
 * Pixels inside an `ignore` box (A's pixels: a clock, an ad) are painted grey
 * and left out of both counts. Pure.
 */

const IGNORED_GREY = 150;

/** Whether (x, y) is inside one of the boxes {x, y, w, h}. */
function inBox(boxes, x, y) {
  for (const b of boxes) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return true;
  return false;
}

/**
 * @param {Uint8ClampedArray} a  RGBA of image A, w × h
 * @param {Uint8ClampedArray} b  RGBA of image B, w × h
 * @returns {{ out: Uint8ClampedArray, changed: number, total: number }}
 */
export function diffPixels(a, b, w, h, { threshold = 10, ignore = [] } = {}) {
  const out = new Uint8ClampedArray(w * h * 4);
  const boxes = ignore.filter((r) => r && r.w > 0 && r.h > 0);
  let changed = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (boxes.length && inBox(boxes, x, y)) {
        out[i] = out[i + 1] = out[i + 2] = IGNORED_GREY; out[i + 3] = 255;
        continue;
      }
      total++;
      const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
      if (d > threshold) {
        out[i] = 255; out[i + 1] = 0; out[i + 2] = 220; out[i + 3] = 255;
        changed++;
      } else {
        out[i] = a[i] * 0.4; out[i + 1] = a[i + 1] * 0.4; out[i + 2] = a[i + 2] * 0.4; out[i + 3] = a[i + 3];
      }
    }
  }
  return { out, changed, total };
}
