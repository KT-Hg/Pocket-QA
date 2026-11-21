// Image Diff's pixel comparison, shared/pixel-diff.js.
//
// Run: node --test tests/pixel-diff.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { diffPixels } from '../shared/pixel-diff.js';

/** A w × h RGBA image of one colour, with `spots` [[x, y, [r, g, b]]] painted on it. */
function image(w, h, rgb, spots = []) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([...rgb, 255], i * 4);
  for (const [x, y, c] of spots) d.set([...c, 255], (y * w + x) * 4);
  return d;
}
const at = (out, w, x, y) => [...out.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

test('a pixel differing more than the threshold is changed and painted magenta; the rest is A dimmed', () => {
  const a = image(4, 2, [100, 100, 100]);
  const b = image(4, 2, [100, 100, 100], [[1, 0, [200, 100, 100]], [2, 1, [105, 100, 100]]]);
  const r = diffPixels(a, b, 4, 2, { threshold: 10 });
  assert.equal(r.changed, 1);
  assert.equal(r.total, 8);
  assert.deepEqual(at(r.out, 4, 1, 0), [255, 0, 220, 255]);
  assert.deepEqual(at(r.out, 4, 2, 1), [40, 40, 40, 255]);
});

test('pixels in an ignore box are grey and counted neither as changed nor in the total', () => {
  const a = image(4, 4, [0, 0, 0]);
  const b = image(4, 4, [0, 0, 0], [[3, 0, [255, 255, 255]], [0, 3, [255, 255, 255]]]);
  const r = diffPixels(a, b, 4, 4, { threshold: 10, ignore: [{ x: 2, y: 0, w: 2, h: 2 }] });
  assert.equal(r.changed, 1);
  assert.equal(r.total, 12);
  assert.deepEqual(at(r.out, 4, 3, 0), [150, 150, 150, 255]);
  assert.deepEqual(at(r.out, 4, 0, 3), [255, 0, 220, 255]);
});

test('an empty or degenerate ignore box changes nothing', () => {
  const a = image(2, 2, [0, 0, 0]);
  const b = image(2, 2, [255, 255, 255]);
  const r = diffPixels(a, b, 2, 2, { ignore: [{ x: 0, y: 0, w: 0, h: 5 }, null] });
  assert.equal(r.changed, 4);
  assert.equal(r.total, 4);
});
