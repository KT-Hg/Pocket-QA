#!/usr/bin/env node
/**
 * e2e.mjs — features played in the real extension, checked on the page.
 *
 * Loads the unpacked extension in Edge or Chromium (tools/lib/cdp-browser.mjs, no
 * Playwright), serves a test page, builds scenarios through the extension's own
 * messages (CREATE_SCENARIO, ADD_MANUAL_ACTION, SAVE_VARIABLES), plays them with
 * START_PLAYBACK_SCENARIO and reads the result off the page:
 *
 *   dropdown      "Choose item #" in a custom list and in a <select>; a Dropdown
 *                 known only by an id that needs escaping, or only by an XPath, opens
 *   switch        Switch "Always" plays the other scenario; a Random of length 9999
 *                 plays as 512 characters
 *   capture       two visible screenshots within a second are both saved (Chrome
 *                 allows two captureVisibleTab calls a second; the second shot retries)
 *   suggest       typing ${g in the popup lists the matching variables; Enter inserts one
 *   var-name-guard  the variable modal refuses a name another row has (adding or
 *                 renaming) and one holding "}" or "${"; saving a row under its own
 *                 name goes through
 *   var-rename    a variable renamed in the Tools tab is renamed in every scenario
 *                 using it (${…}, a Read DOM target), the toast counts them, the
 *                 preview follows, and a played scenario types its value; a new
 *                 name a scenario already writes is refused, nothing written. An
 *                 action half-typed in the form follows too, draft included, and
 *                 adding it brings the old name back nowhere
 *   preview-no-flash  Disable / Enable on an action greys it out (or back) and the
 *                 list is never left empty or on "Loading…" in between, which made
 *                 the popup shrink and grow again
 *   folder-filter  the Manage Scenarios folder filter outlives a rebuild of the
 *                 folder lists and a reopened popup; a scenario moved out of the
 *                 folder shown stays chosen; a deleted folder falls back to all
 *   switch-draft  the popup reopened on a Switch draft lists the scenarios in the
 *                 case editor; a scenario picked there survives a reload of the list
 *   background-tab  a run keeps going once its tab is sent to the background, and
 *                 finds an element added there (Chrome runs no rAF in a hidden tab)
 *   label-click   a real click on a checkbox's <label>, recorded, is one action, and
 *                 playing it leaves the box checked
 *   child-condition  "Text contains" clicks the innermost element holding the text,
 *                 and ALL needs every condition; one that matches nothing says so
 *   file-input    choosing a file while recording adds no Input action, and an old
 *                 Input action on a file input fails at once (it timed out after 10 s)
 *   hotkeys       Alt+R on a tab that is not activated reaches the page; on an
 *                 activated tab, Option+R as macOS types it ("®") starts recording
 *   schedule      a schedule's alarm opens its start URL in a new tab and plays there,
 *                 not on the tab that was active
 *   record-overlay  clicks and typing inside a [data-ext-overlay] box are not recorded
 *   condition-unknown  a Condition whose type the page does not know brings up the
 *                 failure prompt instead of passing and running what it guards
 *   selector-choice  an action's selectorType is tried first; without one, Full XPath
 *                 still comes first
 *   shadow-dom    buttons in a shadow root are clicked, one added there mid-wait
 *                 included, on a page whose light DOM never stops changing
 *   select-type   a Child Condition "Type is: select" finds a <select multiple>
 *   form-roundtrip  one action of every type, put in the Add Manual Action form
 *                 with Edit and saved twice, comes back as it was each time — six of
 *                 them with Click through off; the checkbox shows only for those
 *                 types, and a draft keeps it
 *   highlight     a text selection opens the highlight tooltip, which follows the
 *                 popup theme; a colour saves the highlight, and a reload paints it again.
 *                 With Highlight off a page loads no highlight engine; turned on, the
 *                 open page loads it and paints the highlight
 *   import-warning  importing a scenario with Upload File and Run JS actions warns
 *                 about both, and names the folder the upload reads
 *   condition-choice  a Condition checks the element of the selector type chosen in the
 *                 form, not the Full XPath one; a Condition and an element screenshot
 *                 find an element by a Name typed in the form
 *   cdp-targets   the steps that act through CDP use the element the page found:
 *                 Upload File by a typed XPath, a Dropdown opened by a typed Name,
 *                 an element screenshot of the chosen CSS, not of the Full XPath one
 *   click-through  with Click through on (the default) a covered button is clicked as
 *                 before; with it off for the scenario, or for the action, a disabled,
 *                 covered, read-only or hidden element (or drop target) fails the
 *                 action with the reason; a shadow-DOM button is not "covered" by its host.
 *                 Through CDP too: a covered Dropdown trigger and a disabled file input
 *                 fail, a file input hidden by CSS still gets its file
 *   typed-text    a Text selector typed in the form (no textTag) clicks the element
 *                 holding that text, surrounding spaces ignored
 *   select-missing  an Input of an option the <select> does not have brings up the
 *                 failure prompt and leaves the choice alone; one it has is chosen
 *   export-file-name  a Selenium script exported from a scenario named in Vietnamese
 *                 is saved under that name, letters kept, and the file holds the code
 *   export-steps  the bookmarklet's export modal shows an Upload File step as skipped
 *                 in the Actions tab, the counts and the warning bar (it showed
 *                 "✓ OK"); Selenium's, which exports it, as "✓ OK". On EXPORT_SAMPLE
 *                 the header counts all 11 steps and the 2 skipped, and the rows name
 *                 a full-page screenshot, Upload File, a Condition's element, a label
 *   export-regenerate  Reload scenario in either export modal shows a step added to
 *                 the scenario since it opened, and lists and declares only the
 *                 variables the scenario uses
 *   export-headless  the Selenium modal's Headless switch exports a headless driver,
 *                 and turns off (disabled) with Safari
 *   export-output  the Selenium modal's Output pytest gives a test_….py file with a
 *                 test function
 *   export-start-url  the Selenium start URL filled from the active tab is in the code
 *                 the modal first shows, not the TODO placeholder
 *   export-url-field  the Starting URL field (Selenium, Playwright, Robot, Java) spans its Settings row,
 *                 left-aligned, not an 80-pixel box showing "https://sl"
 *   export-settings  each format's Settings come back in a new popup, apart from the
 *                 other format's; stored values an input cannot take leave defaults
 *   export-live-settings  the Selenium code follows each Settings change with no button
 *                 pressed — Copy right after takes the new code; typing is followed
 *                 once it pauses; opening with remembered Settings generates it once
 *   export-layout  in a 480 × 600 popup the export code gets at least 400 px and Copy
 *                 does not move between tabs; the bookmarklet's warnings take one
 *                 line, which opens the Actions tab listing each reason and note;
 *                 at 480 × 500 nothing is cut off
 *   export-jump   a row of the export Actions tab, clicked or entered, opens the Code
 *                 tab with its "Step n" line in view and its lines tinted; ↧ Steps
 *                 shows Step 1
 *   export-formats  the Export Code card offers the bookmarklet, Selenium, Playwright,
 *                 Robot Framework and Selenium Java, each opening its own export with a
 *                 "⬇ Download" button (Robot's a <name>.robot file, Java's <Name>Test.java);
 *                 two by two, all one size, the last one in the middle of its row
 *   export-card   the Export Code card's format buttons are off until a scenario is
 *                 chosen; its list has the scenarios in no folder first, then a
 *                 group per folder; it opens on the scenario Manage Scenarios has
 *   export-tabs-keyboard  the export modal opened with the mouse puts focus on its
 *                 Code tab with no ring; ← → Home End open and focus the tabs; each
 *                 tab and panel name each other, the open tab alone in the Tab order
 *   export-playwright  Playwright Test opens a <name>.spec.js holding one test
 *   export-run    each scenario of EXPORT_CASES, played, run as the exported bookmarklet
 *                 and run as the exported Selenium script (python, Edge exported
 *                 headless — with a window under --headed),
 *                 leaves the export page the same way; the form case runs as the
 *                 exported pytest test too, and a pytest test with a failing step
 *                 names it; every case runs as the exported Playwright .spec.js too
 *                 (PQA_PLAYWRIGHT_DIR: a folder with @playwright/test), and every case
 *                 the Selenium script runs as the exported Robot Framework test too
 *                 (PQA_ROBOT_PYTHON: a python with robotframework-seleniumlibrary) and as
 *                 the exported Java TestNG class (PQA_JAVA_HOME: a JDK; PQA_JAVA_LIBS: a
 *                 folder of the selenium-java and testng jars).
 *                 No python, selenium, pytest, Playwright, Robot or Java: those runs are skipped,
 *                 not failed. fails-at-step: a scenario whose step 3 finds nothing,
 *                 run by each export, has its error name the step, its label and the
 *                 locator
 *   record-untrusted  a click and an input event the page's own script dispatches
 *                 are not recorded; a real click is
 *   record-checkbox  ticking a checkbox records the click only, not an Input of its
 *                 value ("on") as well
 *   record-input-order  text typed into a field and a click on a button right after
 *                 (within the input debounce) are recorded in that order
 *   record-other-tab  typing in another tab while recording is not recorded; the
 *                 recording tab still is
 *   record-restart  a recording whose worker stopped before the first action (it
 *                 sleeps after 30 s with nothing to do) still records that action
 *   csv-zip-advanced  the CSV card's Advanced section (ZIP folder name) shows only
 *                 while ZIP is chosen, also when code sets the format; a saved
 *                 folder name and Add row number come back in a new popup, the
 *                 section open
 *   csv-zip-suggest  typing ${ in the ZIP Folder name lists names with nothing
 *                 chosen in the CSV card: the Tools tab variables when no scenario
 *                 was ever chosen; after a reopen, the last CSV's columns, what the
 *                 last scenario writes and the Tools tab ones it reads (not one it
 *                 never uses); Enter inserts one
 *   csv-zip-run   a CSV run (john, kate, john) downloaded as a ZIP from the popup:
 *                 folders "abc ${name}" (abc john_2 for the repeat; _01 … with Add
 *                 row number, downloaded again with no new run), the image of a
 *                 Screenshot → Variable named by its Filename; HTML / XLSX unchanged
 *
 * Usage: node tools/e2e.mjs [--suite <a,b>] [--only <a,b>] [--list] [--ext <extension dir>] [--headed] [--cases <a,b>]
 *        --suite runs only those suites (see SUITES: locate, run, editor, vars, record, export,
 *        export-run, csv, api, pages); --only runs only the checks named; both: the checks in both.
 *        --list prints the checks picked, suite by suite, and exits (no browser).
 *        --cases runs only those cases of export-run (and its fails-at-step check when named).
 *        --ext runs another checkout (an older commit, to see a check fail there).
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { createServer } from 'node:http';
import { launchWithExtension, sleep } from './lib/cdp-browser.mjs';
import { EXT, HEADED, PAGE_SETTLE_MS, argValue, args, fail, failures, ok } from './e2e/harness.mjs';
import { CHECKS as exportRunChecks, EXPORT_PAGE, saveExportState } from './e2e/export-run.mjs';
import { CHECKS as apiChecks, apiRoute } from './e2e/api.mjs';
import { FRAME_PAGE, TEST_PAGE } from './e2e/test-pages.mjs';
import { CHECKS as locateChecks } from './e2e/locate.mjs';
import { CHECKS as runChecks } from './e2e/run.mjs';
import { CHECKS as editorChecks } from './e2e/editor.mjs';
import { CHECKS as varsChecks } from './e2e/vars.mjs';
import { CHECKS as recordChecks } from './e2e/record.mjs';
import { CHECKS as exportChecks } from './e2e/export.mjs';
import { CHECKS as csvChecks } from './e2e/csv.mjs';
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
