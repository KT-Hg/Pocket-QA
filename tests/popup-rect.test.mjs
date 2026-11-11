// Where the popup is, in the page's CSS px (_popupRectOnPage in content.js): from the
// popup's place on the screen, at page zoom 100% and 125% (the numbers measured in Edge),
// on a scaled screen, in a maximized window; the old corner guess without a place.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* <popup-rect> */'), src.indexOf('/* </popup-rect> */'));
assert.ok(block.length > 100, 'popup-rect block not found in content.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${block}; this._popupRectOnPage = _popupRectOnPage;`, ctx);
const { _popupRectOnPage } = ctx;

const round = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]));
// A 1001 px window at (100, 50); 100 px of tabs and toolbar above the page.
const page = (zoom, extra = {}) => ({
  screenX: 100, screenY: 50, outerWidth: 1001, outerHeight: 800,
  innerWidth: 1001 / zoom, innerHeight: 700 / zoom, devicePixelRatio: zoom, ...extra,
});

test('at 100%: the popup under the icon, not at the window\'s right edge', () => {
  const popup = { screenX: 100 + 242, screenY: 150, width: 479, height: 600, dpr: 1 };
  assert.deepEqual(round(_popupRectOnPage(popup, page(1))), { left: 242, top: 0, width: 479, height: 600 });
});

test('at 125% the popup is smaller and further left in page px (383 × 480 at 193, as measured)', () => {
  const popup = { screenX: 100 + 193 * 1.25, screenY: 150, width: 479, height: 600, dpr: 1 };
  assert.deepEqual(round(_popupRectOnPage(popup, page(1.25))), { left: 193, top: 0, width: 383, height: 480 });
});

test('a screen scaled 150% (both at that ratio) is no zoom', () => {
  const popup = { screenX: 100 + 242, screenY: 150, width: 479, height: 600, dpr: 1.5 };
  const p = { ...page(1), devicePixelRatio: 1.5 };
  assert.deepEqual(round(_popupRectOnPage(popup, p)), { left: 242, top: 0, width: 479, height: 600 });
});

test('a maximized window: its border off the screen on both sides', () => {
  const p = { screenX: -8, screenY: -8, outerWidth: 1936, outerHeight: 1056, innerWidth: 1920, innerHeight: 950, devicePixelRatio: 1 };
  // Content left = -8 + 8 = 0; content top = -8 + (1056 - 950) - 8 = 90.
  const popup = { screenX: 1100, screenY: 90, width: 480, height: 600, dpr: 1 };
  assert.deepEqual(round(_popupRectOnPage(popup, p)), { left: 1100, top: 0, width: 480, height: 600 });
});

test('a popup that sends no place: its size at the top right, 8 px in', () => {
  assert.deepEqual(round(_popupRectOnPage({ width: 480, height: 600 }, page(1))), { left: 1001 - 480 - 8, top: 0, width: 480, height: 600 });
});
