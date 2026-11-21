/**
 * tools/e2e/capture.mjs — e2e suite "capture". Run: node tools/e2e.mjs --suite capture
 *
 * What follows a capture the user takes: the clipboard, Recent captures, Image Diff.
 * Headless Edge has a clipboard of its own, so these never touch the real one.
 *
 *   capture-copy  a Visible and a Full capture land on the clipboard as PNGs of their own
 *                 size (the page copies them: no popup is open), and in Recent captures,
 *                 the Full one leaving the page scrolled where it was,
 *                 newest first; a result the popup copies (copyBy) reaches the clipboard too
 *   recent        the Capture tab lists them; 📋 Copy from the strip puts that capture on
 *                 the clipboard; 🗑 Remove drops one
 *   image-diff    Compare with… on two Recent captures of two sizes opens Image Diff on
 *                 them: it says the sizes differ and compares the shared part; ↔ Drag moves
 *                 its line with →; a box left out lowers the count and is remembered for
 *                 that pair of sizes
 *   image-editor  ① places numbered circles and Undo takes the last one back, number and
 *                 all; ▮ Redact fills a box solid black; ◎ Spotlight dims what is outside
 *                 its box; saving copies the edited picture and keeps it in Recent
 */

import { sleep } from '../lib/cdp-browser.mjs';
import { POPUP_SETTLE_MS, SETTLE_MS, check, openPopup } from './harness.mjs';

const RECENT = `import('/shared/recent-captures.js')`;

/** The web page may read and write the clipboard, and counts as focused. */
async function clipboardReady(ctx) {
  await ctx.browser.send('Browser.grantPermissions', { origin: ctx.base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await ctx.web.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ctx.web.bringToFront();
  await sleep(SETTLE_MS);
}

/** The picture on the clipboard, as "image/png 1000x700", read on the web page. */
const clipboardImage = (ctx) => ctx.web.evaluate(`(async () => {
  const [item] = await navigator.clipboard.read();
  const bmp = await createImageBitmap(await item.getType('image/png'));
  return 'image/png ' + bmp.width + 'x' + bmp.height;
})().catch((e) => 'none: ' + e.message)`);

const recentList = (ctx) => ctx.ext.evaluate(`${RECENT}.then((m) => m.listRecent()).then((l) => l.map((s) => ({ id: s.id, kind: s.kind, w: s.w, h: s.h })))`);
const clearAll = (ctx) => ctx.ext.evaluate(`${RECENT}.then((m) => m.clearRecent()).then(() => chrome.storage.local.remove('diffIgnore_v1'))`);
const capture = (ctx, type) => ctx.ext.evaluate(`new Promise((res) => chrome.runtime.sendMessage({ type: '${type}', tabId: ${ctx.webTabId} }, (r) => res(r ?? null)))`, 30_000);

/** Two captures in Recent: a Page and a Full one, taller (the test page grows for it). */
async function twoCaptures(ctx) {
  await clearAll(ctx);
  await clipboardReady(ctx);
  await ctx.web.evaluate(`document.body.style.minHeight = '1600px'`);
  const page = await capture(ctx, 'TAKE_SCREENSHOT');
  const clipPage = await clipboardImage(ctx);
  await ctx.web.evaluate(`window.scrollTo(0, 400)`);
  const full = await capture(ctx, 'TAKE_SCREENSHOT_FULL');
  const clipFull = await clipboardImage(ctx);
  const scrollAfter = await ctx.web.evaluate(`scrollY`);
  await ctx.web.evaluate(`document.body.style.minHeight = ''; window.scrollTo(0, 0)`);
  return { page, full, clipPage, clipFull, scrollAfter, recent: await recentList(ctx) };
}

export async function checkCaptureCopy(ctx) {
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  const r = await twoCaptures(ctx);
  const [full, page] = r.recent;
  check(r.page?.copied && page && r.clipPage === `image/png ${page.w}x${page.h}`, 'a Visible capture is saved and copied by the page, at its own size', { page: r.page, clip: r.clipPage, recent: r.recent });
  check(r.full?.copied && full && r.clipFull === `image/png ${full.w}x${full.h}` && full.h >= 1600,
    'a Full capture is copied whole', { full: r.full, clip: r.clipFull, recent: r.recent });
  check(r.scrollAfter === 400, 'a Full capture leaves the page scrolled where it was', r.scrollAfter);
  check(r.recent.length === 2 && full.kind === 'Full' && page.kind === 'Page' && r.full.recentId === full.id,
    'both are in Recent captures, newest first', r.recent);
  // A result the popup copies: the open popup reads the capture from Recent.
  const popup = await openPopup(ctx);
  try {
    await popup.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ctx.send({ type: 'SCREENSHOT_RESULT', result: { success: true, filename: 'p.png', recentId: page.id, copyBy: 'popup' } });
    await sleep(POPUP_SETTLE_MS);
    const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
    check(/copied to clipboard/.test(toast) && (await clipboardImage(ctx)) === `image/png ${page.w}x${page.h}`,
      'with the popup open, the popup copies the capture from Recent', { toast });
  } finally {
    await popup.close();
  }
}

/** The popup on its Capture tab, focused so it may write the clipboard. */
async function captureTab(ctx) {
  const popup = await openPopup(ctx);
  await popup.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabCapture"]').click()`);
  await sleep(POPUP_SETTLE_MS);
  return popup;
}

const menuItem = (popup, text) => popup.evaluate(`[...document.querySelectorAll('.recent-menu button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`);
const shot = (popup, i) => popup.evaluate(`document.querySelectorAll('#recentGrid .recent-shot')[${i}].click()`);

export async function checkRecent(ctx) {
  const { recent } = await twoCaptures(ctx);
  await ctx.web.evaluate(`navigator.clipboard.writeText('other')`);
  const popup = await captureTab(ctx);
  try {
    const strip = await popup.evaluate(`({ shown: !document.getElementById('recentCaptures').hidden,
      captions: [...document.querySelectorAll('#recentGrid .recent-shot span')].map((s) => s.textContent.split(' · ')[0]),
      stats: document.getElementById('recentStats').textContent })`);
    check(strip.shown && strip.captions.join() === 'Full,Page' && /^2 · /.test(strip.stats), 'the Capture tab lists the captures, newest first', strip);
    await shot(popup, 1);
    await sleep(SETTLE_MS);
    await menuItem(popup, 'Copy');
    await sleep(POPUP_SETTLE_MS);
    check((await clipboardImage(ctx)) === `image/png ${recent[1].w}x${recent[1].h}`, '📋 Copy puts that capture on the clipboard', await clipboardImage(ctx));
    await shot(popup, 0);
    await sleep(SETTLE_MS);
    await menuItem(popup, 'Remove');
    await sleep(POPUP_SETTLE_MS);
    const left = { list: await recentList(ctx), grid: await popup.evaluate(`document.querySelectorAll('#recentGrid .recent-shot').length`) };
    check(left.list.length === 1 && left.list[0].kind === 'Page' && left.grid === 1, '🗑 Remove drops it from Recent and the strip', left);
  } finally {
    await popup.close();
  }
}

export async function checkImageDiff(ctx) {
  await twoCaptures(ctx);
  const popup = await captureTab(ctx);
  const stats = () => popup.evaluate(`document.getElementById('diffStats').textContent`);
  const compare = async () => {
    await shot(popup, 0);
    await sleep(SETTLE_MS);
    await menuItem(popup, 'Compare with');
    await sleep(SETTLE_MS);
    await shot(popup, 1);
    await sleep(POPUP_SETTLE_MS * 2);
  };
  try {
    await compare();
    const opened = await popup.evaluate(`({ open: document.getElementById('diffModal').classList.contains('show'),
      names: document.getElementById('diffNameA').textContent + ' | ' + document.getElementById('diffNameB').textContent,
      warn: document.getElementById('diffSizeWarn').hidden ? '' : document.getElementById('diffSizeWarn').textContent })`);
    check(opened.open && /^Full/.test(opened.names) && /Sizes differ.*only the shared \d+×\d+ is compared/.test(opened.warn),
      'Compare with… opens Image Diff on the two captures, and says their sizes differ', opened);
    const before = await stats();

    await popup.evaluate(`document.querySelector('#diffViews [data-view="drag"]').click()`);
    await popup.evaluate(`document.getElementById('diffStage').focus()`);
    await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const line = await popup.evaluate(`document.querySelector('#diffStage .diff-line')?.style.left`);
    check(line === '55%', '↔ Drag: → moves the line', line);

    // A box over the top half of the picture, drawn on the Pink view.
    await popup.evaluate(`document.querySelector('#diffViews [data-view="pink"]').click(); document.getElementById('diffIgnoreBtn').click()`);
    await sleep(SETTLE_MS);
    const r = await popup.evaluate(`(() => { const p = document.querySelector('#diffStage .diff-pic').getBoundingClientRect(); return { x: p.left, y: p.top, w: p.width, h: p.height }; })()`);
    const mouse = (type, fx, fy) => popup.send('Input.dispatchMouseEvent', { type, x: r.x + r.w * fx, y: r.y + r.h * fy, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', 0.02, 0.02);
    await mouse('mouseMoved', 0.5, 0.3);
    await mouse('mouseMoved', 0.98, 0.5);
    await mouse('mouseReleased', 0.98, 0.5);
    await sleep(POPUP_SETTLE_MS);
    const after = await stats();
    const pct = (s) => Number(/\(([\d.]+)%/.exec(s)?.[1]);
    const saved = await ctx.ext.evaluate(`chrome.storage.local.get('diffIgnore_v1').then((x) => x.diffIgnore_v1 || {})`);
    check(/1 box left out/.test(after) && pct(after) <= pct(before) && Object.values(saved)[0]?.boxes?.length === 1,
      'a box left out lowers the count and is remembered', { before, after, saved });

    await popup.evaluate(`document.getElementById('diffClose').click()`);
    await compare();
    check(/1 box left out/.test(await stats()), 'Image Diff on two pictures of those sizes leaves the box out again', await stats());
  } finally {
    await popup.close();
    await clearAll(ctx);
  }
}

/** A pixel of the editor's display canvas at a fraction of it, as "r,g,b". */
const pixelAt = (ed, fx, fy) => ed.evaluate(`(() => {
  const c = document.getElementById('cvs');
  const d = c.getContext('2d').getImageData(Math.round(c.width * ${fx}), Math.round(c.height * ${fy}), 1, 1).data;
  return d[0] + ',' + d[1] + ',' + d[2];
})()`);

export async function checkImageEditor(ctx) {
  await clearAll(ctx);
  await clipboardReady(ctx);
  // A white 400 × 300 picture, opened as the Image Editor opens one.
  const dataUrl = await ctx.ext.evaluate(`(() => { const c = new OffscreenCanvas(400, 300); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 300);
    return c.convertToBlob({ type: 'image/png' }).then((b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); })); })()`);
  await ctx.send({ type: 'OPEN_IMAGE_EDITOR', dataUrl, sourceFileName: 'white.png' });
  const ed = await ctx.browser.pageOpenedAt(ctx.extUrl('editor.html'), 5_000);
  if (!ed) { check(false, 'the editor opens', null); return; }
  try {
    await sleep(POPUP_SETTLE_MS);
    await ed.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const r = await ed.evaluate(`(() => { const b = document.getElementById('cvs').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    const at = (fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
    const key = async (k, code) => {
      await ed.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k });
      await ed.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
    };
    const click = async (fx, fy) => {
      const p = at(fx, fy);
      await ed.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
      await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
    };
    const drag = async (a, b) => {
      await ed.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(...a), button: 'left', buttons: 1, clickCount: 1 });
      await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), button: 'left', buttons: 1 });
      await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(...b), button: 'left', buttons: 1 });
      await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(...b), button: 'left', buttons: 0, clickCount: 1 });
    };
    const hint = () => ed.evaluate(`document.getElementById('ctxHint')?.textContent`);

    await key('n', 'KeyN');
    await click(0.2, 0.2);
    await click(0.4, 0.2);
    const placed = { first: await pixelAt(ed, 0.2, 0.2), second: await pixelAt(ed, 0.4, 0.2), hint: await hint() };
    await ed.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
    await ed.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
    const undone = { first: await pixelAt(ed, 0.2, 0.2), second: await pixelAt(ed, 0.4, 0.2), hint: await hint() };
    check(placed.first === '239,68,68' && placed.second === '239,68,68' && placed.hint === 'Click to place step 3'
      && undone.first === '239,68,68' && undone.second === '255,255,255' && undone.hint === 'Click to place step 2',
    '① places numbered circles; Undo takes the last one back, number and all', { placed, undone });

    await key('x', 'KeyX');
    await drag([0.6, 0.6], [0.9, 0.9]);
    const black = await pixelAt(ed, 0.75, 0.75);
    await key('s', 'KeyS');
    await drag([0.05, 0.6], [0.3, 0.9]);
    const spot = { inside: await pixelAt(ed, 0.15, 0.75), outside: await pixelAt(ed, 0.5, 0.45) };
    check(black === '0,0,0' && spot.inside === '255,255,255' && spot.outside === '115,115,115',
      '▮ Redact fills its box black; ◎ Spotlight dims what is outside its box', { black, spot });

    await ed.evaluate(`document.getElementById('btnSaveFull').click()`);
    await sleep(POPUP_SETTLE_MS);
    const saved = { clip: await clipboardImage(ctx), recent: await recentList(ctx) };
    check(saved.clip === 'image/png 400x300' && saved.recent[0]?.kind === 'Edited',
      'saving copies the edited picture and keeps it in Recent captures', saved);
  } finally {
    await ed.close().catch(() => { /* closed itself after saving */ });
    await clearAll(ctx);
  }
}

export const CHECKS = [
  ['capture-copy', 'Captures go onto the clipboard and into Recent', checkCaptureCopy],
  ['recent', 'Recent captures: listed, copied, removed', checkRecent],
  ['image-diff', 'Image Diff: sizes, drag, a box left out', checkImageDiff],
  ['image-editor', 'Image editor: step numbers, redact, spotlight, copy on save', checkImageEditor],
];
