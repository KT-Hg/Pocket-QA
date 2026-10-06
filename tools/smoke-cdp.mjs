#!/usr/bin/env node
/**
 * smoke-cdp.mjs — tools/smoke.mjs without Playwright: the same checks, over the
 * DevTools protocol with Node's own WebSocket (Node 22+, tools/lib/cdp-browser.mjs).
 *
 *   1. the service worker starts, has an onMessage listener, and answers
 *      GET_EXTENSION_STATUS / GET_SCENARIOS;
 *   2. popup / sqlcases / dbtools / editor / capture-window pages load without
 *      uncaught errors, console errors or failed requests, and follow the shared
 *      theme key;
 *   3. content.js answers PING on an http page;
 *   4. an Adminer-looking page makes dbtools/boot.js import its modules through
 *      web_accessible_resources without "failed to load";
 *   5. the popup on an activated http page: the status bar says Active and offers
 *      Remove, and the Now Playing bar (wired by popup/connection.js) opens its panel;
 *   6. with --shots <dir>: screenshots of every popup tab and the other pages, light
 *      and dark, for a before/after comparison of a CSS change.
 *
 * The browser is $CHROMIUM_PATH, or the usual Edge / Chromium install.
 * tools/verify.mjs --smoke runs this when Playwright is not installed.
 *
 * Usage: node tools/smoke-cdp.mjs [--headed] [--shots <dir>]
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asActiveTab, launchWithExtension, sleep } from './lib/cdp-browser.mjs';
import { startServer } from './lib/smoke-pages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const shotsIdx = args.indexOf('--shots');
const SHOTS = shotsIdx >= 0 ? resolve(args[shotsIdx + 1]) : null;

// How long a page gets to settle after load before its errors are read.
const POPUP_SETTLE_MS = 1500;
const PAGE_SETTLE_MS = 800;
const THEME_SETTLE_MS = 600;
const ADMINER_SETTLE_MS = 1500;
const TAB_SWITCH_MS = 400;
const POPUP_VIEWPORT = { width: 480, height: 900 };
const PAGE_VIEWPORT = { width: 1280, height: 900 };
// Screenshots compare equal run to run: no animation mid-way, no caret.
const STILL_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ✖ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

async function main() {
  // A fixed port when screenshotting: the Highlight tab shows the page's host.
  const server = await startServer(SHOTS ? 47321 : 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchWithExtension(ROOT, { headed: HEADED });
  } catch (e) {
    server.close();
    console.error(`smoke-cdp: ${e.message}`);
    process.exit(/^no browser/.test(e.message) ? 2 : 1);
  }
  console.log(`Browser: ${browser.browserPath}`);
  try {
    console.log('Service worker');
    const sw = await browser.serviceWorker();
    if (!sw) { fail('service worker did not start (a module failed to load?)'); return; }
    // A worker whose module graph failed to link still shows up as a worker, but
    // none of its top-level code ran — so it has no message listener.
    const listening = await sw.evaluate('chrome.runtime.onMessage.hasListeners()').catch(() => false);
    if (!listening) { fail('service worker started but registered no onMessage listener (module failed to load?)'); return; }
    ok(`started (${sw.extId})`);
    const extUrl = (p) => `chrome-extension://${sw.extId}/${p}`;

    const extPage = await checkPages(browser, extUrl);
    await checkRouter(extPage);
    await checkThemeKey(browser, extPage, extUrl);
    await checkContentScript(browser, extPage, base);
    await checkDbTools(browser, base);
    const swErrors = sw.errors();
    if (swErrors.length) fail(`service worker errors: ${swErrors.join(' | ')}`);
    else ok('service worker: no uncaught errors');
    const popup = await checkActivatedPopup(browser, extUrl, base);
    if (SHOTS) await screenshots(browser, popup, extUrl);
  } finally {
    await browser.close();
    server.close();
  }
}

async function checkPages(browser, extUrl) {
  console.log('Extension pages');
  let extPage = null;
  for (const p of ['popup.html', 'sqlcases.html', 'dbtools.html', 'editor.html', 'capture-window.html']) {
    const page = await browser.openPage(extUrl(p));
    await sleep(p === 'popup.html' ? POPUP_SETTLE_MS : PAGE_SETTLE_MS);
    // editor.html without a crop token and capture-window.html without a stream
    // report that in their UI; neither should throw.
    const errors = page.errors();
    if (errors.length) fail(`${p}: ${errors.join(' | ')}`);
    else ok(`${p} loaded`);
    if (p === 'popup.html') extPage = page; else await page.close();
  }
  return extPage;
}

const askWorker = (page, type) => page.evaluate(`new Promise((res) => {
  chrome.runtime.sendMessage({ type: ${JSON.stringify(type)} }, (r) => res(r ?? { noResponse: true }));
  setTimeout(() => res({ noResponse: true }), 5000);
})`);

async function checkRouter(extPage) {
  console.log('Router');
  const status = await askWorker(extPage, 'GET_EXTENSION_STATUS');
  if (!status || status.noResponse) fail('GET_EXTENSION_STATUS: no response');
  else ok(`GET_EXTENSION_STATUS → ${JSON.stringify(status).slice(0, 120)}`);
  const scenarios = await askWorker(extPage, 'GET_SCENARIOS');
  if (!scenarios || scenarios.noResponse) fail('GET_SCENARIOS: no response');
  else ok('GET_SCENARIOS answered');
}

async function checkThemeKey(browser, extPage, extUrl) {
  console.log('Shared theme key');
  await extPage.evaluate(`chrome.storage.local.set({ popupTheme: 'dark' })`);
  for (const p of ['popup.html', 'sqlcases.html', 'dbtools.html', 'capture-window.html']) {
    const page = await browser.openPage(extUrl(p));
    await sleep(THEME_SETTLE_MS);
    const theme = await page.evaluate(`document.documentElement.getAttribute('data-theme')`);
    if (theme === 'dark') ok(`${p} follows popupTheme`);
    else fail(`${p}: data-theme is '${theme}' with popupTheme = dark`);
    await page.close();
  }
  await extPage.evaluate(`chrome.storage.local.remove('popupTheme')`);
}

async function checkContentScript(browser, extPage, base) {
  console.log('Content script');
  const web = await browser.openPage(`${base}/page`);
  await sleep(PAGE_SETTLE_MS);
  const pong = await extPage.evaluate(`new Promise((res) => chrome.tabs.query({}, (tabs) => {
    const tab = tabs.find((t) => t.url && t.url.startsWith(${JSON.stringify(`${base}/page`)}));
    if (!tab) return res({ error: 'tab not found' });
    chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r));
    setTimeout(() => res({ error: 'timeout' }), 5000);
  }))`);
  if (pong?.ready) ok(`content.js answers PING (${JSON.stringify(pong)})`);
  else fail(`content.js PING: ${JSON.stringify(pong)}`);
  if (web.errors().length) fail(`test page: ${web.errors().join(' | ')}`);
}

async function checkDbTools(browser, base) {
  console.log('DB tools on an Adminer-looking page');
  const adm = await browser.openPage(`${base}/adminer`);
  await sleep(ADMINER_SETTLE_MS);
  if (adm.errors().length) fail(`adminer page: ${adm.errors().join(' | ')}`);
  else ok('dbtools modules imported without errors');
}

/** The popup as if opened on the activated http page; returned for the screenshots. */
async function checkActivatedPopup(browser, extUrl, base) {
  console.log('Popup on an activated http page');
  const popup = await browser.openPage(extUrl('popup.html'), { initScript: asActiveTab(`${base}/page`), ...POPUP_VIEWPORT });
  await popup.evaluate(`new Promise((res) => chrome.tabs.query({ url: ${JSON.stringify(`${base}/page*`)} }, (tabs) =>
    chrome.storage.local.set({ activatedTabs: tabs.map((x) => x.id) }, res)))`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  const bar = await popup.evaluate(`({
    activation: document.getElementById('activationStatus')?.textContent,
    removeShown: getComputedStyle(document.getElementById('deactivateTab')).display !== 'none',
  })`);
  if (bar.activation === 'Active' && bar.removeShown) ok('status bar: Active, with Remove');
  else fail(`status bar: ${JSON.stringify(bar)}`);
  const panel = await popup.evaluate(`(() => {
    const bar = document.getElementById('nowPlayingBar');
    bar.click(); const open = bar.getAttribute('aria-expanded');
    bar.click(); return { open, closed: bar.getAttribute('aria-expanded') };
  })()`);
  if (panel.open === 'true' && panel.closed === 'false') ok('the Now Playing bar opens and closes its panel');
  else fail(`Now Playing bar: ${JSON.stringify(panel)}`);
  if (popup.errors().length) fail(`popup (activated): ${popup.errors().join(' | ')}`);
  return popup;
}

async function screenshots(browser, popup, extUrl) {
  console.log(`Screenshots → ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  const still = `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(STILL_CSS)};
    document.head.appendChild(s);
    // "Last checked" is a clock time; hidden so two runs compare equal.
    const t = document.getElementById('updateInfoChecked'); if (t) t.style.visibility = 'hidden'; })()`;
  for (const theme of ['light', 'dark']) {
    await popup.evaluate(`chrome.storage.local.set({ popupTheme: '${theme}' })`);
    await popup.reload();
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(still);
    for (const tab of ['tabRecord', 'tabData', 'tabCapture', 'tabHighlight', 'tabSettings']) {
      await popup.evaluate(`document.querySelector('.tab-btn[data-tab="${tab}"]').click()`);
      await sleep(TAB_SWITCH_MS);
      writeFileSync(join(SHOTS, `popup-${tab}-${theme}.png`), await popup.screenshot());
    }
    for (const p of ['sqlcases.html', 'dbtools.html', 'editor.html']) {
      const page = await browser.openPage(extUrl(p), PAGE_VIEWPORT);
      await sleep(PAGE_SETTLE_MS);
      await page.evaluate(still);
      writeFileSync(join(SHOTS, `${p.replace('.html', '')}-${theme}.png`), await page.screenshot());
      await page.close();
    }
  }
  ok('screenshots written');
}

try {
  await main();
} catch (e) {
  fail(e.stack || e.message);
}
console.log(failures.length ? `\nsmoke: ${failures.length} failure(s)` : '\nsmoke: OK');
process.exit(failures.length ? 1 : 0);
