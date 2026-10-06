#!/usr/bin/env node
/**
 * smoke.mjs — load the unpacked extension in Chromium and check that it starts.
 *
 * Catches what static checks cannot: a module that throws while loading, a page
 * whose import graph fails at runtime, a router that stopped answering.
 *
 *   1. the service worker starts and answers GET_EXTENSION_STATUS;
 *   2. popup / sqlcases / dbtools / editor / capture-window pages load without
 *      uncaught errors, console errors or failed requests;
 *   3. content.js is injected into an http page and answers PING;
 *   4. an Adminer-looking page makes dbtools/boot.js import its modules through
 *      web_accessible_resources without "failed to load";
 *   5. with --shots <dir>: screenshots of every popup tab and the other pages,
 *      light and dark, for a before/after comparison of a CSS change.
 *
 * Needs Playwright (not a repo dependency). Resolved in this order:
 *   `playwright` / `playwright-core` on NODE_PATH, then $PLAYWRIGHT_CORE (path to
 *   a playwright-core package directory, e.g. the one bundled with the Python
 *   package: <site-packages>/playwright/driver/package).
 *
 * The browser is Playwright's own Chromium unless $CHROMIUM_PATH names a chrome
 * executable (handy when the installed browser build is not the one this
 * playwright-core version expects). Extensions need full Chromium, never the
 * headless shell, so headless runs pass channel 'chromium' (new headless).
 *
 * Usage: node tools/smoke.mjs [--headed] [--shots <dir>]
 */

import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const shotsIdx = args.indexOf('--shots');
const SHOTS = shotsIdx >= 0 ? resolve(args[shotsIdx + 1]) : null;

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch { /* not installed under this name — try the next */ }
  }
  if (process.env.PLAYWRIGHT_CORE) {
    return import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.js')).href).then((m) => m.default || m);
  }
  console.error('smoke: Playwright not found. Set NODE_PATH to an install, or PLAYWRIGHT_CORE to a playwright-core directory.');
  process.exit(2);
}

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))]);

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ✖ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title></head>
<body><h1 id="title">Smoke page</h1><input id="name"><button id="go">Go</button>
<select id="pick"><option>a</option><option>b</option></select></body></html>`;
const ADMINER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="generator" content="Adminer 4.8.1">
<title>Adminer</title></head><body><div id="menu"></div><div id="content"><p>not a real Adminer page</p></div>
<form><input type="hidden" name="token" value="x"></form></body></html>`;

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      reply.setHeader('content-type', 'text/html; charset=utf-8');
      reply.end(req.url.startsWith('/adminer') ? ADMINER_PAGE : TEST_PAGE);
    });
    // A fixed port when screenshotting: the Highlight tab shows the page's host.
    server.listen(SHOTS ? 47321 : 0, '127.0.0.1', () => res(server));
  });
}

/** Collect errors of one page until `watch.stop()`. */
function watch(page, label) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    if (m.type() === 'warning' && /failed to load/i.test(m.text())) errors.push(`console.warn: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  return { errors, label };
}

async function main() {
  const pw = await loadPlaywright();
  const userData = mkdtempSync(join(tmpdir(), 'pqa-smoke-'));
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await pw.chromium.launchPersistentContext(userData, {
    headless: !HEADED,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    console.log('Service worker');
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
    if (!sw) { fail('service worker did not start (a module failed to load?)'); return; }
    const extId = new URL(sw.url()).host;
    // A worker whose module graph failed to link still shows up as a worker, but
    // none of its top-level code ran — so it has no message listener.
    const listening = await withTimeout(sw.evaluate(() => chrome.runtime.onMessage.hasListeners()), 5_000, false);
    if (!listening) { fail('service worker started but registered no onMessage listener (module failed to load?)'); return; }
    ok(`started (${extId})`);
    await sw.evaluate(() => {
      self.__smokeErrors = [];
      self.addEventListener('error', (e) => self.__smokeErrors.push(String(e.message || e)));
      self.addEventListener('unhandledrejection', (e) => self.__smokeErrors.push(String(e.reason?.stack || e.reason)));
    });
    const extUrl = (p) => `chrome-extension://${extId}/${p}`;

    console.log('Extension pages');
    const pages = ['popup.html', 'sqlcases.html', 'dbtools.html', 'editor.html', 'capture-window.html'];
    let extPage = null;
    for (const p of pages) {
      const page = await context.newPage();
      const w = watch(page, p);
      await page.goto(extUrl(p), { waitUntil: 'load' });
      await page.waitForTimeout(p === 'popup.html' ? 1500 : 800);
      // editor.html without a crop token and capture-window.html without a stream
      // report that in their UI; neither should throw.
      if (w.errors.length) fail(`${p}: ${w.errors.join(' | ')}`);
      else ok(`${p} loaded`);
      if (p === 'popup.html') extPage = page; else await page.close();
    }

    console.log('Router');
    const ask = (type) => withTimeout(extPage.evaluate((t) => new Promise((res) =>
      chrome.runtime.sendMessage({ type: t }, (r) => res(r ?? { noResponse: true }))), type), 5_000, { noResponse: true });
    const status = await ask('GET_EXTENSION_STATUS');
    if (!status || status.noResponse) fail('GET_EXTENSION_STATUS: no response');
    else ok(`GET_EXTENSION_STATUS → ${JSON.stringify(status).slice(0, 120)}`);
    const scenarios = await ask('GET_SCENARIOS');
    if (!scenarios || scenarios.noResponse) fail('GET_SCENARIOS: no response');
    else ok('GET_SCENARIOS answered');

    console.log('Shared theme key');
    await extPage.evaluate(() => new Promise((res) => chrome.storage.local.set({ popupTheme: 'dark' }, res)));
    for (const p of ['popup.html', 'sqlcases.html', 'dbtools.html', 'capture-window.html']) {
      const page = await context.newPage();
      await page.goto(extUrl(p), { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (theme === 'dark') ok(`${p} follows popupTheme`);
      else fail(`${p}: data-theme is '${theme}' with popupTheme = dark`);
      await page.close();
    }
    await extPage.evaluate(() => new Promise((res) => chrome.storage.local.remove('popupTheme', res)));

    console.log('Content script');
    const web = await context.newPage();
    const ww = watch(web, 'test page');
    await web.goto(`${base}/page`, { waitUntil: 'load' });
    await web.waitForTimeout(800);
    const pong = await withTimeout(extPage.evaluate((url) => new Promise((res) => {
      chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((t) => t.url && t.url.startsWith(url));
        if (!tab) return res({ error: 'tab not found' });
        chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r));
      });
    }), `${base}/page`), 5_000, { error: 'timeout' });
    if (pong?.ready) ok(`content.js answers PING (${JSON.stringify(pong)})`);
    else fail(`content.js PING: ${JSON.stringify(pong)}`);
    if (ww.errors.length) fail(`test page: ${ww.errors.join(' | ')}`);

    console.log('DB tools on an Adminer-looking page');
    const adm = await context.newPage();
    const wa = watch(adm, 'adminer page');
    await adm.goto(`${base}/adminer`, { waitUntil: 'load' });
    await adm.waitForTimeout(1500);
    const booted = await adm.evaluate(() => document.documentElement.outerHTML.length > 0);
    if (wa.errors.length) fail(`adminer page: ${wa.errors.join(' | ')}`);
    else ok(`dbtools modules imported without errors (page alive: ${booted})`);

    const swErrors = await sw.evaluate(() => self.__smokeErrors);
    if (swErrors.length) fail(`service worker errors: ${swErrors.join(' | ')}`);
    else ok('service worker: no uncaught errors');

    if (SHOTS) await screenshots(context, extUrl, `${base}/page`);
  } finally {
    await context.close();
    server.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

async function screenshots(context, extUrl, webUrl) {
  console.log(`Screenshots → ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 480, height: 900 });
    // Opened as a tab, the popup would see itself as the active tab and show only
    // "Not available". Point its active-tab query at the http test page instead,
    // and mark that tab activated, so every card renders as it does in real use.
    await page.addInitScript((url) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => {
        const real = q && q.active && q.currentWindow ? { url: url + '*' } : q;
        return cb ? query(real, cb) : query(real);
      };
    }, webUrl);
    await page.goto(extUrl('popup.html'), { waitUntil: 'load' });
    await page.evaluate(({ t, url }) => new Promise((res) => chrome.tabs.query({ url: url + '*' }, (tabs) =>
      chrome.storage.local.set({ popupTheme: t, activatedTabs: tabs.map((x) => x.id) }, res))), { t: theme, url: webUrl });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
    for (const tab of ['tabRecord', 'tabData', 'tabCapture', 'tabHighlight', 'tabSettings']) {
      await page.click(`.tab-btn[data-tab="${tab}"]`);
      await page.waitForTimeout(400);
      // "Last checked" is a clock time; masked so two runs compare equal.
      await page.screenshot({ path: join(SHOTS, `popup-${tab}-${theme}.png`), fullPage: true, animations: 'disabled',
        mask: [page.locator('#updateInfoChecked')] });
    }
    for (const p of ['sqlcases.html', 'dbtools.html', 'editor.html']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(extUrl(p), { waitUntil: 'load' });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS, `${p.replace('.html', '')}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.close();
  }
  ok('screenshots written');
}

await main();
if (failures.length) {
  console.log(`\nsmoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nsmoke: OK');
