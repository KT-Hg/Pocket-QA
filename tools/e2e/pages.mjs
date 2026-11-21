/**
 * tools/e2e/pages.mjs — e2e suite "pages". Run: node tools/e2e.mjs --suite pages
 *
 * The other pages: the SQL page's language, highlights, the import warning.
 *
 *   highlight     a text selection opens the highlight tooltip, which follows the
 *                 popup theme; a colour saves the highlight, and a reload paints it again.
 *                 With Highlight off a page loads no highlight engine; turned on, the
 *                 open page loads it and paints the highlight. A click on it opens the
 *                 edit tooltip: colour, note, delete
 *   highlight-dom  a page with no highlights gets nothing from the engine; highlights
 *                 are painted (CSS.highlights), not put in the page: no
 *                 <mark>, no split text node, so a page that changes its own text node
 *                 afterwards shows its new text whole; user-select:none stays none
 *                 unless Alt is held
 *   highlight-missing  a click in the popup's list on a highlight whose text is no longer
 *                 on the page says so, and the popup stays open
 *   import-warning  importing a scenario with Upload File and Run JS actions warns
 *                 about both, and names the folder the upload reads
 */

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from '../lib/cdp-browser.mjs';
import { PAGE_SETTLE_MS, POLL_MS, POPUP_SETTLE_MS, SETTLE_MS, check, fail, openPopup } from './harness.mjs';

export async function checkSqlLang(ctx) {
  const title = (page) => page.evaluate(`({ title: document.querySelector('.topbar-title').textContent.trim(),
    lang: document.documentElement.lang, button: document.getElementById('langLabel').textContent })`);
  await ctx.ext.evaluate(`chrome.storage.local.remove('sqlCasesLang')`);
  const page = await ctx.browser.openPage(ctx.extUrl('sqltest.html'), { width: 1200, height: 800 });
  try {
    await sleep(POPUP_SETTLE_MS);
    const first = await title(page);
    check(/SQL Test Case Designer/.test(first.title) && first.lang === 'en' && first.button === 'EN',
      'the SQL page opens in English the first time, as the popup does', first);
    await page.evaluate(`chrome.storage.local.set({ sqlCasesLang: 'vi' })`);
    await page.reload();
    await sleep(POPUP_SETTLE_MS);
    const chosen = await title(page);
    check(/Thiết kế Test Case SQL/.test(chosen.title) && chosen.lang === 'vi', 'Vietnamese once chosen stays Vietnamese', chosen);
    if (page.errors().length) fail(`page errors: ${page.errors().join(' | ')}`);
  } finally {
    await page.evaluate(`chrome.storage.local.remove('sqlCasesLang')`).catch(() => {});
    await page.close();
  }
}

export async function checkHighlight(ctx) {
  const url = `${ctx.base}/page?hl`; // its own page, so no mark lands in #johnCell elsewhere
  await ctx.web.goto(url);
  await sleep(PAGE_SETTLE_MS);
  // "John" selected; the engine reads the selection on mouseup.
  await ctx.web.evaluate(`(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('johnCell'));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await sleep(SETTLE_MS);
  const labelIn = async (theme) => {
    await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.set({ popupTheme: '${theme}' }, r))`);
    await sleep(SETTLE_MS);
    return ctx.web.evaluate(`(() => {
      const l = [...document.querySelectorAll('[data-hl-ui] div')].find((d) => d.textContent === 'Highlight color:');
      return l ? getComputedStyle(l).color : null;
    })()`);
  };
  const colours = { dark: await labelIn('dark'), light: await labelIn('light') };
  check(colours.dark?.includes('205, 214, 244') && colours.light?.includes('60, 60, 70'),
    'a selection opens the highlight tooltip, and it follows the popup theme', colours);
  await ctx.web.evaluate(`document.querySelector('[data-hl-ui] button[title="Yellow"]').click()`);
  await sleep(SETTLE_MS);
  const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('hl_v1', (x) => r(x.hl_v1?.[${JSON.stringify(url)}] || [])))`);
  check(saved.length === 1 && saved[0].text === 'John', 'picking a colour saves the highlight', saved);
  const mark = () => paintedText(ctx);
  const markSoon = async () => {
    let m = null;
    for (let waited = 0; !m && waited < 5_000; waited += POLL_MS) { await sleep(POLL_MS); m = await mark(); }
    return m;
  };
  await ctx.web.reload();
  const painted = await markSoon();
  check(painted === 'John', 'a reload paints it again', painted);

  // Whether the engine is loaded, asked in the content scripts' world.
  const engine = () => ctx.ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${ctx.webTabId} },
    func: () => !!window.__pqaHighlightInjected }).then(([r]) => r.result)`);
  const setEnabled = (on) => ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.set({ hl_enabled: ${on} }, r))`);
  await setEnabled(false);
  await ctx.web.reload();
  await sleep(PAGE_SETTLE_MS * 2);
  const off = { engine: await engine(), mark: await mark() };
  check(off.engine === false && off.mark === null, 'with Highlight off, a page loads no highlight engine', off);
  await setEnabled(true);
  const on = { mark: await markSoon(), engine: await engine() };
  check(on.engine === true && on.mark === 'John', 'turned on, the open page loads it and paints the highlight', on);

  // The edit tooltip (a click on the mark): a colour, a note, then delete — each
  // an edit the worker applies to the store (HL_EDIT).
  const stored = () => ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('hl_v1', (x) => r(x.hl_v1?.[${JSON.stringify(url)}] || null)))`);
  const openEdit = () => clickPainted(ctx);
  await openEdit();
  await sleep(SETTLE_MS);
  await ctx.web.evaluate(`(() => {
    document.querySelector('[data-hl-ui] button[title="Green"]').click();
    document.querySelector('[data-hl-ui] textarea').value = 'n1';
    [...document.querySelectorAll('[data-hl-ui] button')].find((b) => b.textContent === 'Save note').click();
  })()`);
  await sleep(SETTLE_MS);
  const edited = await stored();
  check(edited?.length === 1 && edited[0].color === 'green' && edited[0].note === 'n1', 'the edit tooltip saves a colour and a note', edited);
  await openEdit();
  await sleep(SETTLE_MS);
  await ctx.web.evaluate(`document.querySelector('[data-hl-ui] button:has(polyline)').click()`);
  await sleep(SETTLE_MS);
  const removed = { stored: await stored(), mark: await mark() };
  check(removed.stored === null && removed.mark === null, 'delete in the tooltip removes it, and the page drops out of the store', removed);
  await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.remove(['hl_v1', 'popupTheme', 'hl_enabled'], r))`);
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

/** The text of every painted highlight on the test page, joined; null when none. */
const paintedText = (ctx) => ctx.web.evaluate(`(() => {
  const out = [];
  for (const [name, hl] of CSS.highlights) if (/^pqa-hl-(yellow|green|pink|blue|orange)$/.test(name)) for (const r of hl) out.push(r.toString());
  return out.join() || null;
})()`);

/** A real click in the middle of the first painted highlight. */
async function clickPainted(ctx) {
  const p = await ctx.web.evaluate(`(() => {
    for (const [name, hl] of CSS.highlights) if (/^pqa-hl-(yellow|green|pink|blue|orange)$/.test(name)) for (const r of hl) {
      r.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  })()`);
  if (!p) return;
  await ctx.web.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
  await ctx.web.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
}

export async function checkHighlightDom(ctx) {
  const url = `${ctx.base}/page?hldom`;
  await ctx.web.goto(url);
  await sleep(PAGE_SETTLE_MS);
  const before = await ctx.web.evaluate(`document.querySelectorAll('style[data-hl-ui], mark').length`);
  check(before === 0, 'a page with no highlights gets nothing from the engine (no <style>, no <mark>)', before);
  // A price the page keeps a reference to and changes later, as React and Vue do.
  await ctx.web.evaluate(`(() => {
    const p = document.createElement('p');
    p.id = 'hlPrice';
    p.append('Total: ');
    window.__price = document.createTextNode('$42.00 due today');
    p.append(window.__price);
    const b = document.createElement('button');
    b.id = 'hlNoSelect';
    b.style.userSelect = 'none';
    b.textContent = 'Do not select me';
    document.body.prepend(p, b);
    const r = document.createRange();
    r.setStart(window.__price, 1); r.setEnd(window.__price, 6);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await sleep(SETTLE_MS);
  await ctx.web.evaluate(`document.querySelector('[data-hl-ui] button[title="Yellow"]').click()`);
  await sleep(SETTLE_MS);
  const dom = await ctx.web.evaluate(`({ marks: document.querySelectorAll('mark').length, nodes: document.getElementById('hlPrice').childNodes.length })`);
  check((await paintedText(ctx)) === '42.00' && dom.marks === 0 && dom.nodes === 2,
    'a highlight is painted, and the page gets no <mark> and keeps its text nodes whole', { painted: await paintedText(ctx), dom });
  await ctx.web.evaluate(`window.__price.data = '$40.00 due today'`);
  await sleep(SETTLE_MS);
  const text = await ctx.web.evaluate(`document.getElementById('hlPrice').textContent`);
  check(text === 'Total: $40.00 due today', 'the page changing its own text node afterwards shows its new text whole', text);

  const userSelect = () => ctx.web.evaluate(`getComputedStyle(document.getElementById('hlNoSelect')).userSelect`);
  const alt = (type) => ctx.web.send('Input.dispatchKeyEvent', { type, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: type === 'keyDown' ? 1 : 0 });
  const plain = await userSelect();
  await alt('keyDown');
  const held = await userSelect();
  await alt('keyUp');
  const after = await userSelect();
  check(plain === 'none' && held === 'text' && after === 'none', 'user-select:none stays none, unless Alt is held', { plain, held, after });
  await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.remove(['hl_v1'], r))`);
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

export async function checkHighlightMissing(ctx) {
  const url = `${ctx.base}/page`;
  await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.set({ hl_v1: { ${JSON.stringify(url)}: [
    { id: 'gone', text: 'Text this page has never had', color: 'yellow', note: '', srcUrl: ${JSON.stringify(url)} }] } }, r))`);
  await ctx.web.goto(url);
  await sleep(PAGE_SETTLE_MS * 2);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabHighlight"]').click()`);
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(`document.querySelector('#hlList li.action .value').click()`);
    await sleep(POPUP_SETTLE_MS);
    const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
    check(/is not on this page now/.test(toast), 'a click on a highlight no longer on the page says so, and the popup stays open', toast);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.remove(['hl_v1'], r))`);
  }
}

export async function checkImportWarning(ctx) {
  const file = join(tmpdir(), `pqa-e2e-import-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ name: 'e2e import warning', actions: [
    { type: 'navigate', value: 'https://example.com/upload' },
    { type: 'uploadFile', selector: '#f', folderPath: 'C:\\Users\\me\\.ssh', fileNames: ['id_rsa'] },
    { type: 'script', code: 'void 0' },
  ] }));
  const popup = await openPopup(ctx);
  try {
    const { root } = await popup.send('DOM.getDocument');
    const { nodeId } = await popup.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importFile' });
    await popup.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await popup.evaluate(`document.getElementById('importScenario').click()`);
    await sleep(POPUP_SETTLE_MS);
    const msg = await popup.evaluate(`document.querySelector('#confirmModal.show #confirmModalMsg')?.textContent || ''`);
    check(msg.includes('Upload File') && msg.includes('C:\\Users\\me\\.ssh') && msg.includes('Run JS'),
      'importing Upload File and Run JS actions warns about both, naming the folder', msg);
  } finally {
    await popup.close();
    rmSync(file, { force: true });
  }
}

export const CHECKS = [
  ['sql-lang', 'The SQL page opens in English, a chosen language kept', checkSqlLang],
  ['highlight', 'Highlights: made, saved, painted again after a reload', checkHighlight],
  ['highlight-dom', 'Highlights leave the page DOM as it is', checkHighlightDom],
  ['highlight-missing', 'A highlight no longer on the page, clicked in the popup', checkHighlightMissing],
  ['import-warning', 'Importing actions that reach beyond the page', checkImportWarning],
];
