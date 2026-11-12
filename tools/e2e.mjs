#!/usr/bin/env node
/**
 * e2e.mjs — features played in the real extension, checked on the page.
 *
 * Loads the unpacked extension in Edge or Chromium (tools/lib/cdp-browser.mjs, no
 * Playwright), serves a test page, builds scenarios through the extension's own
 * messages (CREATE_SCENARIO, ADD_MANUAL_ACTION, SAVE_VARIABLES), plays them with
 * START_PLAYBACK_SCENARIO and reads the result off the page. The checks live in
 * tools/e2e/<suite>.mjs, each file saying what its checks prove:
 *
 *   locate      how playback finds and acts on elements
 *   run         a run as it shows: overlays, schedule, Assert, Last run, run panel
 *   editor      the popup's action list and Add Action form
 *   vars        variables: suggestions, names, rename
 *   record      recording
 *   export      the Export Code card and its modal
 *   export-run  exported code run on a page, as playback leaves it
 *   csv         the CSV card's ZIP download
 *   api         the API Tests page
 *   pages       the SQL page, highlights, the import warning
 *
 * Helpers more than one suite uses: tools/e2e/harness.mjs; the test pages: tools/e2e/test-pages.mjs.
 *
 * Usage: node tools/e2e.mjs [--suite <a,b>] [--only <a,b>] [--list] [--ext <extension dir>] [--headed] [--cases <a,b>]
 *        --suite runs only those suites (the names above, or --list); --only runs only the
 *        checks named; both: the checks in both.
 *        --list prints the checks picked, suite by suite, and exits (no browser).
 *        --cases runs only those cases of export-run (and its fails-at-step check when named).
 *        --ext runs another checkout (an older commit, to see a check fail there).
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { createServer } from 'node:http';
import { launchWithExtension, sleep } from './lib/cdp-browser.mjs';
import { EXT, HEADED, PAGE_SETTLE_MS, argValue, args, fail, failures, ok } from './e2e/harness.mjs';
import { FRAME_PAGE, TEST_PAGE } from './e2e/test-pages.mjs';
import { CHECKS as locateChecks } from './e2e/locate.mjs';
import { CHECKS as runChecks } from './e2e/run.mjs';
import { CHECKS as editorChecks } from './e2e/editor.mjs';
import { CHECKS as varsChecks } from './e2e/vars.mjs';
import { CHECKS as recordChecks } from './e2e/record.mjs';
import { CHECKS as exportChecks } from './e2e/export.mjs';
import { CHECKS as exportRunChecks, EXPORT_PAGE, saveExportState } from './e2e/export-run.mjs';
import { CHECKS as csvChecks } from './e2e/csv.mjs';
import { CHECKS as apiChecks, apiRoute } from './e2e/api.mjs';
import { CHECKS as pagesChecks } from './e2e/pages.mjs';

const ONLY = argValue('--only')?.split(',') || null;
const SUITE = argValue('--suite')?.split(',') || null;
const LIST = args.includes('--list');

/** The browser, the test tab, and helpers shared by the checks. */
async function setUp(browser, base) {
  const sw = await browser.serviceWorker();
  if (!sw) throw new Error('service worker did not start');
  const extUrl = (p) => `chrome-extension://${sw.extId}/${p}`;
  // Messages to the worker go from an extension page; any will do.
  const ext = await browser.openPage(extUrl('dbtest.html'));
  const send = (msg) => ext.evaluate(`new Promise((res) => chrome.runtime.sendMessage(${JSON.stringify(msg)}, (r) => res(r ?? null)))`);
  const web = await browser.openPage(`${base}/page`, { width: 1000, height: 700 });
  await sleep(PAGE_SETTLE_MS);
  const webTabId = await ext.evaluate(`new Promise((res) => chrome.tabs.query({ url: ${JSON.stringify(`${base}/page*`)} }, (t) => res(t[0]?.id)))`);
  return { browser, base, sw, ext, web, webTabId, extUrl, send };
}

const SUITES = {
  'locate': locateChecks,
  'run': runChecks,
  'editor': editorChecks,
  'vars': varsChecks,
  'record': recordChecks,
  'export': exportChecks,
  'export-run': exportRunChecks,
  'csv': csvChecks,
  'api': apiChecks,
  'pages': pagesChecks,
};

/** Every check as [name, title, run, suite], suite by suite. */
const CHECKS = Object.entries(SUITES).flatMap(([suite, checks]) => checks.map((c) => [...c, suite]));

/** The checks --suite and --only ask for, in CHECKS order; a name that is not there ends the run. */
function pickChecks() {
  const unknownSuites = (SUITE || []).filter((s) => !Object.hasOwn(SUITES, s));
  if (unknownSuites.length) {
    console.error(`e2e: no suite named ${unknownSuites.map((s) => `"${s}"`).join(', ')} (${Object.keys(SUITES).join(', ')})`);
    process.exit(1);
  }
  const unknown = (ONLY || []).filter((n) => !CHECKS.some(([name]) => name === n));
  if (unknown.length) {
    console.error(`e2e: no check named ${unknown.map((n) => `"${n}"`).join(', ')} (${CHECKS.map(([n]) => n).join(', ')})`);
    process.exit(1);
  }
  return CHECKS.filter(([name, , , suite]) => (!ONLY || ONLY.includes(name)) && (!SUITE || SUITE.includes(suite)));
}

async function main() {
  const picked = pickChecks();
  if (LIST) {
    let suite = null;
    for (const [name, title, , s] of picked) {
      if (s !== suite) console.log((suite = s));
      console.log(`  ${name.padEnd(22)} ${title}`);
    }
    process.exit(0);
  }
  const server = await new Promise((res) => {
    const s = createServer((req, reply) => {
      if (req.method === 'POST' && req.url === '/state') { saveExportState(req, reply); return; }
      if (req.url.startsWith('/api/')) { apiRoute(req, reply); return; }
      reply.setHeader('content-type', 'text/html; charset=utf-8');
      // /redirect?to=<url>: a page that sends the browser on, as a login page does.
      if (req.url.startsWith('/redirect')) {
        reply.writeHead(302, { location: new URL(req.url, 'http://x').searchParams.get('to') });
        reply.end();
        return;
      }
      if (req.url.startsWith('/frame')) reply.end(FRAME_PAGE);
      else reply.end(req.url.startsWith('/export') ? EXPORT_PAGE : TEST_PAGE);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchWithExtension(EXT, { headed: HEADED });
  } catch (e) {
    server.close();
    console.error(`e2e: ${e.message}`);
    process.exit(/^no browser/.test(e.message) ? 2 : 1);
  }
  console.log(`Browser: ${browser.browserPath}\nExtension: ${EXT}`);
  try {
    const ctx = await setUp(browser, base);
    for (const [name, title, run] of picked) {
      console.log(title);
      try { await run(ctx); } catch (e) { fail(`${name}: ${e.message}`); }
    }
    const errors = [...ctx.sw.errors(), ...ctx.web.errors()];
    if (errors.length) fail(`errors: ${errors.join(' | ')}`);
    else ok('no uncaught errors in the worker or on the test page');
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  await main();
} catch (e) {
  fail(e.stack || e.message);
}
console.log(failures.length ? `\ne2e: ${failures.length} failure(s)` : '\ne2e: OK');
process.exit(failures.length ? 1 : 0);
