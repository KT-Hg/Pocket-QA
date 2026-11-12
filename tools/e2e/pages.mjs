/**
 * tools/e2e/pages.mjs — e2e: the pages suite. Run by tools/e2e.mjs.
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
  const mark = () => ctx.web.evaluate(`document.querySelector('mark[data-hl-id]')?.textContent || null`);
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
  const openEdit = () => ctx.web.evaluate(`document.querySelector('mark[data-hl-id]').click()`);
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
  ['import-warning', 'Importing actions that reach beyond the page', checkImportWarning],
];
