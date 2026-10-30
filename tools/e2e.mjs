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
 *   var-rename    a variable renamed in the Data tab is renamed in every scenario
 *                 using it (${…}, a Read DOM target), the toast counts them, the
 *                 preview follows, and a played scenario types its value; a new
 *                 name a scenario already writes is refused, nothing written
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
 *                 chosen in the CSV card: the Data tab variables when no scenario
 *                 was ever chosen; after a reopen, the last CSV's columns, what the
 *                 last scenario writes and the Data tab ones it reads (not one it
 *                 never uses); Enter inserts one
 *   csv-zip-run   a CSV run (john, kate, john) downloaded as a ZIP from the popup:
 *                 folders "abc ${name}" (abc john_2 for the repeat; _01 … with Add
 *                 row number, downloaded again with no new run), the image of a
 *                 Screenshot → Variable named by its Filename; HTML / XLSX unchanged
 *
 * Usage: node tools/e2e.mjs [--only <name>] [--ext <extension dir>] [--headed] [--cases <a,b>]
 *        --cases runs only those cases of export-run (and its fails-at-step check when named).
 *        --ext runs another checkout (an older commit, to see a check fail there).
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asActiveTab, launchWithExtension, sleep } from './lib/cdp-browser.mjs';

const args = process.argv.slice(2);
const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const EXT = resolve(argValue('--ext') || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const ONLY = argValue('--only');
const HEADED = args.includes('--headed');
const CASES = argValue('--cases')?.split(',') || null;

// A run is waited for this long, then stopped.
const PLAY_TIMEOUT_MS = 30_000;
const POLL_MS = 150;
const SETTLE_MS = 300;
const PAGE_SETTLE_MS = 800;
const POPUP_SETTLE_MS = 1500;
// After the worker is stopped: long enough for it to be gone before the next message wakes it.
const WORKER_STOP_SETTLE_MS = 1000;
const POPUP_VIEWPORT = { width: 480, height: 900 };

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ✖ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(`${msg} — ${JSON.stringify(detail)}`));

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>e2e</title>
<style>.menu { display: none } .menu.open { display: block } li, [id], .xp { padding: 4px }</style></head>
<body>
<div id="dd" name="ddtrigger">Choose…</div>
<ul id="menu" class="menu"><li>One</li><li>Two</li><li>Three</li></ul>
<div id="vdd">Pick from 1000…</div>
<div id="vlist" class="menu" role="listbox" style="height:150px;overflow-y:auto"><div id="vinner" style="position:relative"></div></div>
<select id="sel"><option>a</option><option>b</option><option>c</option></select>
<div id="2nd:dd">id that needs escaping</div>
<div class="xp">known only by XPath</div>
<input id="out"><input id="big">
<button id="bg1">bg1</button><button id="bg2">bg2</button>
<label for="agree" id="agreeLabel">Agree</label><input type="checkbox" id="agree"><label id="plainLabel">Just text</label>
<input type="file" id="upload">
<button id="choiceA">choiceA</button><button id="choiceB">choiceB</button>
<div id="forms"><input id="formText"><select id="multiSel" multiple><option>m1</option></select></div>
<div data-ext-overlay="test"><button id="overlayBtn">overlay</button><input id="overlayNote"></div>
<table id="people"><tbody>
  <tr><td id="aliceCell">Alice</td><td><button id="edit1" class="edit">Edit</button></td></tr>
  <tr><td id="johnCell">John</td><td><button id="edit2" class="edit special">Edit</button></td></tr>
</tbody></table>
<input name="nick">
<button id="ctDisabled" disabled>ctDisabled</button>
<span style="position:relative;display:inline-block"><button id="ctCovered">ctCovered</button><span id="ctCover" style="position:absolute;inset:0"></span></span>
<input id="ctReadonly" readonly><button id="ctHidden" style="display:none">ctHidden</button>
<input type="file" id="ctFileDisabled" disabled><input type="file" id="ctFileHidden" style="display:none">
<script>
  window.__log = [];
  document.getElementById('ctCovered').addEventListener('click', () => __log.push('ctCovered'));
  // background-tab: #bg1 adds #late a moment later; every click logs whether the tab was visible.
  const logClick = (el) => el.addEventListener('click', () => __log.push(el.id + ' ' + document.visibilityState));
  logClick(document.getElementById('bg1'));
  logClick(document.getElementById('bg2'));
  logClick(document.getElementById('choiceA'));
  logClick(document.getElementById('choiceB'));
  // shadow-dom (?shadow only): buttons in a shadow root, one added late, and a
  // ticker that keeps the light DOM changing as a busy app does.
  if (location.search.includes('shadow')) {
    customElements.define('shadow-box', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }); }
    });
    const host = document.createElement('shadow-box');
    document.body.append(host);
    const addShadowButton = (id) => {
      const b = document.createElement('button');
      b.id = id;
      b.addEventListener('click', () => __log.push('shadow ' + id));
      host.shadowRoot.append(b);
    };
    addShadowButton('shadowBtn');
    setTimeout(() => addShadowButton('lateShadowBtn'), 700);
    const ticker = document.createElement('span');
    document.body.append(ticker);
    setInterval(() => { ticker.textContent = String(Date.now() % 1000); }, 50);
  }
  // hotkeys: every Alt+key the page sees, and whether the extension kept it.
  window.addEventListener('keydown', (e) => { if (e.altKey) __log.push('key ' + e.code + ' ' + (e.defaultPrevented ? 'prevented' : 'free')); });
  // select-type: which element under #forms a Child Condition clicked.
  document.getElementById('forms').addEventListener('click', (e) => __log.push('forms ' + e.target.id));
  // child-condition: which element under #people a Child Condition clicked.
  document.getElementById('people').addEventListener('click', (e) => __log.push('people ' + (e.target.id || e.target.tagName)));
  document.getElementById('bg1').addEventListener('click', () => setTimeout(() => {
    const late = document.createElement('button');
    late.id = 'late';
    logClick(late);
    document.body.append(late);
  }, 500));
  const dd = document.getElementById('dd'), menu = document.getElementById('menu');
  dd.addEventListener('click', () => { menu.classList.add('open'); __log.push('dd open'); });
  menu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    dd.textContent = li.textContent; menu.classList.remove('open'); __log.push('picked ' + li.textContent);
  }));
  // A list of 1000 that renders only the rows in view (and a few more), as react-window does;
  // ?mixed: 120 rows of 30 and 40 px by turns.
  const vdd = document.getElementById('vdd'), vlist = document.getElementById('vlist'), vinner = document.getElementById('vinner');
  const mixed = location.search.includes('mixed');
  const heights = Array.from({ length: mixed ? 120 : 1000 }, (_, i) => (mixed && i % 2 ? 40 : 30));
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, h) => a + h, 0));
  vinner.style.height = (tops[tops.length - 1] + heights[heights.length - 1]) + 'px';
  const vrender = () => {
    let first = 0;
    while (first < tops.length - 1 && tops[first + 1] <= vlist.scrollTop) first++;
    const last = Math.min(tops.length - 1, first + 7);
    vinner.replaceChildren(...Array.from({ length: last - first + 1 }, (_, k) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.textContent = 'Item ' + (first + k + 1);
      row.style.cssText = 'position:absolute;left:0;right:0;height:' + heights[first + k] + 'px;top:' + tops[first + k] + 'px';
      row.addEventListener('click', () => { vdd.textContent = row.textContent; vlist.classList.remove('open'); });
      return row;
    }));
  };
  vlist.addEventListener('scroll', vrender);
  vdd.addEventListener('click', () => { vlist.classList.add('open'); vlist.scrollTop = 0; vrender(); });
  document.getElementById('2nd:dd').addEventListener('click', () => __log.push('id dropdown clicked'));
  document.querySelector('.xp').addEventListener('click', () => __log.push('xpath dropdown clicked'));
</script></body></html>`;

/** The browser, the test tab, and helpers shared by the checks. */
async function setUp(browser, base) {
  const sw = await browser.serviceWorker();
  if (!sw) throw new Error('service worker did not start');
  const extUrl = (p) => `chrome-extension://${sw.extId}/${p}`;
  // Messages to the worker go from an extension page; any will do.
  const ext = await browser.openPage(extUrl('dbtools.html'));
  const send = (msg) => ext.evaluate(`new Promise((res) => chrome.runtime.sendMessage(${JSON.stringify(msg)}, (r) => res(r ?? null)))`);
  const web = await browser.openPage(`${base}/page`, { width: 1000, height: 700 });
  await sleep(PAGE_SETTLE_MS);
  const webTabId = await ext.evaluate(`new Promise((res) => chrome.tabs.query({ url: ${JSON.stringify(`${base}/page*`)} }, (t) => res(t[0]?.id)))`);
  return { browser, base, sw, ext, web, webTabId, extUrl, send };
}

/** A scenario made of `actions`, saved through the worker; its id. */
async function makeScenario(ctx, name, actions) {
  const { id } = await ctx.send({ type: 'CREATE_SCENARIO', name });
  for (const action of actions) await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id, action });
  return id;
}

/**
 * Play a scenario on the test tab (it must be the active tab) and return the page's state.
 * `away`: a page brought to the front once the run has started, which hides the test tab.
 */
async function play(ctx, scenarioId, { away = null } = {}) {
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId });
  if (away) await away.bringToFront();
  await sleep(SETTLE_MS);
  let running = true;
  for (let waited = 0; running && waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
    const st = await ctx.send({ type: 'GET_EXTENSION_STATUS' });
    running = !!(st?.playing || st?.sequencePlaying);
    if (running) await sleep(POLL_MS);
  }
  // A run stuck on a failure prompt would block the next check.
  if (running) await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  // `?.`: export-run plays on the export page, which has none of these.
  return ctx.web.evaluate(`({ log: window.__log, dd: document.getElementById('dd')?.textContent, vdd: document.getElementById('vdd')?.textContent,
    sel: document.getElementById('sel')?.value, out: document.getElementById('out')?.value,
    big: document.getElementById('big')?.value, timedOut: ${running} })`);
}

const reloadTestPage = async (ctx) => { await ctx.web.reload(); await sleep(PAGE_SETTLE_MS); };

/** Record what `perform` does on the test tab into a new scenario; its id and the recorded actions. */
async function record(ctx, name, perform) {
  const id = await makeScenario(ctx, name, []);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_RECORD', scenarioId: id, tabId: ctx.webTabId });
  await sleep(SETTLE_MS);
  await perform();
  await sleep(SETTLE_MS);
  const r = await ctx.send({ type: 'STOP_RECORD' });
  return { id, actions: r?.actions || [] };
}

/** A real (trusted) mouse click in the middle of `selector` on the test tab. */
async function clickAt(ctx, selector) {
  const { x, y } = await ctx.web.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.web.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function checkDropdown(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e dropdowns', [
    { type: 'dropdown', selector: '#dd', selectors: { css: '#dd' }, pick: { by: 'index', index: '2', itemSelector: '#menu li' } },
    { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, pick: { by: 'index', index: '-1' } },
    { type: 'dropdown', selectors: { id: '2nd:dd' } },
    { type: 'dropdown', selector: '//div[@class="xp"]', selectors: { xpath: '//div[@class="xp"]' } },
  ]);
  const r = await play(ctx, id);
  check(r.dd === 'Two', 'Choose item #2 in a custom list picks "Two"', r);
  check(r.sel === 'c', 'Choose item #-1 in a <select> picks the last option', r);
  check(r.log.includes('id dropdown clicked'), 'a Dropdown known only by an id that needs escaping opens', r.log);
  check(r.log.includes('xpath dropdown clicked'), 'a Dropdown known only by an XPath opens', r.log);
  // A virtualized list of 1000: #500 by its Items selector, then the last with none given;
  // rows of mixed heights, walked: #77 and the last of 120.
  for (const [index, itemSelector, want, page] of [['500', '#vlist [role="option"]', 'Item 500', 'page'],
    ['-1', '', 'Item 1000', 'page'], ['77', '', 'Item 77', 'page?mixed'], ['-1', '', 'Item 120', 'page?mixed']]) {
    await ctx.web.goto(`${ctx.base}/${page}`);
    await sleep(PAGE_SETTLE_MS);
    const v = await makeScenario(ctx, `e2e virtual ${index}`, [
      { type: 'dropdown', selector: '#vdd', selectors: { css: '#vdd' }, pick: { by: 'index', index, itemSelector } },
    ]);
    const rv = await play(ctx, v);
    check(rv.vdd === want && !rv.timedOut, `Choose item #${index} in a virtualized list${page.includes('mixed') ? ' of mixed rows' : ''} picks "${want}"`, rv);
  }
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

async function checkSwitchAlways(ctx) {
  await reloadTestPage(ctx);
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { greet: 'hello', big: '{random:alpha:9999}' } });
  const other = await makeScenario(ctx, 'e2e other', [
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${greet}-from-other' },
    { type: 'input', selector: '#big', selectors: { css: '#big' }, value: '${big}' },
  ]);
  const main = await makeScenario(ctx, 'e2e always', [
    { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: other, scenarioName: 'e2e other' }] },
  ]);
  const r = await play(ctx, main);
  check(r.out === 'hello-from-other', 'Switch Always plays the other scenario', r);
  check(r.big.length === 512 && /^[a-zA-Z]+$/.test(r.big), 'a Random of length 9999 plays as 512 letters', { length: r.big.length });
}

async function checkCapture(ctx) {
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  await ctx.web.bringToFront();
  await sleep(SETTLE_MS);
  const before = ctx.browser.downloads().length;
  const shots = await ctx.ext.evaluate(`Promise.all([1, 2].map(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT', tabId: ${ctx.webTabId} }, (r) => res(r ?? null)))))`, 30_000);
  await sleep(POPUP_SETTLE_MS);
  check(shots.every((s) => s?.success), 'both screenshots succeed', shots);
  check(ctx.browser.downloads().length - before === 2, 'two PNG files saved', ctx.browser.downloads());
}

/** Polls `expr` on the test page until it is truthy, for up to `ms`; its last value. */
async function pageSoon(ctx, expr, ms = 5_000) {
  let v = null;
  for (let waited = 0; !v && waited < ms; waited += POLL_MS) { v = await ctx.web.evaluate(expr); if (!v) await sleep(POLL_MS); }
  return v;
}

// The overlays content.js does not carry (content-overlays.js): loaded by the worker
// only for a countdown, a failed-action prompt or a segment capture.
async function checkOverlays(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.bringToFront();
  const loaded = () => ctx.ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${ctx.webTabId} },
    func: () => !!window.__pqaOverlaysInjected }).then(([r]) => r.result)`);
  check(await loaded() === false, 'a page that has not needed one carries no overlay code', null);

  // The countdown the screenshot hotkey asks for, sent from the page as content.js sends it.
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  const before = ctx.browser.downloads().length;
  await ctx.ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${ctx.webTabId} },
    func: () => { chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT', crop: false, fromHotkey: true, countdown: 2 }); } })`);
  const pill = await pageSoon(ctx, `document.getElementById('__screenshot_countdown')?.textContent || null`);
  let saved = 0;
  for (let waited = 0; !saved && waited < 8_000; waited += POLL_MS) { await sleep(POLL_MS); saved = ctx.browser.downloads().length - before; }
  check(!!pill?.includes('Screenshot in') && saved === 1, 'a hotkey countdown shows the pill on the page, then saves the shot', { pill, saved });

  // A failed action (an option the <select> does not have): the prompt on the page; Stop ends the run.
  const id = await makeScenario(ctx, 'e2e overlay prompt', [{ type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'zzz', delay: 0 }]);
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  const prompt = await pageSoon(ctx, `document.getElementById('__action_failed_prompt')?.textContent || null`, 10_000);
  await ctx.web.evaluate(`document.querySelector('#__action_failed_prompt button[title="Record it as failed and end the run"]')?.click()`);
  let st = null;
  for (let waited = 0; waited < 5_000; waited += POLL_MS) { st = await ctx.send({ type: 'GET_EXTENSION_STATUS' }); if (!st?.playing) break; await sleep(POLL_MS); }
  if (st?.playing) await ctx.send({ type: 'STOP_PLAYBACK' });
  check(!!prompt?.includes('Action 1 of 1 failed') && !st?.playing, 'a failed action asks on the page, and Stop ends the run', { prompt, playing: st?.playing });

  // A segment capture: the bar on the page; its ✕ ends the session.
  await ctx.send({ type: 'START_SEGMENT_CAPTURE', tabId: ctx.webTabId, dir: 'vertical' });
  const bar = await pageSoon(ctx, `[...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`);
  await ctx.web.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ctx.web.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const gone = !!(await pageSoon(ctx, `![...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`, 3_000));
  check(bar === true && gone, 'a segment capture shows its bar on the page, and ESC takes it away', { bar, gone });
  // Alt+X (segment stop) from content.js reaches the bar's capture through window.
  const shotsBefore = ctx.browser.downloads().length;
  await ctx.send({ type: 'START_SEGMENT_CAPTURE', tabId: ctx.webTabId, dir: 'vertical' });
  await pageSoon(ctx, `[...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`);
  for (const type of ['keyDown', 'keyUp']) {
    await ctx.web.send('Input.dispatchKeyEvent', { type, key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 1 });
  }
  let segSaved = 0;
  for (let waited = 0; !segSaved && waited < 10_000; waited += POLL_MS) { await sleep(POLL_MS); segSaved = ctx.browser.downloads().length - shotsBefore; }
  check(segSaved === 1, 'the segment-stop hotkey captures the segment', { segSaved });
  check(await loaded() === true, 'the overlay code is in the page once one was needed', null);
}

/** The popup as if opened on the activated test page; `size`: { width, height } other than POPUP_VIEWPORT. */
async function openPopup(ctx, size = POPUP_VIEWPORT) {
  const popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...size });
  await popup.evaluate(`chrome.storage.local.set({ activatedTabs: [${ctx.webTabId}] })`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  return popup;
}

async function checkSuggest(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { greet: 'hello', gamma: 'g' } });
  const popup = await openPopup(ctx);
  await popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const type = document.getElementById('manualActionType');
    type.value = 'input'; type.dispatchEvent(new Event('change'));
    const value = document.getElementById('manualValue'); value.value = ''; value.focus();
  })()`);
  await popup.send('Input.insertText', { text: 'Hi ${g' });
  await sleep(SETTLE_MS);
  const names = await popup.evaluate(`[...document.querySelectorAll('.var-suggest .vs-name')].map((e) => e.textContent)`);
  check(names.includes('greet') && names.includes('gamma'), 'typing ${g lists greet and gamma', names);
  for (const type of ['keyDown', 'keyUp']) {
    await popup.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await sleep(SETTLE_MS);
  const value = await popup.evaluate(`document.getElementById('manualValue').value`);
  check(/^Hi \$\{(greet|gamma)\}$/.test(value), 'Enter inserts the highlighted ${name}', value);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

/** The Data tab's variable modal in `popup`: a row's Edit (Add with no key), filled in and saved. */
function variableModal(popup) {
  return {
    open: (key) => popup.evaluate(key == null
      ? `document.getElementById('addVariableRow').click()`
      : `[...document.querySelectorAll('li.var-row')].find((li) => li.dataset.key === ${JSON.stringify(key)}).querySelector('.vr-edit').click()`),
    // The toast, and whether the modal stayed open, once Save has had its answer. `value` null: as it was.
    save: async (name, value = null) => {
      await popup.evaluate(`(() => {
        document.getElementById('randomVarName').value = ${JSON.stringify(name)};
        if (${JSON.stringify(value)} !== null) document.getElementById('staticValue').value = ${JSON.stringify(value)};
        document.getElementById('confirmRandom').click();
      })()`);
      await sleep(SETTLE_MS);
      return popup.evaluate(`({ toast: document.getElementById('toast').textContent, open: document.getElementById('randomModal').classList.contains('show') })`);
    },
    cancel: () => popup.evaluate(`document.getElementById('cancelRandom').click()`),
  };
}

async function checkVarNameGuard(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { alpha: 'one', beta: 'two' }, order: ['alpha', 'beta'] });
  const popup = await openPopup(ctx);
  const table = async () => JSON.stringify((await ctx.send({ type: 'GET_VARIABLES' })).variables);
  const { open, save, cancel } = variableModal(popup);
  const before = await table();

  await open(null);
  const added = await save('beta', 'three');
  check(added.open && /already exists/.test(added.toast), 'adding a name the table has is refused', added);
  await cancel();
  await open('alpha');
  const renamed = await save('beta', 'one');
  check(renamed.open && /already exists/.test(renamed.toast), 'renaming to a name another row has is refused', renamed);
  await cancel();
  for (const bad of ['a}', '${x}']) {
    await open(null);
    const r = await save(bad, 'v');
    check(r.open && /variable name/i.test(r.toast), `"${bad}" is refused as a name`, r);
    await cancel();
  }
  const rows = await popup.evaluate(`[...document.querySelectorAll('li.var-row')].map((li) => li.dataset.key)`);
  check(JSON.stringify(rows) === '["alpha","beta"]', 'the table still has alpha and beta once', rows);
  const after = await table();
  check(after === before, 'nothing refused was saved', { before, after });

  await open('alpha');
  const kept = await save('alpha', 'uno');
  const vars = JSON.parse(await table());
  check(!kept.open && vars.alpha?.s === 'uno' && vars.beta?.s === 'two', 'saving a row under its own name is not a clash', { kept, vars });
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

async function checkVarRename(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { first: '1', renameMe: 'hello', last: '3' }, order: ['first', 'renameMe', 'last'] });
  // The preview shows an Input by its selector, and its label: a label naming the variable follows a rename too.
  const played = await makeScenario(ctx, 'e2e rename: typed', [{ type: 'input', selector: '#out', value: '${renameMe}', label: 'Type ${renameMe}' }]);
  const other = await makeScenario(ctx, 'e2e rename: read', [
    { type: 'readdom', selector: '#dd', varName: 'renameMe' },
    { type: 'click', selector: '#${renameMe}', selectors: { css: '#${renameMe}' } },
  ]);
  await makeScenario(ctx, 'e2e rename: writes taken', [{ type: 'readdom', selector: '#dd', varName: 'taken' }]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(played)} })`);
  const popup = await openPopup(ctx);
  const { open, save, cancel } = variableModal(popup);
  const preview = () => popup.evaluate(`document.getElementById('actions').textContent`);
  const stored = async () => JSON.stringify([await ctx.send({ type: 'GET_VARIABLES' }), await ctx.send({ type: 'GET_SCENARIOS' })]);
  check((await preview()).includes('${renameMe}'), 'the preview shows ${renameMe} at first', await preview());

  await open('renameMe');
  const renamed = await save('renamed');
  check(!renamed.open && /5 references in 2 scenarios/.test(renamed.toast), 'the rename says what it updated', renamed);
  const { scenarios } = await ctx.send({ type: 'GET_SCENARIOS' });
  const [typed] = scenarios[played].actions;
  check(typed.value === '${renamed}' && typed.label === 'Type ${renamed}', 'the played scenario reads ${renamed}', scenarios[played].actions);
  const [read, click] = scenarios[other].actions;
  check(read.varName === 'renamed' && click.selector === '#${renamed}' && click.selectors?.css === '#${renamed}',
    'Read DOM writes renamed, the selectors read ${renamed}', scenarios[other].actions);
  const table = await ctx.send({ type: 'GET_VARIABLES' });
  check(JSON.stringify(table.order) === '["first","renamed","last"]' && !('renameMe' in table.variables) && table.variables.renamed?.s === 'hello',
    'the table has renamed in renameMe\'s place, its value kept', table);
  const shown = await preview();
  check(shown.includes('${renamed}') && !shown.includes('${renameMe}'), 'the preview follows without reopening the popup', shown);

  const before = await stored();
  await open('renamed');
  const taken = await save('taken');
  check(taken.open && /"taken" is already used in "e2e rename: writes taken"/.test(taken.toast), 'a name a scenario writes is refused', taken);
  await cancel();
  check(await stored() === before, 'the refused rename wrote nothing', null);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();

  const page = await play(ctx, played);
  check(page.out === 'hello', 'played, the scenario types the value of renamed', page);
  await reloadTestPage(ctx);
}

async function checkSwitchDraft(ctx) {
  const a = await makeScenario(ctx, 'e2e alpha', []);
  const b = await makeScenario(ctx, 'e2e beta', []);
  await ctx.ext.evaluate(`chrome.storage.local.set({ manualFormDraft: {
    actionType: 'switch', switchVar: '\${role}', switchMode: 'var', cardOpen: true, scenarioId: '${a}',
    switchCases: [{ value: 'admin', scenarioId: '${b}', scenarioName: 'e2e beta' }],
  } })`);
  const popup = await openPopup(ctx);
  const list = `(() => { const sel = document.getElementById('switchCaseScenario');
    return { type: document.getElementById('manualActionType').value, ids: [...sel.options].map((o) => o.value), value: sel.value }; })()`;
  const restored = await popup.evaluate(list);
  check(restored.type === 'switch' && restored.ids.includes(a) && restored.ids.includes(b),
    'the popup reopened on a Switch draft lists the scenarios', restored);
  const picked = await popup.evaluate(`(async () => {
    document.querySelector('input[name="switchCaseMode"][value="other"]').click();
    document.getElementById('switchCaseScenario').value = '${b}';
    (await import(chrome.runtime.getURL('popup/scenarios/scenario-list.js'))).loadScenarios();
    await new Promise((r) => setTimeout(r, 500));
    return ${list};
  })()`);
  check(picked.value === b, 'a scenario picked in the case editor stays picked when the list reloads', picked);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
  await popup.close();
}

/**
 * Drag action row `from` of the popup's list as a pointer does — dragover moving
 * up two pixels at a time — until what is above it reads `want` ('top',
 * 'after <index>'), and drop it there. Returns what it was dropped under.
 */
function dragRow(popup, from, want) {
  return popup.evaluate(`(async () => {
    const list = document.getElementById('actions');
    const li = list.querySelector('li.action[data-index="${from}"]');
    const dt = new DataTransfer();
    li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    // The "move out of …" drop zones come in once dragstart has returned.
    await new Promise((r) => setTimeout(r, 100));
    const above = () => {
      let p = li.previousElementSibling;
      while (p && !p.getClientRects().length) p = p.previousElementSibling;
      if (!p) return 'top';
      return p.matches('li.action') ? 'after ' + p.dataset.index : p.className.split(' ')[0];
    };
    let got = above();
    for (let y = li.getBoundingClientRect().top + 20; y > -2000 && got !== ${JSON.stringify(want)}; y -= 2) {
      list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
      got = above();
    }
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    li.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return got;
  })()`);
}

/** #4 Switch ${role}: "admin" runs #5–#6, "user" #7; then #8 logout and #9 new. */
function switchBlockActions() {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const own = (value, startAt, endAt) => ({ value, scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt, endAt });
  return [
    click('a'), click('b'), click('c'),
    { type: 'switch', switchVar: '${role}', cases: [own('admin', 5, 6), own('user', 7, 7)] },
    click('menu'), click('settings'), click('profile'), click('logout'), click('new'),
  ];
}

/** Scenario `id` in the popup's action list. */
async function showScenario(popup, id) {
  await popup.evaluate(`(() => {
    document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    const s = document.getElementById('scenarioList'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(POPUP_SETTLE_MS);
}

/** Button `n` of action row `i` clicked: 1 Disable, 2 Copy, 3 Edit, 4 Delete. */
async function rowButton(popup, i, n) {
  await popup.evaluate(`document.querySelector('#actions li.action[data-index="${i}"] .btn-row button:nth-child(${n})').click()`);
  await sleep(SETTLE_MS);
}

const formTitle = (popup) => popup.evaluate(`document.getElementById('manualCardTitle').textContent`);

async function checkNumbersByPosition(ctx) {
  const id = await makeScenario(ctx, 'e2e numbers by position', switchBlockActions());
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const rows = await popup.evaluate(`[...document.querySelectorAll('#actions li.action .index')].map((el) => el.textContent.trim()).join(' ')`);
    const place = await popup.evaluate(`document.querySelector('#actions li.action[data-index="4"] .index').title`);
    check(rows === '1. 2. 3. 4. 5. 6. 7. 8. 9.' && place === 'Switch 4 › case "admin"',
      'every row is numbered by its position, in a Switch block too; the number\'s tooltip names its Switch and case', { rows, place });
    await rowButton(popup, 7, 3);
    const title = await formTitle(popup);
    check(title === 'Edit Action #8', 'Edit on row 8, after the block, opens "Edit Action #8"', title);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

async function checkNewSwitchOverActions(ctx) {
  // #1 Switch: default runs #2..#3; then #4 and #5. A new Switch is to run #5.
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const id = await makeScenario(ctx, 'e2e new switch over actions', [
    { type: 'switch', switchVar: '${role}', cases: [{ value: '__default__', scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt: 2, endAt: 3 }] },
    wait('upload'), wait('w3'), wait('w4'), wait('w5'),
  ]);
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const form = await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const from = document.getElementById('switchCaseFrom'); from.value = '4'; from.dispatchEvent(new Event('change'));
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
      return { validation: document.getElementById('switchValidation').innerText.trim(),
        continueAt: document.getElementById('switchContinueAt').selectedOptions[0]?.textContent };
    })()`);
    await popup.evaluate(`document.getElementById('addManualAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.label)).join(' | ');
    const place = await popup.evaluate(`document.querySelector('#actions li.action[data-index="5"] .index')?.title`);
    check(form.validation === '' && shape === 'switch 2–3 | upload | w3 | w4 | switch 6–6 | w5' && place === 'Switch 5 › case default',
      'a new Switch whose case runs action 5 goes in front of it: the Switch is #5, its case #6', { form, shape, place });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

async function checkEditFollowsList(ctx) {
  const ids = {};
  for (const name of ['switch', 'action', 'delete']) ids[name] = await makeScenario(ctx, `e2e edit follows ${name}`, switchBlockActions());
  let popup = await openPopup(ctx);
  try {
    const stored = (id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const confirmDelete = async () => {
      await popup.evaluate(`document.getElementById('confirmModalOk').click()`);
      await sleep(POPUP_SETTLE_MS);
    };
    const title = () => formTitle(popup);
    const save = () => popup.evaluate(`(async () => {
      const button = document.getElementById('addManualAction');
      button.click();
      for (let t = 0; button.textContent !== 'Add Action' && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
    })()`, 10_000);
    const setSelector = (s) => popup.evaluate(`(() => { const el = document.getElementById('manualSelector');
      el.value = ${JSON.stringify(s)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const ranges = (acts) => acts.find((a) => a.type === 'switch').cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ');
    const selectors = (acts) => acts.map((a) => a.selector || a.type).join(' ');

    // The Switch open in the form, "new" dragged to the end of case "admin", then Save Edit.
    await showScenario(popup, ids.switch);
    await rowButton(popup, 3, 3);
    const dropped = await dragRow(popup, 8, 'after 5');
    await sleep(POPUP_SETTLE_MS);
    const dragged = ranges(await stored(ids.switch));
    await save();
    const saved = ranges(await stored(ids.switch));
    check(dropped === 'after 5' && dragged === '5–7 8–8' && saved === dragged,
      'Save Edit on a Switch keeps the case ranges a drag gave it while the form was open', { dropped, dragged, saved });

    // "logout" (#8) open in the form and changed, "new" dragged to the top, the popup
    // closed and opened again on its draft, then Save Edit.
    await showScenario(popup, ids.action);
    await rowButton(popup, 7, 3);
    await setSelector('#logout2');
    await dragRow(popup, 8, 'top');
    await sleep(POPUP_SETTLE_MS);
    const moved = await title();
    await popup.close();
    popup = await openPopup(ctx);
    const reopened = await title();
    await save();
    const afterDrag = selectors(await stored(ids.action));
    check(moved === 'Edit Action #9' && reopened === moved && afterDrag === '#new #a #b #c switch #menu #settings #profile #logout2',
      'the action open in the form follows a drag, its draft too: Save Edit writes it, not the one now in its old place',
      { moved, reopened, afterDrag });

    // A Delete above the action open in the form, Undo while it is open, then deleting it.
    await showScenario(popup, ids.delete);
    await rowButton(popup, 7, 3);
    await setSelector('#logout2');
    await rowButton(popup, 0, 4);
    await confirmDelete();
    const shifted = await title();
    await save();
    const afterDelete = selectors(await stored(ids.delete));
    check(shifted === 'Edit Action #7' && afterDelete === '#b #c switch #menu #settings #profile #logout2 #new',
      'the action open in the form follows a Delete above it', { shifted, afterDelete });

    await rowButton(popup, 6, 3);
    const undo = await popup.evaluate(`(async () => {
      const button = document.getElementById('undoAction');
      const enabled = !button.disabled;
      button.click();
      await new Promise((r) => setTimeout(r, ${POPUP_SETTLE_MS}));
      return { enabled, toast: document.getElementById('toast').textContent };
    })()`);
    const afterUndo = selectors(await stored(ids.delete));
    check(undo.enabled && afterUndo === afterDelete && await title() === 'Edit Action #7',
      'Undo waits while an action is open in the form: the list and the edit stay', { ...undo, afterUndo });
    await rowButton(popup, 6, 4);
    await confirmDelete();
    check(await title() === 'Add Manual Action', 'deleting the action open in the form closes the edit', await title());
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

async function checkBackgroundTab(ctx) {
  await reloadTestPage(ctx);
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` }, delay: 200 });
  const id = await makeScenario(ctx, 'e2e background tab', [click('bg1'), click('late'), click('bg2')]);
  const r = await play(ctx, id, { away: ctx.ext });
  await ctx.web.bringToFront();
  check(r.log.some((e) => e.endsWith(' hidden')), 'the test tab was hidden during the run', r.log);
  check(!r.timedOut && r.log.length === 3, 'every click plays with the tab in the background', r);
  check(r.log.some((e) => e.startsWith('late ')), 'an element added while the tab is hidden is found', r.log);
}

async function checkLabelClick(ctx) {
  await reloadTestPage(ctx);
  const { id, actions } = await record(ctx, 'e2e label', () => clickAt(ctx, '#agreeLabel'));
  check(actions.length === 1, 'a click on a <label> is recorded as one action', actions);
  await reloadTestPage(ctx);
  await play(ctx, id);
  const checked = await ctx.web.evaluate(`document.getElementById('agree').checked`);
  check(checked === true, 'played back, it leaves the checkbox checked', { checked, actions });
  const direct = await record(ctx, 'e2e label direct', async () => { await clickAt(ctx, '#agree'); await clickAt(ctx, '#plainLabel'); });
  check(direct.actions.map((a) => a.selector).join() === '#agree,#plainLabel',
    'a click on the checkbox itself, and on a label with no control, are still recorded', direct.actions.map((a) => a.selector));
}

async function checkChildCondition(ctx) {
  await reloadTestPage(ctx);
  const inPeople = (conditions) => ({ type: 'click', selector: '#people', selectors: { css: '#people' }, conditions, delay: 100 });
  const id = await makeScenario(ctx, 'e2e child condition', [
    inPeople({ matchMode: 'any', textContains: 'John' }),
    inPeople({ matchMode: 'all', textContains: 'Edit', classContains: 'special' }),
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('people ')).map((e) => e.slice(7));
  check(clicked[0] === 'johnCell', 'Text contains "John" clicks the cell holding it, not the table body', clicked);
  check(clicked[1] === 'edit2', 'ALL clicks the one element matching every condition', clicked);

  // No child matching: the prompt says so.
  await reloadTestPage(ctx);
  const none = await makeScenario(ctx, 'e2e child condition none', [inPeople({ matchMode: 'any', textContains: 'Nobody' })]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: none });
  let text = '';
  for (let waited = 0; !text && waited < 10_000; waited += POLL_MS) {
    await sleep(POLL_MS);
    text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
  }
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(/No child element matches the Child Condition/.test(text), 'a Child Condition that matches nothing says so on the prompt', text.slice(0, 160));
}

async function checkFileInput(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e file input', async () => {
    const { root } = await ctx.web.send('DOM.getDocument');
    const { nodeId } = await ctx.web.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' });
    await ctx.web.send('DOM.setFileInputFiles', { nodeId, files: [fileURLToPath(import.meta.url)] });
    await sleep(600); // past the recorder's input debounce
  });
  check(!actions.some((a) => a.type === 'input'), 'choosing a file while recording adds no Input action', actions);

  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e file input played', [
    { type: 'input', selector: '#upload', selectors: { css: '#upload' }, value: 'C:\\fakepath\\a.pdf' },
  ]);
  const { prompt, seconds } = await playUntilPrompt(ctx, id);
  check(prompt && seconds < 4, 'an Input action on a file input fails at once', { prompt, seconds });
}

/**
 * Play a scenario until the failed-action prompt shows on the test page (or the
 * run ends, or 15 s pass), then stop it. Whether the prompt showed, and after how long.
 */
async function playUntilPrompt(ctx, scenarioId) {
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId });
  let prompt = false;
  while (!prompt && Date.now() - started < 15_000) {
    await sleep(POLL_MS);
    prompt = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]')].some((e) => /failed/i.test(e.textContent))`);
    if (!prompt && Date.now() - started > 2_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
  }
  const seconds = (Date.now() - started) / 1000;
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  return { prompt, seconds };
}

async function checkConditionUnknown(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e unknown condition', [
    { type: 'condition', conditionType: 'bogus', selector: '#bg1', selectors: { css: '#bg1' }, skipCount: 1 },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  const { prompt } = await playUntilPrompt(ctx, id);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  check(prompt && clicked.length === 0, 'a Condition of an unknown type stops on the failure prompt instead of passing', { prompt, clicked });
}

async function checkAssert(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e assert', [
    { type: 'assert', conditionType: 'textEquals', selector: '#asLate', selectors: { css: '#asLate' }, expectedValue: 'Saved' },
    { type: 'assert', conditionType: 'elementExists', selector: '#asNever', selectors: { css: '#asNever' } },
    { type: 'assert', conditionType: 'textEquals', selector: '#bg1', selectors: { css: '#bg1' }, expectedValue: 'nope' },
    { type: 'assert', conditionType: 'valueEquals', selector: '#asPw', selectors: { css: '#asPw' }, expectedValue: 'guess' },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  await ctx.web.evaluate(`{ const p = document.createElement('input'); p.type = 'password'; p.id = 'asPw'; p.value = 'hunter2'; document.body.append(p); }`);
  // The failures the worker reports, as the popup hears them.
  await ctx.ext.evaluate(`window.__fails = []; window.__failsHooked || chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'ACTION_FAILED') __fails.push(m.index + ' ' + m.reason);
  }); window.__failsHooked = true;`);
  // What the first Assert checks shows up 2 s after the run starts.
  await ctx.web.evaluate(`setTimeout(() => {
    const s = document.createElement('span'); s.id = 'asLate'; s.textContent = 'Saved'; document.body.append(s);
  }, 2000)`);
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  let prompt = false;
  while (Date.now() - started < 30_000) {
    await sleep(POLL_MS);
    prompt ||= await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]')].some((e) => /failed/i.test(e.textContent))`);
    if (prompt || (Date.now() - started > 1_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing)) break;
  }
  const seconds = (Date.now() - started) / 1000;
  if (prompt) await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  const fails = await ctx.ext.evaluate('__fails');
  check(!prompt && clicked.length === 1, 'a false Assert does not stop the run: no prompt, and the step after it plays', { prompt, clicked });
  check(fails[0] === '1 Expected element to exist' && !fails.some((f) => f.startsWith('0 ')),
    'an Assert that holds after 2 s passes; one that never holds fails', fails);
  check(fails[1] === '2 Expected text "nope", got "bg1"', 'a false Assert says what the page held', fails);
  check(fails[2] === '3 Expected the value of a password field to match' && !JSON.stringify(fails).includes('hunter2'),
    'and never what a password field holds', fails);
  check(fails.length === 3, 'nothing else failed', fails);
  check(seconds >= 16 && seconds < 30, 'the run waited for each: about 2 s, then the full 5 s for every false one', { seconds });
  const ended = await ctx.ext.evaluate(`new Promise((r) => chrome.action.getBadgeText({}, (badge) =>
    chrome.storage.local.get('lastRun', (x) => r({ badge, status: x.lastRun?.verdict?.status, failures: x.lastRun?.failures?.length }))))`);
  check(ended.badge === '✗' && ended.status === 'failed' && ended.failures === 3,
    'the run ends Failed: ✗ on the badge, and the run kept as the last one', ended);
}

async function checkLastRun(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e last run', [
    // Typed text the bug report hides until asked.
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: 'S3CRET' },
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' }, label: 'Press bg1' },
    { type: 'assert', conditionType: 'textEquals', selector: '#bg2', selectors: { css: '#bg2' }, expectedValue: 'nope', label: 'bg2 says nope' },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  while (Date.now() - started < 20_000) {
    await sleep(POLL_MS);
    if (Date.now() - started > 1_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
  }
  await sleep(SETTLE_MS);
  // The first failure's evidence: the page's URL, the steps run, the tab as it failed.
  const evidence = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get(['lastRun', 'lastRunShot'], (x) => r({
    url: x.lastRun?.failures?.[0]?.url, trace: x.lastRun?.failures?.[0]?.trace,
    shot: (x.lastRunShot || '').slice(0, 23), shotLength: (x.lastRunShot || '').length })))`);
  check(evidence.url === `${ctx.base}/page` && JSON.stringify(evidence.trace) === '[0,1,2]'
    && evidence.shot === 'data:image/jpeg;base64,' && evidence.shotLength > 1000,
  'the first failure keeps the URL, the steps run, and a JPEG of the tab', evidence);
  const badgeText = () => ctx.ext.evaluate('new Promise((r) => chrome.action.getBadgeText({}, r))');
  const before = await badgeText();

  const popup = await openPopup(ctx);
  const card = () => popup.evaluate(`(() => {
    const c = document.getElementById('lastRunCard');
    return { shown: !!c && !c.hidden, verdict: c?.querySelector('.lr-verdict')?.textContent,
      name: c?.querySelector('.lr-name')?.textContent, when: c?.querySelector('.lr-when')?.textContent,
      failures: [...(c?.querySelectorAll('.lr-failure') || [])].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) };
  })()`);
  const shown = await card();
  check(shown.shown && shown.verdict === '✗ Failed' && shown.name === 'e2e last run' && shown.failures.length === 1
    && shown.failures[0].includes('#3 bg2 says nope') && shown.failures[0].includes('Expected text "nope", got "bg2"'),
  'the popup shows the last run: Failed, its scenario and its failed check', shown);
  check(/ago|just now/.test(shown.when || ''), 'and how long ago it ended', shown.when);
  check(before === '✗' && (await badgeText()) === '', 'opening the popup takes the verdict off the badge', { before, after: await badgeText() });

  // A failure leads to its action in the list.
  await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    document.querySelector('#lastRunCard .lr-failure').click();`);
  await sleep(SETTLE_MS * 2);
  const jumped = await popup.evaluate(`({ selected: document.getElementById('scenarioList').value,
    row: document.querySelector('#actions li.action.lr-target')?.dataset.index })`);
  check(jumped.selected === id && jumped.row === '2', 'a failure selects its scenario and marks its action in the list', jumped);

  // The bug report: Markdown in a preview, typed values hidden until asked, Copy, the screenshot.
  const report = () => popup.evaluate(`({ open: document.getElementById('bugReportModal').classList.contains('show'),
    text: document.getElementById('bugReportText').value,
    shotButton: getComputedStyle(document.getElementById('bugReportShot')).display !== 'none' })`);
  await popup.evaluate(`document.getElementById('lastRunBugReport').click()`);
  await sleep(SETTLE_MS);
  const hidden = await report();
  check(hidden.open && hidden.text.startsWith('## ✗ Failed — e2e last run, step #3')
    && hidden.text.includes('3. ✗ Check that the text of `#bg2` is "nope" — bg2 says nope')
    && hidden.text.includes('1. Type ••• into `#out`') && !hidden.text.includes('S3CRET')
    && /Attached: `pocketqa-bug-e2e last run-[\d_-]+\.jpg`/.test(hidden.text) && hidden.shotButton,
  'Bug report: the report with typed values hidden, and its screenshot to download', hidden);
  await popup.evaluate(`document.getElementById('bugReportShowValues').click()`);
  await sleep(SETTLE_MS);
  check((await report()).text.includes('1. Type "S3CRET" into `#out`'), 'Include typed values shows them', (await report()).text.slice(0, 300));
  await popup.evaluate(`document.getElementById('bugReportCopy').click()`);
  await sleep(SETTLE_MS);
  const copied = await popup.evaluate(`document.getElementById('toast').textContent`);
  check(/copied/i.test(copied), 'Copy puts the report on the clipboard', copied);
  const jpgs = () => readdirSync(ctx.browser.downloadDir).filter((f) => f.startsWith('pocketqa-bug-') && f.endsWith('.jpg'));
  const jpgsBefore = jpgs().length;
  await popup.evaluate(`document.getElementById('bugReportShot').click()`);
  for (let waited = 0; jpgs().length === jpgsBefore && waited < 5_000; waited += POLL_MS) await sleep(POLL_MS);
  check(jpgs().length === jpgsBefore + 1, 'Download screenshot saves the JPEG', jpgs());
  await popup.evaluate(`document.getElementById('bugReportClose').click()`);

  // Its scenario deleted: the card still shows, and a failure says the scenario is gone.
  await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: id });
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  const orphan = await card();
  await popup.evaluate(`document.querySelector('#lastRunCard .lr-failure')?.click()`);
  await sleep(SETTLE_MS);
  const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
  check(orphan.shown && /no longer exists/.test(toast), 'with its scenario deleted the card still shows, and a failure says so', { orphan, toast });

  // × hides it until the next run.
  await popup.evaluate(`document.getElementById('lastRunDismiss').click()`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  check(!(await card()).shown, '× hides the card, and it stays hidden when the popup opens again', await card());
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

async function checkHotkeys(ctx) {
  await reloadTestPage(ctx);
  // Alt+R as the page gets it; `key` is what the keyboard typed ("®" for Option+R on macOS).
  const pressAltR = async (key) => {
    await ctx.web.bringToFront();
    for (const type of ['keyDown', 'keyUp']) {
      await ctx.web.send('Input.dispatchKeyEvent', { type, key, code: 'KeyR', modifiers: 1, windowsVirtualKeyCode: 82 });
    }
    await sleep(SETTLE_MS);
  };
  const lastKey = async () => (await ctx.web.evaluate(`__log.filter((e) => e.startsWith('key '))`)).at(-1);
  const recording = async () => !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.recording;
  const activate = async (on) => {
    await ctx.ext.evaluate(`chrome.storage.local.set({ activatedTabs: ${on ? `[${ctx.webTabId}]` : '[]'} })`);
    await sleep(SETTLE_MS);
  };

  await activate(false);
  await pressAltR('r');
  const off = { key: await lastKey(), recording: await recording() };
  check(off.key === 'key KeyR free' && !off.recording, 'on a tab that is not activated, Alt+R reaches the page and records nothing', off);

  await activate(true);
  await pressAltR('®');
  const on = { key: await lastKey(), recording: await recording() };
  if (on.recording) await ctx.send({ type: 'STOP_RECORD' });
  check(on.key === 'key KeyR prevented' && on.recording, 'on an activated tab, Option+R (typed as "®") starts recording', on);
  await pressAltR('r');
  const plain = { key: await lastKey(), recording: await recording() };
  if (plain.recording) await ctx.send({ type: 'STOP_RECORD' });
  check(plain.key === 'key KeyR prevented' && plain.recording, 'and a plain Alt+R still does', plain);

  // A page's own synthetic Alt+R is not a trusted key: on an activated tab it
  // fires no hotkey and the page keeps the key (it is not prevented).
  await ctx.web.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', altKey: true, bubbles: true }))`);
  await sleep(SETTLE_MS);
  const fake = { key: await lastKey(), recording: await recording() };
  if (fake.recording) await ctx.send({ type: 'STOP_RECORD' });
  check(fake.key === 'key KeyR free' && !fake.recording, "a page's synthetic Alt+R on an activated tab fires no hotkey", fake);
  await activate(false);
}

async function checkSchedule(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e scheduled', [{ type: 'click', selector: '#bg2', selectors: { css: '#bg2' }, delay: 0 }]);
  const url = `${ctx.base}/page?scheduled`;
  // The schedule's alarm, fired half a second from now (an unpacked extension
  // is not held to the 30 s minimum).
  await ctx.ext.evaluate(`new Promise((res) => chrome.storage.local.set({ schedules: [
    { id: 'e2eSched', scenarioId: '${id}', time: '00:00', enabled: true, repeat: true, url: ${JSON.stringify(url)} },
  ] }, () => { chrome.alarms.create('sched_e2eSched', { when: Date.now() + 500 }); res(); }))`);
  let found = null;
  for (let waited = 0; !found?.log?.length && waited < 20_000; waited += POLL_MS) {
    await sleep(POLL_MS);
    found = await ctx.ext.evaluate(`new Promise((res) => chrome.tabs.query({ url: ${JSON.stringify(`${url}*`)} }, async ([tab]) => {
      if (!tab) return res(null);
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => window.__log }).catch(() => [{}]);
      res({ tabId: tab.id, log: r?.result || [] });
    }))`);
  }
  await ctx.ext.evaluate(`new Promise((res) => chrome.alarms.clear('sched_e2eSched', () => chrome.storage.local.set({ schedules: [] }, res)))`);
  if (found?.tabId) await ctx.ext.evaluate(`chrome.tabs.remove(${found.tabId})`);
  check(!!found?.tabId && found.tabId !== ctx.webTabId, 'a schedule with a start URL opens a new tab on it', found);
  check(!!found?.log?.some((e) => e.startsWith('bg2 ')), 'and plays its scenario there', found);
  const onTestTab = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  check(onTestTab.length === 0, 'not on the tab that was active', onTestTab);
}

async function checkRecordOverlay(ctx) {
  await reloadTestPage(ctx);
  // #overlayBtn / #overlayNote sit in a [data-ext-overlay] box, as the extension's own overlays do.
  const { actions } = await record(ctx, 'e2e overlay', async () => {
    await clickAt(ctx, '#overlayBtn');
    await clickAt(ctx, '#overlayNote');
    await ctx.web.send('Input.insertText', { text: 'a note' });
    await sleep(600); // past the input debounce
    await clickAt(ctx, '#bg1');
  });
  check(actions.map((a) => a.selector).join() === '#bg1', 'clicks and typing in an extension overlay are not recorded', actions.map((a) => `${a.type} ${a.selector}`));
}

async function checkSelectorChoice(ctx) {
  await reloadTestPage(ctx);
  // Full XPath finds #choiceA, CSS finds #choiceB: which one plays shows which was tried first.
  const selectors = { fullXpath: '//*[@id="choiceA"]', css: '#choiceB' };
  const id = await makeScenario(ctx, 'e2e selector choice', [
    { type: 'click', selector: '#choiceB', selectors, selectorType: 'css', delay: 100 },
    { type: 'click', selector: '#choiceB', selectors, delay: 100 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked[0] === 'choiceB', 'the selector type chosen in the form is tried first', clicked);
  check(clicked[1] === 'choiceA', 'without one, the usual order (Full XPath first) applies', clicked);
}

async function checkShadowDom(ctx) {
  await ctx.web.goto(`${ctx.base}/page?shadow`);
  await sleep(PAGE_SETTLE_MS);
  const id = await makeScenario(ctx, 'e2e shadow dom', [
    { type: 'click', selector: '#shadowBtn', selectors: { css: '#shadowBtn' }, delay: 0 },
    { type: 'click', selector: '#lateShadowBtn', selectors: { css: '#lateShadowBtn' }, delay: 0 },
  ]);
  const r = await play(ctx, id);
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
  const clicked = r.log.filter((e) => e.startsWith('shadow '));
  check(clicked.join() === 'shadow shadowBtn,shadow lateShadowBtn',
    'elements in a shadow root are found, one added there while the run waits too', { clicked, timedOut: r.timedOut });
}

async function checkSelectType(ctx) {
  await reloadTestPage(ctx);
  // "Type is: select" as saved before 20464f1, against a <select multiple>.
  const id = await makeScenario(ctx, 'e2e select type', [
    { type: 'click', selector: '#forms', selectors: { css: '#forms' }, conditions: { matchMode: 'any', typeEquals: 'select' }, delay: 0 },
  ]);
  const { prompt } = await playUntilPrompt(ctx, id);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('forms '))`);
  check(!prompt && clicked.join() === 'forms multiSel', 'Child Condition "Type is: select" finds a <select multiple>', { prompt, clicked });
}

// One action of every type (and each Read DOM mode) as the form saves it.
const ROUNDTRIP_LOCATORS = { css: '#go', xpath: '//*[@id="go"]', fullXpath: '/html/body/button[1]', id: 'go' };
const roundtripFixtures = (otherId) => [
  { type: 'click', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, label: 'Go' },
  { type: 'click', selector: '#list', selectors: { css: '#list' }, delay: 500, conditions: { matchMode: 'all', textContains: 'John', classContains: 'row', typeEquals: 'select' } },
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Ann ${x}', delay: 300 },
  { type: 'hover', selector: '#go', selectors: ROUNDTRIP_LOCATORS, selectorType: 'id', delay: 500 },
  { type: 'navigate', url: 'https://example.com/login', delay: 1000 },
  { type: 'wait', delay: 2000 },
  { type: 'script', code: "document.title = 'x';", delay: 500 },
  { type: 'screenshot', value: 'page-${n}', delay: 500 },
  { type: 'screenshot_full', delay: 500 },
  { type: 'screenshot_element', selector: '#go', selectors: ROUNDTRIP_LOCATORS, value: 'go.png', delay: 500 },
  { type: 'screenshot_tovar', varName: 'shot', target: 'element', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500 },
  { type: 'screenshot_tovar', varName: 'named', target: 'page', value: 'sub/${user}_login', delay: 500 },
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, varName: 'title', readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, pattern: 'Hello ${who}!', matchCase: true, readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#link', selectors: { css: '#link' }, varName: 'href', readFrom: 'attr', attrName: 'href', delay: 500 },
  { type: 'dragdrop', selector: '#a', selectors: { css: '#a' }, targetSelector: '#b', targetSelectors: { css: '#b' }, delay: 500 },
  { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, pick: { by: 'index', index: '-1', itemSelector: '.menu li' }, delay: 500 },
  { type: 'uploadFile', selector: '#file', selectors: { css: '#file' }, uploadMode: 'input', folderPath: 'C:\\data', fileNames: ['a.pdf', '${f}'], delay: 500 },
  { type: 'condition', conditionType: 'textContains', selector: '#title', selectors: { css: '#title' }, expectedValue: 'Hi', skipCount: 2, delay: 500 },
  { type: 'condition', conditionType: 'urlContains', expectedValue: '/login', skipCount: 1, delay: 500 },
  { type: 'assert', selector: '#title', selectors: { css: '#title' }, conditionType: 'textEquals', expectedValue: 'Hi ${who}', delay: 500, label: 'Title' },
  { type: 'assert', conditionType: 'urlContains', expectedValue: '/done', delay: 500 },
  { type: 'assert', selector: '#go', selectors: ROUNDTRIP_LOCATORS, conditionType: 'elementVisible', expectedValue: '', delay: 500 },
  { type: 'switch', switchVar: '${role}', cases: [{ value: 'admin', scenarioId: otherId, scenarioName: 'e2e rt other' }, { value: '__default__', scenarioId: otherId, scenarioName: 'e2e rt other' }], delay: 500 },
  // "Click through" off, on each type that has it.
  { type: 'click', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, clickThrough: false },
  { type: 'hover', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, label: 'Hover', clickThrough: false },
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'x', delay: 300, clickThrough: false },
  { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, delay: 500, clickThrough: false },
  { type: 'dragdrop', selector: '#a', selectors: { css: '#a' }, targetSelector: '#b', targetSelectors: { css: '#b' }, delay: 500, clickThrough: false },
  { type: 'uploadFile', selector: '#file', selectors: { css: '#file' }, uploadMode: 'input', folderPath: 'C:\\data', fileNames: ['a.pdf'], delay: 500, clickThrough: false },
];

/** JSON with every object's keys sorted: chrome.storage hands nested objects back sorted. */
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

async function checkFormRoundtrip(ctx) {
  const other = await makeScenario(ctx, 'e2e rt other', [{ type: 'wait', delay: 100 }]);
  const fixtures = roundtripFixtures(other);
  const id = await makeScenario(ctx, 'e2e roundtrip', fixtures);
  const popup = await openPopup(ctx);
  await popup.evaluate(`(() => {
    document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    const s = document.getElementById('scenarioList'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(SETTLE_MS);
  const actionAt = (i) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions[${i}])))`);
  // Edit → Save the action at i through the form; its saved copy.
  // A type the form does not offer leaves its select empty and Save does nothing,
  // so the stored copy would come back unchanged without the form ever holding it.
  const formTypes = [];
  const editSave = async (i) => {
    const before = await actionAt(i);
    formTypes[i] = await popup.evaluate(`(async () => {
      const { startEdit } = await import('./popup/record/action-form.js');
      startEdit(${i}, ${JSON.stringify(before)});
      return document.getElementById('manualActionType').value;
    })()`);
    await popup.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, 100));
      // Saved once the form leaves edit mode (storage.onChanged does not fire for
      // a value written back unchanged, which is the point here).
      const button = document.getElementById('addManualAction');
      button.click();
      for (let t = 0; button.textContent !== 'Add Action' && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
    })()`, 10_000);
    return actionAt(i);
  };
  const bad = [];
  for (let i = 0; i < fixtures.length; i++) {
    const a1 = await editSave(i);
    const a2 = await editSave(i);
    if (formTypes[i] !== fixtures[i].type) bad.push({ i, type: fixtures[i].type, formType: formTypes[i] });
    else if (canonical(a1) !== canonical(fixtures[i])) bad.push({ i, type: fixtures[i].type, saved: a1 });
    else if (JSON.stringify(a2) !== JSON.stringify(a1)) bad.push({ i, type: fixtures[i].type, secondSave: a2 });
  }
  check(!bad.length, `every action type (${fixtures.length} fixtures) comes back from Edit → Save as it was`, bad);

  // The Click through checkbox: shown only for the types it covers, and kept by
  // a draft (the popup closed and opened again mid-edit).
  const offIndex = fixtures.findIndex((a) => a.type === 'hover' && a.clickThrough === false);
  const form = await popup.evaluate(`(async () => {
    const { startEdit, clearEditState } = await import('./popup/record/action-form.js');
    const { collectManualFormState, applyManualFormState } = await import('./popup/record/form-state.js');
    const shown = () => getComputedStyle(document.getElementById('clickThroughWrapper')).display !== 'none';
    const box = document.getElementById('clickThrough');
    startEdit(4, ${JSON.stringify(fixtures[4])});
    const onNavigate = shown();
    startEdit(${offIndex}, ${JSON.stringify(fixtures[offIndex])});
    const onHover = { shown: shown(), checked: box.checked };
    const draft = collectManualFormState();
    clearEditState();
    const cleared = box.checked;
    applyManualFormState(draft);
    const restored = { shown: shown(), checked: box.checked };
    clearEditState();
    return { onNavigate, onHover, draft: draft.clickThrough, cleared, restored };
  })()`);
  check(!form.onNavigate && form.onHover.shown && !form.onHover.checked && form.draft === false && form.cleared
    && form.restored.shown && !form.restored.checked,
  'the Click through checkbox shows only where it applies, and a draft keeps it', form);

  // Assert has a Condition's fields without "Then run"; switching the type keeps
  // what was filled in, and so does a draft.
  const condIndex = fixtures.findIndex((a) => a.type === 'condition');
  const asAssert = await popup.evaluate(`(async () => {
    const { startEdit, clearEditState } = await import('./popup/record/action-form.js');
    const { collectManualFormState, applyManualFormState } = await import('./popup/record/form-state.js');
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const read = () => ({
      type: document.getElementById('manualActionType').value,
      check: document.getElementById('conditionType').value,
      value: document.getElementById('conditionExpectedValue').value,
      selector: document.getElementById('manualSelector').value,
      ifShown: shown('conditionIfWrapper'), runShown: shown('conditionRunWrapper'),
      word: document.querySelector('label[for="conditionType"]').textContent,
    });
    startEdit(${condIndex}, ${JSON.stringify(fixtures.find((a) => a.type === 'condition'))});
    const asCondition = read();
    const typeSel = document.getElementById('manualActionType');
    typeSel.value = 'assert';
    typeSel.dispatchEvent(new Event('change'));
    const switched = read();
    const draft = collectManualFormState();
    clearEditState();
    applyManualFormState(draft);
    const restored = read();
    clearEditState();
    return { asCondition, switched, restored };
  })()`);
  const { asCondition: ac, switched: sw, restored: rs } = asAssert;
  check(ac.runShown && ac.word === 'If' && sw.type === 'assert' && sw.ifShown && !sw.runShown && sw.word === 'Expect'
    && sw.check === ac.check && sw.value === ac.value && sw.selector === ac.selector,
  'Condition → Assert keeps the check, its value and the selector, and leaves out "Then run"', asAssert);
  check(JSON.stringify(rs) === JSON.stringify(sw), 'a draft brings an Assert back as it was', asAssert);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

async function checkHighlight(ctx) {
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

async function checkImportWarning(ctx) {
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

async function checkConditionChoice(ctx) {
  await reloadTestPage(ctx);
  const shots = ctx.browser.downloads().length;
  const id = await makeScenario(ctx, 'e2e condition choice', [
    // Full XPath finds the hidden #menu, CSS the visible #choiceA; CSS was chosen.
    { type: 'condition', conditionType: 'elementVisible', skipCount: 1, selector: '#choiceA',
      selectors: { fullXpath: '//*[@id="menu"]', css: '#choiceA' }, selectorType: 'css', delay: 0 },
    { type: 'click', selector: '#choiceB', selectors: { css: '#choiceB' }, delay: 0 },
    // A Name typed in the form: { name } only.
    { type: 'condition', conditionType: 'elementExists', skipCount: 1, selector: 'nick',
      selectors: { name: 'nick' }, selectorType: 'name', delay: 0 },
    { type: 'click', selector: '#choiceA', selectors: { css: '#choiceA' }, delay: 0 },
    { type: 'screenshot_element', selector: 'nick', selectors: { name: 'nick' }, selectorType: 'name', delay: 0 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked.join() === 'choiceB,choiceA', 'a Condition checks the element of the selector type chosen, a typed Name too', clicked);
  check(!r.timedOut && ctx.browser.downloads().length === shots + 1, 'an element screenshot finds its element by a typed Name',
    { timedOut: r.timedOut, saved: ctx.browser.downloads().length - shots });
}

/** Width and height of a PNG file, from its IHDR chunk. */
function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function checkCdpTargets(ctx) {
  const marks = () => ctx.web.evaluate(`document.querySelectorAll('[data-pqa-target]').length`);
  // Each its own run: one that fails stops on the prompt, and must not hide the others.
  const playOne = async (name, action) => { await reloadTestPage(ctx); return play(ctx, await makeScenario(ctx, name, [action])); };

  const here = fileURLToPath(import.meta.url);
  // Known only by an XPath typed in the form: CDP was handed it as CSS.
  const up = await playOne('e2e cdp upload', { type: 'uploadFile', selector: '//input[@id="upload"]',
    selectors: { xpath: '//input[@id="upload"]' }, selectorType: 'xpath', folderPath: dirname(here), fileNames: [basename(here)], delay: 0 });
  const files = await ctx.web.evaluate(`document.getElementById('upload').files.length`);
  check(files === 1 && !up.timedOut && await marks() === 0, 'Upload File finds its input by an XPath typed in the form', { files, timedOut: up.timedOut });

  // A Name typed in the form: CDP looked for a <ddtrigger> tag.
  const dd = await playOne('e2e cdp dropdown', { type: 'dropdown', selector: 'ddtrigger', selectors: { name: 'ddtrigger' }, selectorType: 'name', delay: 300 });
  check(dd.log.includes('dd open') && await marks() === 0, 'a Dropdown opens by a Name typed in the form', dd.log);

  // Full XPath on the whole table, CSS on one button; CSS was chosen.
  const shots = ctx.browser.downloads();
  const shot = await playOne('e2e cdp element shot', { type: 'screenshot_element', selector: '#bg1',
    selectors: { fullXpath: '//*[@id="people"]', css: '#bg1' }, selectorType: 'css', delay: 0 });
  const bg1 = await ctx.web.evaluate(`(({ width, height }) => ({ width, height }))(document.getElementById('bg1').getBoundingClientRect())`);
  const added = ctx.browser.downloads().filter((f) => !shots.includes(f));
  const size = added.length === 1 ? pngSize(join(ctx.browser.downloadDir, added[0])) : null;
  check(!!size && Math.abs(size.width - bg1.width) <= 2 && Math.abs(size.height - bg1.height) <= 2 && await marks() === 0,
    'an element screenshot captures the element of the chosen selector type', { size, bg1, added, timedOut: shot.timedOut });
}

// The CDP steps — Upload File, a drop zone, opening a Dropdown, an element screenshot —
// on elements inside a frame of the page's origin; and the error from one of another origin.
async function checkCdpFrames(ctx) {
  const here = fileURLToPath(import.meta.url);
  const files = { folderPath: dirname(here), fileNames: [basename(here)] };
  const runOn = async (key, actions, xo = false) => {
    await ctx.web.goto(`${ctx.base}/export?run=${key}${xo ? '&xo=1' : ''}`);
    await sleep(PAGE_SETTLE_MS * (xo ? 2 : 1));
    const frameId = await ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
      { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.href },
      (r) => res((r || []).find((f) => f.result.includes(${JSON.stringify(xo ? 'localhost' : '/frame')}))?.frameId ?? null)))`);
    const id = await makeScenario(ctx, `e2e ${key}`, actions.map((a) => ({ ...a, frameId, delay: 0 })));
    return { played: await play(ctx, id), marks: () => exportStates.get(key)?.state?.marks || [] };
  };

  const up = await runOn('cdp-frame-upload', [
    { type: 'uploadFile', selector: '#fFiles', selectors: { css: '#fFiles' }, uploadMode: 'input', ...files },
    { type: 'uploadFile', selector: '#fZone', selectors: { css: '#fZone' }, uploadMode: 'dropzone', ...files },
  ]);
  const name = basename(here);
  check(up.marks().includes(`frame files ${name}`) && up.marks().includes(`frame zone ${name}`) && !up.played.timedOut,
    'Upload File into a file input and onto a drop zone inside a frame', up.marks());

  const dd = await runOn('cdp-frame-dropdown', [
    { type: 'dropdown', selector: '#fDd', selectors: { css: '#fDd' }, pick: { by: 'index', index: '2', itemSelector: '#fMenu li' } },
  ]);
  check(dd.marks().includes('frame dd trusted') && dd.marks().includes('frame picked fb') && !dd.played.timedOut,
    'a Dropdown inside a frame opens with a trusted click, and item #2 is chosen', dd.marks());

  const before = ctx.browser.downloads();
  const shot = await runOn('cdp-frame-shot', [{ type: 'screenshot_element', selector: '#fShot', selectors: { css: '#fShot' } }]);
  const added = ctx.browser.downloads().filter((f) => !before.includes(f));
  const size = added.length === 1 ? pngSize(join(ctx.browser.downloadDir, added[0])) : null;
  check(!!size && Math.abs(size.width - 57) <= 2 && Math.abs(size.height - 23) <= 2 && !shot.played.timedOut,
    'an element screenshot inside a frame captures that element', { size, added });

  // Another origin: the frame's content script finds it, CDP cannot reach it — said so.
  await ctx.web.goto(`${ctx.base}/export?run=cdp-frame-xo&xo=1`);
  await sleep(PAGE_SETTLE_MS * 2);
  const frameId = await ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
    { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.href },
    (r) => res((r || []).find((f) => f.result.includes('localhost'))?.frameId ?? null)))`);
  const xo = await makeScenario(ctx, 'e2e cdp-frame-xo', [{ type: 'uploadFile', selector: '#fFiles', selectors: { css: '#fFiles' },
    uploadMode: 'input', ...files, frameId, delay: 0 }]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: xo });
  const prompt = await pageSoon(ctx, `document.getElementById('__action_failed_prompt')?.textContent || null`, 20_000);
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(frameId != null && !!prompt?.includes('another origin'), 'Upload File in a frame of another origin says why it cannot', { frameId, prompt });
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

/** The scenario's own "Click through" flag, written straight into storage. */
async function setScenarioClickThrough(ctx, id, allowed) {
  await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('scenarios', ({ scenarios }) => {
    if (${allowed}) delete scenarios[${JSON.stringify(id)}].clickThrough;
    else scenarios[${JSON.stringify(id)}].clickThrough = false;
    chrome.storage.local.set({ scenarios }, r);
  }))`);
}

async function checkClickThrough(ctx) {
  const click = (id, extra = {}) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` }, delay: 0, ...extra });
  /** The failure prompt's text for a one-action run, '' when the action passes. */
  const failureOf = async (name, action, { scenarioOff = false, shadow = false } = {}) => {
    await ctx.web.goto(`${ctx.base}/page${shadow ? '?shadow' : ''}`);
    await sleep(PAGE_SETTLE_MS);
    const id = await makeScenario(ctx, name, [action]);
    if (scenarioOff) await setScenarioClickThrough(ctx, id, false);
    await ctx.web.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
    let text = '';
    for (let waited = 0; !text && waited < 8_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
      if (!text && waited > 2_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
    }
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await sleep(SETTLE_MS);
    return text;
  };

  check(await failureOf('e2e ct default', click('ctCovered')) === '' && (await ctx.web.evaluate('__log')).includes('ctCovered'),
    'Click through on (the default): a covered button is clicked as before');
  const off = [
    ['disabled', click('ctDisabled'), /Element is disabled/],
    ['covered', click('ctCovered'), /covered by span#ctCover/],
    ['read-only', { type: 'input', selector: '#ctReadonly', selectors: { css: '#ctReadonly' }, value: 'x', delay: 0 }, /read-only/],
    ['hidden', { type: 'hover', selector: '#ctHidden', selectors: { css: '#ctHidden' }, delay: 0 }, /not visible/],
    ['drop target', { type: 'dragdrop', selector: '#bg1', selectors: { css: '#bg1' }, targetSelector: '#ctCovered', targetSelectors: { css: '#ctCovered' }, delay: 0 }, /Drop target: Element is covered/],
  ];
  for (const [what, action, reason] of off) {
    const text = await failureOf(`e2e ct ${what}`, action, { scenarioOff: true });
    check(reason.test(text), `Click through off for the scenario: a ${what} element fails with the reason`, text.slice(0, 160));
  }
  // The steps that act through CDP ask the page first (MARK_ELEMENT).
  const here = fileURLToPath(import.meta.url);
  const upload = (id) => ({ type: 'uploadFile', selector: `#${id}`, selectors: { css: `#${id}` },
    folderPath: dirname(here), fileNames: [basename(here)], delay: 0 });
  const dd = await failureOf('e2e ct dropdown', { type: 'dropdown', selector: '#ctCovered', selectors: { css: '#ctCovered' }, delay: 0 }, { scenarioOff: true });
  check(/covered by span#ctCover/.test(dd), 'Click through off: a covered Dropdown trigger fails, through CDP', dd.slice(0, 160));
  const disabledFile = await failureOf('e2e ct upload disabled', upload('ctFileDisabled'), { scenarioOff: true });
  check(/Element is disabled/.test(disabledFile), 'Click through off: Upload File into a disabled file input fails', disabledFile.slice(0, 160));
  const hiddenFile = await failureOf('e2e ct upload hidden', upload('ctFileHidden'), { scenarioOff: true });
  const hiddenFiles = await ctx.web.evaluate(`document.getElementById('ctFileHidden').files.length`);
  check(hiddenFile === '' && hiddenFiles === 1, 'Click through off: a file input hidden by CSS still gets its file', { hiddenFile: hiddenFile.slice(0, 120), hiddenFiles });

  const own = await failureOf('e2e ct action off', click('ctCovered', { clickThrough: false }));
  check(/covered by span#ctCover/.test(own), 'Click through off for the action alone: the covered button fails too', own.slice(0, 160));
  const shadow = await failureOf('e2e ct shadow', click('shadowBtn'), { scenarioOff: true, shadow: true });
  check(shadow === '', 'a button in a shadow root is not "covered" by its own host', shadow.slice(0, 160));
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

async function checkTypedText(ctx) {
  await reloadTestPage(ctx);
  // As the form saves a Text selector typed by hand: no textTag beside it.
  const id = await makeScenario(ctx, 'e2e typed text', [
    { type: 'click', selector: 'choiceA', selectors: { text: 'choiceA' }, selectorType: 'text', timeout: 2000, delay: 0 },
    { type: 'click', selector: ' choiceB ', selectors: { text: ' choiceB ' }, selectorType: 'text', timeout: 2000, delay: 0 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked.join() === 'choiceA,choiceB' && !r.timedOut, 'a Text selector typed in the form finds its element', { clicked, timedOut: r.timedOut });
}

async function checkSelectMissing(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.evaluate(`document.getElementById('sel').value = 'b'`);
  const missing = await makeScenario(ctx, 'e2e select missing', [
    { type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'zzz', delay: 0 },
  ]);
  const { prompt } = await playUntilPrompt(ctx, missing);
  const kept = await ctx.web.evaluate(`document.getElementById('sel').value`);
  check(prompt && kept === 'b', 'an Input of an option the <select> does not have fails, and leaves its choice alone', { prompt, kept });
  const present = await makeScenario(ctx, 'e2e select present', [
    { type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'c', delay: 0 },
  ]);
  const r = await play(ctx, present);
  check(r.sel === 'c' && !r.timedOut, 'an option it has is still chosen', r);
}

async function checkExportFileName(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập "admin"', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // The download's name, and whether its blob can still be read once the browser gets to it.
    await popup.evaluate(`(() => {
      window.__dl = [];
      HTMLAnchorElement.prototype.click = function () {
        const entry = { name: this.download };
        window.__dl.push(entry);
        setTimeout(() => fetch(this.href).then((r) => r.text()).then((t) => { entry.bytes = t.length; }, () => { entry.bytes = 0; }), 50);
      };
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(`document.getElementById('exportDownload').click()`);
    await sleep(SETTLE_MS);
    const dl = await popup.evaluate('window.__dl[0] || null');
    check(dl?.name === 'đăng_nhập__admin__selenium.py' && dl.bytes > 0,
      'an exported file keeps the letters of the scenario name, and holds the code', dl);
  } finally {
    await popup.close();
  }
}

// The Robot export with a data file: Download saves the test and the DataDriver
// reader beside it, both for real — a page's second download is held back by the
// browser, so the reader goes through chrome.downloads. A .py file waits for the
// browser's "Keep" (as the Selenium export's does), so it is seen in the
// download list, not yet on disk.
async function checkExportRobotData(ctx) {
  const id = await makeScenario(ctx, 'rf data', [{ type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${who}' }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportRobot').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(`(() => {
      const f = document.getElementById('exportRfData');
      f.value = 'people.csv';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const code = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(/^Library {13}DataDriver {4}file=people\.csv {4}reader_class=pqa_csv_reader\.py$/m.test(code),
      'the Robot code follows the Data file setting', code.split('\n').filter((l) => l.includes('DataDriver')));
    await popup.evaluate(`document.getElementById('exportDownload').click()`);
    let names = [];
    for (let waited = 0; names.length < 2 && waited < 5_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      names = await popup.evaluate(`new Promise((res) => chrome.downloads.search({}, (items) =>
        res(items.map((i) => i.filename.split(/[\\\\/]/).pop()).filter((n) => /^(rf_data\\.robot|pqa_csv_reader\\.py)$/.test(n)))))`);
    }
    check(names.includes('rf_data.robot') && names.includes('pqa_csv_reader.py'),
      'Download saves the .robot file and pqa_csv_reader.py beside it', names);
  } finally {
    await popup.close();
  }
}

/**
 * The 11 steps the export modal is checked with (tasks/plan-6): named steps, a
 * Condition, a script, a full-page screenshot and an upload the bookmarklet
 * leaves out. With the variable pass-word saved, the exports note its new name.
 * A value is markup, which the code box must show as text.
 */
const EXPORT_SAMPLE = [
  { type: 'navigate', url: 'https://shop.test/login' },
  { type: 'input', selector: '#user', selectors: { css: '#user' }, value: 'alice<img src=x onerror="window.__xss=1">', label: 'Username' },
  { type: 'input', selector: '#pass', selectors: { css: '#pass' }, value: '${pass-word}' },
  { type: 'click', selector: '#login', selectors: { css: '#login' }, label: 'Sign in' },
  { type: 'condition', conditionType: 'elementExists', selector: '.welcome', selectors: { css: '.welcome' } },
  { type: 'click', selector: '.welcome', selectors: { css: '.welcome' } },
  { type: 'script', code: 'console.log(1)' },
  { type: 'readdom', selector: '#total', selectors: { css: '#total' }, varName: 'total' },
  { type: 'screenshot_full' },
  { type: 'uploadFile', selector: '#upload', selectors: { css: '#upload' }, folderPath: 'C:\\in', fileNames: ['a.txt'] },
  { type: 'click', selector: '#logout', selectors: { css: '#logout' } },
];

/** In `popup`, pick scenario `id` in the Export Code card and open `button`'s export. */
async function openExport(popup, id, button) {
  await popup.evaluate(`(() => {
    const s = document.getElementById('exportCodeSelect');
    s.value = ${JSON.stringify(id)};
    s.dispatchEvent(new Event('change'));
    document.getElementById(${JSON.stringify(button)}).click();
  })()`);
  await sleep(POPUP_SETTLE_MS);
}

async function checkExportSteps(ctx) {
  const id = await makeScenario(ctx, 'e2e export steps', [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'uploadFile', selector: '#upload', selectors: { css: '#upload' }, folderPath: 'C:\\in', fileNames: ['a.txt'] },
  ]);
  const sample = await makeScenario(ctx, 'e2e export sample', EXPORT_SAMPLE);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
    })()`);
    for (const [button, skipped] of [['exportSelenium', false], ['exportBookmarklet', true]]) {
      await popup.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
      await sleep(POPUP_SETTLE_MS);
      const tab = await popup.evaluate(`({
        rows: [...document.querySelectorAll('#exportActList .export-bm-action-status')].map((el) => el.textContent.trim()),
        skipped: document.getElementById('exportSub').textContent.match(/\\d+ skipped/)?.[0] || null,
        warning: document.getElementById('exportWarning').hidden ? '' : document.getElementById('exportWarningText').textContent,
        notices: document.getElementById('exportActSummary').textContent,
      })`);
      const said = skipped
        ? JSON.stringify(tab.rows) === '["✓ OK","— Skip"]' && tab.skipped === '1 skipped' && tab.warning === '1 skipped — see Actions'
          && /Step 2 — a bookmarklet cannot read local files/.test(tab.notices)
        : JSON.stringify(tab.rows) === '["✓ OK","✓ OK"]' && tab.skipped === null && tab.warning === '';
      check(said, `${button}: the Actions tab, the header and the warning bar say whether Upload File is exported`, tab);
      await popup.evaluate(`document.getElementById('exportClose').click()`);
    }

    // What each row and the header say about the sample.
    await openExport(popup, sample, 'exportBookmarklet');
    const shown = await popup.evaluate(`({
      sub: document.getElementById('exportSub').textContent,
      rows: [...document.querySelectorAll('#exportActList .export-bm-action-row')].map((r) => ({
        type: r.querySelector('.export-bm-action-type').textContent.trim(),
        label: r.querySelector('.export-bm-action-label')?.textContent || '',
        desc: r.querySelector('.export-bm-action-desc').textContent.trim() })),
    })`);
    const row = (n) => shown.rows[n - 1] || {};
    check(shown.sub === 'e2e_export_sample_bookmarklet.js · 11 steps · 2 skipped',
      'the header counts every step and the skipped ones, as the Actions tab lists them', shown.sub);
    check(row(9).desc === 'full page' && row(10).type === '📎 upload' && row(5).desc === 'elementExists · .welcome',
      'a full-page screenshot says so, Upload File has its badge, a Condition names its element', [row(5), row(9), row(10)]);
    check(row(4).label === 'Sign in' && row(4).desc === 'Sign in #login' && row(3).label === '',
      'a named step reads by its name, its selector after it', [row(3), row(4)]);
  } finally {
    await popup.close();
  }
}

async function checkExportRegenerate(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { used: 'u', unused: 'x' } });
  const id = await makeScenario(ctx, 'e2e export regenerate', [
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${used}' },
  ]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
    })()`);
    let added = 0;
    for (const button of ['exportSelenium', 'exportBookmarklet']) {
      await popup.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
      await sleep(POPUP_SETTLE_MS);
      // The scenario changes while the modal is open; Reload scenario has to show it.
      const marker = `regen${++added}`;
      await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id,
        action: { type: 'click', selector: `#${marker}`, selectors: { css: `#${marker}` } } });
      await popup.evaluate(`document.getElementById('exportReload').click()`);
      await sleep(POPUP_SETTLE_MS);
      const shown = await popup.evaluate(`({
        vars: [...document.querySelectorAll('#exportVarList .export-bm-var-name')].map((el) => el.textContent),
        code: document.querySelector('#exportCode code').textContent,
      })`);
      check(JSON.stringify(shown.vars) === '["${used}"]' && shown.code.includes(`#${marker}`) && !/\bunused\b/.test(shown.code),
        `${button}: Reload scenario reads the scenario again and keeps to the variables it uses`,
        { vars: shown.vars, hasNewStep: shown.code.includes(`#${marker}`), declaresUnused: /\bunused\b/.test(shown.code) });
      await popup.evaluate(`document.getElementById('exportClose').click()`);
    }
  } finally {
    await popup.close();
  }
}

async function checkExportHeadless(ctx) {
  const id = await makeScenario(ctx, 'e2e export headless', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    const code = () => popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    // A click on the row's text flips the switch, as on any switch row; the code follows.
    await popup.evaluate(`document.querySelector('#exportSeleniumHeadlessRow .export-bm-setting-label').click()`);
    await sleep(SETTLE_MS);
    const on = await code();
    // The exported browser and window are what _start_browser falls back on.
    check(/os\.environ\.get\("PQA_BROWSER", "Chrome"\)\n {4}headless = os\.environ\.get\("PQA_HEADLESS", "1"\) == "1"/.test(on),
      'Headless on: the script starts Chrome without a window', on.split('\n').filter((l) => /PQA_BROWSER|PQA_HEADLESS/.test(l)));
    await popup.evaluate(`(() => {
      const d = document.getElementById('exportSeleniumDriver');
      d.value = 'Safari';
      d.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const box = await popup.evaluate(`(({ checked, disabled }) => ({ checked, disabled }))(document.getElementById('exportSeleniumHeadless'))`);
    const safari = await code();
    check(!box.checked && box.disabled && /os\.environ\.get\("PQA_BROWSER", "Safari"\)\n {4}headless = os\.environ\.get\("PQA_HEADLESS", "0"\)/.test(safari),
      'Safari: Headless is off and cannot be turned on', box);
  } finally {
    await popup.close();
  }
}

async function checkExportStartUrl(ctx) {
  const id = await makeScenario(ctx, 'e2e export start url', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // The popup here is a tab of its own, so the active tab is the page under test as it
    // is over a real popup, and it answers a moment later, as chrome.tabs.query does.
    await popup.evaluate(`(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => (q?.active ? setTimeout(() => cb([{ url: 'https://shop.test/start' }]), 50) : query(q, cb));
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const shown = await popup.evaluate(`({
      field: document.getElementById('exportSeleniumStartUrl').value,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.field === 'https://shop.test/start' && shown.code.includes('driver.get(_url("https://shop.test/start"))') && !shown.code.includes('your-url-here'),
      'Selenium: the start URL taken from the tab is in the code the modal first shows',
      { field: shown.field, get: shown.code.split('\n').filter((l) => l.includes('driver.get')) });

    // Playwright the same way, the badge saying where it came from; 🔄 takes the tab's URL again.
    await popup.evaluate(`document.getElementById('exportClose').click(); document.getElementById('exportPlaywright').click()`);
    await sleep(POPUP_SETTLE_MS);
    const pw = () => popup.evaluate(`({
      field: document.getElementById('exportPwStartUrl').value,
      badge: document.getElementById('exportPwUrlFromTab').style.display !== 'none',
      code: document.querySelector('#exportCode code').textContent,
    })`);
    const first = await pw();
    check(first.field === 'https://shop.test/start' && first.badge && first.code.includes('await page.goto(_url("https://shop.test/start"));'),
      'Playwright: the start URL is taken from the tab too, and the badge says so', { field: first.field, badge: first.badge });
    await popup.evaluate(`(() => {
      const query = chrome.tabs.query;
      chrome.tabs.query = (q, cb) => (q?.active ? setTimeout(() => cb([{ url: 'https://shop.test/other' }]), 50) : query(q, cb));
      document.getElementById('exportPwGetUrl').click();
    })()`);
    await sleep(SETTLE_MS);
    const again = await pw();
    check(again.field === 'https://shop.test/other' && again.code.includes('await page.goto(_url("https://shop.test/other"));'),
      'Playwright: 🔄 takes the tab\'s URL again, and the code follows', { field: again.field });
  } finally {
    await popup.close();
  }
}

async function checkExportUrlField(ctx) {
  const id = await makeScenario(ctx, 'e2e export url field', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    const NAMES = { exportSelenium: 'Selenium', exportPlaywright: 'Playwright', exportRobot: 'Robot', exportJava: 'Java' };
    for (const [button, field] of [['exportSelenium', 'exportSeleniumStartUrl'], ['exportPlaywright', 'exportPwStartUrl'], ['exportRobot', 'exportRfStartUrl'],
      ['exportJava', 'exportJavaStartUrl']]) {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      await popup.evaluate(`document.querySelector('#exportModal .export-bm-tab[data-tab="settings"]').click()`);
      await sleep(SETTLE_MS);
      const box = await popup.evaluate(`(() => {
        const f = document.getElementById(${JSON.stringify(field)});
        const row = f.closest('.export-bm-setting-row');
        return { field: Math.round(f.getBoundingClientRect().width), row: Math.round(row.getBoundingClientRect().width),
          align: getComputedStyle(f).textAlign };
      })()`);
      // The row's width less its padding and the 🔄 button: a URL is read from its start.
      check(box.field >= box.row - 80 && box.align !== 'right',
        `${NAMES[button]}: the Starting URL field spans its row, the URL read from its start`, box);
      await popup.evaluate(`document.getElementById('exportClose').click()`);
      await sleep(SETTLE_MS);
    }
  } finally {
    await popup.close();
  }
}

async function checkExportOutput(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập pytest', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const dataRow = () => popup.evaluate(`getComputedStyle(document.getElementById('exportSeleniumDataRow')).display !== 'none'`);
    const scriptRow = await dataRow();
    await popup.evaluate(`(() => {
      const o = document.getElementById('exportSeleniumOutput');
      o.value = 'pytest';
      o.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const shown = await popup.evaluate(`({
      label: document.getElementById('exportCodeLabel').textContent,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.label === 'test_đăng_nhập_pytest.py' && /^import pytest$/m.test(shown.code) && /^def test_dang_nhap_pytest\(browser\):$/m.test(shown.code),
      'Output pytest: a test_….py file pytest finds, with a test function', { label: shown.label });
    // The data file is pytest's: its field shows only then, and the code follows what is typed in it.
    await popup.evaluate(`(() => { const f = document.getElementById('exportSeleniumData'); f.value = 'data.csv';
      f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(SETTLE_MS);
    const withData = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(!scriptRow && await dataRow() && /^@pytest\.mark\.parametrize\("_row", _rows\("data\.csv"\)\)$/m.test(withData),
      'Output pytest: the Data file (CSV) field shows, and a file named there gives a test per row', { scriptRow });
  } finally {
    await popup.close();
  }
}

async function checkExportSettings(ctx) {
  const id = await makeScenario(ctx, 'e2e export settings', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  // Open the popup, pick the scenario, open `button`'s export, run `then`, close the popup.
  const withModal = async (button, then) => {
    const popup = await openPopup(ctx);
    try {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      return await then(popup);
    } finally {
      await popup.close();
    }
  };
  const set = (popup, values) => popup.evaluate(`(() => {
    for (const [id, v] of Object.entries(${JSON.stringify(values)})) {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
      el.dispatchEvent(new Event('change'));
    }
  })()`);
  const read = (popup, ids) => popup.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => {
    const el = document.getElementById(id);
    return [id, el.type === 'checkbox' ? el.checked : el.value];
  }))`);
  const PY = ['exportSeleniumElTimeout', 'exportSeleniumDriver', 'exportSeleniumHeadless', 'exportSeleniumOutput'];

  await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
  await withModal('exportSelenium', (p) => set(p, { exportSeleniumElTimeout: '4321', exportSeleniumDriver: 'Firefox',
    exportSeleniumHeadless: true, exportSeleniumOutput: 'pytest' }));
  await withModal('exportBookmarklet', (p) => set(p, { exportBmElTimeout: '2222' }));
  const py = await withModal('exportSelenium', async (p) => ({ ...await read(p, PY),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(py.exportSeleniumElTimeout === '4321' && py.exportSeleniumDriver === 'Firefox' && py.exportSeleniumHeadless === true
    && py.exportSeleniumOutput === 'pytest' && /os\.environ\.get\("PQA_BROWSER", "Firefox"\)/.test(py.code) && /_find\(\[.*\], 4\.321, clickable=True\)/.test(py.code),
    'the Selenium Settings come back in a new popup, and the code is made with them', { ...py, code: undefined });
  const js = await withModal('exportBookmarklet', (p) => read(p, ['exportBmElTimeout', 'exportBmStepDelay']));
  check(js.exportBmElTimeout === '2222' && js.exportBmStepDelay === '300', 'the JS Settings come back, untouched by the Selenium ones', js);
  const RF = ['exportRfElTimeout', 'exportRfBrowser', 'exportRfHeadless', 'exportRfStepDelay'];
  await withModal('exportRobot', (p) => set(p, { exportRfElTimeout: '4321', exportRfBrowser: 'Firefox', exportRfHeadless: true, exportRfStepDelay: '0' }));
  const rf = await withModal('exportRobot', async (p) => ({ ...await read(p, RF),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(rf.exportRfElTimeout === '4321' && rf.exportRfBrowser === 'Firefox' && rf.exportRfHeadless === true && rf.exportRfStepDelay === '0'
    && /^\$\{PQA_TIMEOUT\} +\$\{4\.321\}$/m.test(rf.code) && /^\$\{PQA_BROWSER\} +Firefox$/m.test(rf.code) && /^\$\{PQA_HEADLESS\} +1$/m.test(rf.code),
    'the Robot Settings come back in a new popup, and the code is made with them', { ...rf, code: undefined });
  const JAVA = ['exportJavaElTimeout', 'exportJavaDriver', 'exportJavaHeadless', 'exportJavaStepDelay'];
  await withModal('exportJava', (p) => set(p, { exportJavaElTimeout: '4321', exportJavaDriver: 'Firefox', exportJavaHeadless: true, exportJavaStepDelay: '0' }));
  const java = await withModal('exportJava', async (p) => ({ ...await read(p, JAVA),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(java.exportJavaElTimeout === '4321' && java.exportJavaDriver === 'Firefox' && java.exportJavaHeadless === true && java.exportJavaStepDelay === '0'
    && java.code.includes('Duration.ofMillis(4321)') && java.code.includes('BROWSER = "Firefox"') && java.code.includes('HEADLESS = "1"'),
    'the Java Settings come back in a new popup, and the code is made with them', { ...java, code: undefined });

  // Headless on, then Safari: Headless was kept on; Safari, put back first, turns it off again.
  await withModal('exportSelenium', (p) => set(p, { exportSeleniumHeadless: true, exportSeleniumDriver: 'Safari' }));
  const safari = await withModal('exportSelenium', (p) => p.evaluate(`(({ checked, disabled }) => ({ checked, disabled,
    driver: document.getElementById('exportSeleniumDriver').value }))(document.getElementById('exportSeleniumHeadless'))`));
  check(safari.driver === 'Safari' && !safari.checked && safari.disabled, 'Safari comes back with Headless off', safari);

  // Wrap: turned on in one popup, still on in the next, for another format too.
  const wrapOf = (p) => p.evaluate(`({ pressed: document.getElementById('exportWrapBtn').getAttribute('aria-pressed'),
    wraps: getComputedStyle(document.getElementById('exportCode')).whiteSpace })`);
  const turnedOn = await withModal('exportSelenium', async (p) => {
    await p.evaluate(`document.getElementById('exportWrapBtn').click()`);
    return wrapOf(p);
  });
  const kept = await withModal('exportBookmarklet', wrapOf);
  check(turnedOn.pressed === 'true' && turnedOn.wraps === 'pre-wrap' && kept.pressed === 'true' && kept.wraps === 'pre-wrap',
    'wrap shows it is on, and is still on in a new popup', { turnedOn, kept });

  // Broken or stale storage: the defaults, not the bad values.
  await ctx.ext.evaluate(`chrome.storage.local.set({ exportCodeSettings: { py: { exportSeleniumDriver: 'Opera',
    exportSeleniumElTimeout: 'abc', exportSeleniumHeadless: 'yes' }, js: 'garbage' } })`);
  const bad = await withModal('exportSelenium', (p) => read(p, PY));
  check(bad.exportSeleniumDriver === 'Chrome' && bad.exportSeleniumElTimeout === '10000' && bad.exportSeleniumHeadless === false,
    'a stored value an input cannot take leaves its default', bad);
  await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
}

async function checkExportLiveSettings(ctx) {
  const id = await makeScenario(ctx, 'e2e export live', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ exportCodeSettings: { py: { exportSeleniumOutput: 'pytest', exportSeleniumStepDelay: '700' } } })`);
  const popup = await openPopup(ctx);
  try {
    // Every time the code is shown, and what Copy put on the clipboard.
    await popup.evaluate(`(() => {
      window.__renders = 0;
      new MutationObserver((records) => { window.__renders += records.length; })
        .observe(document.querySelector('#exportCode code'), { childList: true });
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const opened = await popup.evaluate(`({ renders: window.__renders, label: document.getElementById('exportCodeLabel').textContent,
      code: document.querySelector('#exportCode code').textContent })`);
    check(opened.renders === 1 && opened.label === 'test_e2e_export_live.py' && opened.code.includes('time.sleep(0.7)'),
      'opening with remembered Settings shows code made with them, generated once', { ...opened, code: undefined });

    // A change, then Copy at once, nothing else pressed: the clipboard has the code made with it.
    const thenCopy = (js) => popup.evaluate(`(() => {
      ${js}
      document.getElementById('exportCopy').click();
      return { copied: window.__copied.at(-1) || '', label: document.getElementById('exportCodeLabel').textContent };
    })()`);
    const pick = (id, value) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true })); })();`;
    const headless = await thenCopy(`document.querySelector('#exportSeleniumHeadlessRow .export-bm-setting-label').click();`);
    check(headless.copied.includes('os.environ.get("PQA_HEADLESS", "1")'), 'Headless switched on: Copy takes the headless code', headless.label);
    const driver = await thenCopy(pick('exportSeleniumDriver', 'Firefox'));
    check(driver.copied.includes('os.environ.get("PQA_BROWSER", "Firefox")'), 'WebDriver Firefox: Copy takes the Firefox code', driver.label);
    const output = await thenCopy(pick('exportSeleniumOutput', 'script'));
    check(output.label === 'e2e_export_live_selenium.py' && !/^import pytest$/m.test(output.copied),
      'Output Script: the file name and the code follow', output.label);
    // Typing: the code follows once it pauses; leaving the field (change) at once.
    await popup.evaluate(`(() => { const el = document.getElementById('exportSeleniumStepDelay'); el.value = '1234';
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(SETTLE_MS * 2);
    const typed = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(typed.includes('time.sleep(1.234)'), 'a delay typed in is in the code once typing pauses', typed.match(/time\.sleep\([^)]*\)/)?.[0]);
    const left = await thenCopy(`(() => { const el = document.getElementById('exportSeleniumStepDelay'); el.value = '2345';
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })();`);
    check(left.copied.includes('time.sleep(2.345)'), 'a delay typed in, then Copy: the clipboard has it', left.copied.match(/time\.sleep\([^)]*\)/)?.[0]);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
  }
}

// An element's box in `page`, rounded.
const boxOf = (page, selector) => page.evaluate(`(() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height), bottom: Math.round(r.bottom) };
})()`);

const showExportTab = (page, tab) => page.evaluate(`document.querySelector('#exportModal .export-bm-tab[data-tab="${tab}"]').click()`);

async function checkExportLayout(ctx) {
  const plain = await makeScenario(ctx, 'e2e export layout', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const sample = await makeScenario(ctx, 'e2e export layout sample', EXPORT_SAMPLE);
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { 'pass-word': 'secret' } });
  // A real popup is at most 600 px tall.
  const tall = await openPopup(ctx, { width: 480, height: 600 });
  try {
    await openExport(tall, plain, 'exportSelenium');
    const code = await boxOf(tall, '#exportCode');
    check(code.height >= 400, 'at 480 × 600, Selenium with nothing to warn about: the code is at least 400 px tall', code);
    const copy = [];
    const shown = [];
    for (const tab of ['variables', 'actions', 'settings', 'preview']) {
      await showExportTab(tall, tab);
      copy.push(await boxOf(tall, '#exportCopy'));
      shown.push(await tall.evaluate(`[...document.querySelectorAll('#exportModal .export-bm-tab-panel')]
        .filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.id).join()`));
    }
    check(copy.every((c) => c.top === copy[0].top && c.left === copy[0].left), 'Copy stays where it is through the four tabs', copy);
    check(shown.join(' ') === 'exportTabVariables exportTabActions exportTabSettings exportTabPreview', 'each tab shows its panel alone', shown);

    // The bookmarklet of the sample: four reasons and a note, counted in one line over the code.
    await tall.evaluate(`document.getElementById('exportClose').click()`);
    await openExport(tall, sample, 'exportBookmarklet');
    const bar = await boxOf(tall, '#exportWarning');
    const bmCode = await boxOf(tall, '#exportCode');
    check(bar.height <= 32 && bmCode.height >= 360, 'the bookmarklet\'s warnings take one line; the code keeps at least 360 px',
      { bar: bar.height, code: bmCode.height });
    await tall.evaluate(`document.getElementById('exportWarning').click()`);
    const listed = await tall.evaluate(`({
      actions: !document.getElementById('exportTabActions').hidden,
      bar: document.getElementById('exportWarningText').textContent,
      groups: [...document.querySelectorAll('#exportActSummary .export-bm-notice-group')]
        .map((g) => [g.querySelector('.export-bm-notice-title').textContent, ...[...g.querySelectorAll('li')].map((li) => li.textContent)]),
    })`);
    const [check2, skip2, notes] = listed.groups;
    check(listed.actions && listed.bar === '2 to check · 2 skipped · 1 note — see Actions'
      && check2?.[0] === 'To check' && check2.length === 3 && check2[2].startsWith('Step 7 — custom JS')
      && skip2?.[0] === 'Skipped' && skip2.length === 3 && notes?.[0] === 'Notes' && /pass_word/.test(notes[1]),
      'a click on the bar opens Actions, which lists the four reasons and the note', listed);
  } finally {
    await tall.close();
  }
  const short = await openPopup(ctx, { width: 480, height: 500 });
  try {
    await openExport(short, sample, 'exportSelenium');
    const code = await boxOf(short, '#exportCode');
    await showExportTab(short, 'settings');
    const fit = await short.evaluate(`(() => {
      const panel = document.getElementById('exportTabSettings');
      panel.scrollTop = panel.scrollHeight;
      const last = document.getElementById('exportReload').getBoundingClientRect();
      return { footer: Math.round(document.querySelector('.export-bm-footer').getBoundingClientRect().bottom), view: innerHeight,
        last: Math.round(last.bottom), panel: Math.round(panel.getBoundingClientRect().bottom) };
    })()`);
    check(code.height >= 150 && fit.footer <= fit.view && fit.last <= fit.panel,
      'at 480 × 500 the code, the footer and, scrolled, the last of the Settings all show', { code: code.height, ...fit });
  } finally {
    await short.close();
  }
}

/** A real key press on the focused element of `page`. */
async function pressKey(page, key, code, keyCode, text) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

async function checkExportJump(ctx) {
  const sample = await makeScenario(ctx, 'e2e export jump', EXPORT_SAMPLE);
  const popup = await openPopup(ctx, { width: 480, height: 600 });
  try {
    await openExport(popup, sample, 'exportSelenium');
    // The line that opens step n: its text, whether the code box shows it, whether it is tinted.
    const stepLine = (n) => popup.evaluate(`(() => {
      const pre = document.getElementById('exportCode');
      const line = pre.querySelector('.export-bm-line[data-step="${n}"]');
      const p = pre.getBoundingClientRect(), r = line.getBoundingClientRect();
      return { text: line.textContent, inView: r.top >= p.top && r.bottom <= p.bottom, scrollTop: Math.round(pre.scrollTop),
        tinted: line.classList.contains('export-bm-line-flash') && getComputedStyle(line).backgroundColor !== 'rgba(0, 0, 0, 0)',
        codeTab: !document.getElementById('exportTabPreview').hidden, codeFocused: document.activeElement === pre };
    })()`);
    await showExportTab(popup, 'actions');
    await popup.evaluate(`document.querySelector('#exportActList [data-step="7"]').click()`);
    await sleep(SETTLE_MS);
    const seven = await stepLine(7);
    check(seven.codeTab && seven.inView && seven.tinted && seven.scrollTop > 0 && seven.text.trim().startsWith('# Step 7:') && !seven.codeFocused,
      'a click on row 7 opens the Code tab on "# Step 7", tinted, focus left alone', seven);
    await popup.evaluate(`document.getElementById('exportStepsBtn').click()`);
    await sleep(SETTLE_MS);
    const first = await stepLine(1);
    check(first.inView && first.text.trim().startsWith('# Step 1:'), '↧ Steps shows Step 1', first);
    // By keyboard: row 10 focused, Enter.
    await showExportTab(popup, 'actions');
    await popup.evaluate(`document.querySelector('#exportActList [data-step="10"]').focus()`);
    await pressKey(popup, 'Enter', 'Enter', 13, '\r');
    await sleep(SETTLE_MS);
    const ten = await stepLine(10);
    check(ten.codeTab && ten.inView && ten.tinted && ten.codeFocused, 'Enter on row 10 shows step 10 in the code, which takes the focus', ten);
    const text = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(text.split('\n').length > 50 && /\n\s*# Step 10: /.test(text), 'the code box\'s text is still the code, line for line', text.length);
    const markup = await popup.evaluate(`({ elements: document.querySelectorAll('#exportCode img').length, xss: window.__xss ?? null,
      shown: document.querySelector('#exportCode code').textContent.includes('alice<img src=x onerror=') })`);
    check(markup.elements === 0 && markup.xss === null && markup.shown, 'a value holding <img onerror> shows as text, not as an element', markup);

    // Colours in both themes: comments, strings and keywords apart from the code's own colour, a step's comment apart too.
    const colours = () => popup.evaluate(`(() => {
      const c = (sel) => { const el = document.querySelector('#exportCode ' + sel); return el && getComputedStyle(el).color; };
      return { text: c('code'), cmt: c('.export-bm-line:not([data-step]) .tok-cmt'), str: c('.tok-str'), kw: c('.tok-kw'),
        step: c('.export-bm-line[data-step] .tok-cmt'), stepWeight: getComputedStyle(document.querySelector('#exportCode .export-bm-line[data-step] .tok-cmt')).fontWeight };
    })()`);
    for (const theme of ['light', 'dark']) {
      await popup.evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      const c = await colours();
      check(new Set([c.text, c.cmt, c.str, c.kw, c.step]).size === 5 && Number(c.stepWeight) >= 700,
        `${theme} theme: comments, strings, keywords and step comments each have a colour`, c);
    }
  } finally {
    await popup.close();
  }
}

async function checkExportFormats(ctx) {
  const id = await makeScenario(ctx, 'e2e export formats', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabData"]').click()`);
    await sleep(SETTLE_MS);
    const buttons = await popup.evaluate(`[...document.querySelectorAll('.export-code-grid > button')].map((b) => b.id)`);
    // Each one opens the modal as its own format, with the same Download button.
    const badges = [];
    const downloads = [];
    const labels = [];
    for (const button of buttons) {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      badges.push(await popup.evaluate(`document.getElementById('exportModal').classList.contains('show')
        ? document.getElementById('exportBadge').textContent : 'not open'`));
      downloads.push(await popup.evaluate(`document.getElementById('exportDownload').textContent`));
      labels.push(await popup.evaluate(`document.getElementById('exportCodeLabel').textContent`));
      await popup.evaluate(`document.getElementById('exportClose').click()`);
      await sleep(SETTLE_MS);
    }
    check(buttons.join() === 'exportBookmarklet,exportSelenium,exportPlaywright,exportRobot,exportJava' && badges.join() === 'JS,PY,PW,RF,JV',
      'The Export Code card offers the bookmarklet, Selenium, Playwright, Robot Framework and Selenium Java, each opening its own export', { buttons, badges });
    check(downloads.every((d) => d === '⬇ Download'), 'each export\'s Download button reads "⬇ Download"', downloads);
    check(labels[3] === 'e2e_export_formats.robot' && labels[4] === 'E2eExportFormatsTest.java',
      'Robot Framework opens a <name>.robot file, Selenium Java a <Name>Test.java holding that class', labels);
    // Two by two, every button the same size; the last, alone on its row, in the middle.
    const box = await popup.evaluate(`(() => {
      const grid = document.querySelector('.export-code-grid').getBoundingClientRect();
      const rs = [...document.querySelectorAll('.export-code-grid > button')].map((el) => el.getBoundingClientRect());
      const last = rs[rs.length - 1];
      return { widths: rs.map((r) => Math.round(r.width)), rows: [...new Set(rs.map((r) => Math.round(r.top)))].length,
        offCentre: last.left + last.width / 2 - (grid.left + grid.width / 2) };
    })()`);
    check(box.rows === 3 && Math.max(...box.widths) - Math.min(...box.widths) <= 1 && Math.abs(box.offCentre) <= 1,
      'the five buttons sit two by two, all one size, the last in the middle of its row', box);
  } finally {
    await popup.close();
  }
}

async function checkExportTabsKeyboard(ctx) {
  const id = await makeScenario(ctx, 'e2e export tabs', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // Opened with a real mouse click, as in the popup.
    const at = await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabData"]').click();
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      const b = document.getElementById('exportSelenium');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await popup.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await sleep(POPUP_SETTLE_MS);
    const focused = () => popup.evaluate(`(() => {
      const el = document.activeElement;
      return { tab: el.dataset.tab || el.id, ring: el.matches(':focus-visible'),
        open: document.querySelector('#exportModal .export-bm-tab[aria-selected="true"]').dataset.tab,
        shown: [...document.querySelectorAll('#exportModal [role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id).join() };
    })()`);
    const opened = await focused();
    check(opened.tab === 'preview' && !opened.ring, 'opened with the mouse: focus on the Code tab, with no ring', opened);

    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    const right = await focused();
    check(right.tab === 'actions' && right.open === 'actions' && right.shown === 'exportTabActions' && right.ring,
      '→ twice from Code: the Actions tab opens and has the (keyboard) focus', right);
    await pressKey(popup, 'End', 'End', 35);
    const end = await focused();
    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    const round = await focused();
    await pressKey(popup, 'ArrowLeft', 'ArrowLeft', 37);
    const left = await focused();
    await pressKey(popup, 'Home', 'Home', 36);
    const home = await focused();
    check(end.open === 'settings' && round.open === 'preview' && left.open === 'settings' && home.open === 'preview',
      'End, → past the last, ← past the first and Home reach the tab they should', [end.open, round.open, left.open, home.open]);

    const aria = await popup.evaluate(`[...document.querySelectorAll('#exportModal [role="tab"]')].map((t) => {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      return { tab: t.dataset.tab, tabindex: t.tabIndex, panel: panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === t.id };
    })`);
    check(aria.every((t) => t.panel) && aria.map((t) => t.tabindex).join() === '0,-1,-1,-1',
      'each tab names its panel and the panel its tab; the open tab alone is in the Tab order', aria);
  } finally {
    await popup.close();
  }
}

async function checkExportCard(ctx) {
  const click = [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }];
  const { id: folderId } = await ctx.send({ type: 'CREATE_FOLDER', name: 'e2e card folder' });
  const inFolder = await makeScenario(ctx, 'e2e card in folder', click);
  await ctx.send({ type: 'MOVE_TO_FOLDER', scenarioId: inFolder, folderId });
  const loose = await makeScenario(ctx, 'e2e card loose', click);
  // The format buttons, on or off and their titles; the scenario chosen.
  const state = (popup) => popup.evaluate(`({ value: document.getElementById('exportCodeSelect').value,
    buttons: [...document.querySelectorAll('.export-code-grid > button')].map((b) => ({ off: b.disabled, title: b.title, height: b.offsetHeight })) })`);

  await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  let popup = await openPopup(ctx);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabData"]').click()`);
    await sleep(SETTLE_MS);
    const none = await state(popup);
    check(none.value === '' && none.buttons.length === 5 && none.buttons.every((b) => b.off && b.title === 'Select a scenario first'),
      'no scenario chosen: the five format buttons are off and say why', none);
    await popup.evaluate(`(() => { const s = document.getElementById('exportCodeSelect'); s.value = ${JSON.stringify(loose)};
      s.dispatchEvent(new Event('change')); })()`);
    const chosen = await state(popup);
    check(chosen.buttons.every((b) => !b.off && b.title && b.title !== 'Select a scenario first' && b.height > 0 && b.height < 50),
      'a scenario chosen: the buttons are on, small, each titled with what it makes', chosen);
    const order = await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      const where = (id) => { const o = s.querySelector('option[value="' + id + '"]'); return o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : 'top'; };
      const kids = [...s.children].map((el) => el.tagName);
      return { inFolder: where(${JSON.stringify(inFolder)}), loose: where(${JSON.stringify(loose)}),
        looseFirst: kids.lastIndexOf('OPTION') < kids.indexOf('OPTGROUP') };
    })()`);
    check(order.inFolder === 'e2e card folder' && order.loose === 'top' && order.looseFirst,
      'the list has the scenarios in no folder first, then one group per folder', order);
  } finally {
    await popup.close();
  }

  // The scenario Manage Scenarios has selected is the card's when the card has none.
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(inFolder)} })`);
  popup = await openPopup(ctx);
  try {
    const taken = await state(popup);
    check(taken.value === inFolder && taken.buttons.every((b) => !b.off), 'the popup opens with the card on the scenario Manage Scenarios has', taken);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  }
}

async function checkExportPlaywright(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập pw', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportPlaywright').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const shown = await popup.evaluate(`({
      label: document.getElementById('exportCodeLabel').textContent,
      download: document.getElementById('exportDownload').textContent,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.label === 'đăng_nhập_pw.spec.js' && shown.download === '⬇ Download'
      && /^import \{ test \} from '@playwright\/test';$/m.test(shown.code) && shown.code.includes('test("Đăng nhập pw", async ({ page }) => {'),
      'Playwright Test opens a .spec.js with one test', { label: shown.label, download: shown.download });
  } finally {
    await popup.close();
  }
}

/**
 * The page export-run plays on, at /export?run=<key>. Whatever its form holds —
 * every input, select, textarea and contenteditable with an id (a checkbox by
 * whether it is ticked) — plus the other elements with an id clicked, the alerts
 * shown and the marks its widgets set (events a page may wait for) is POSTed
 * to /state on every change, so a run in a browser the harness does not drive
 * (the Selenium script's own Edge) is read the same way as one it does.
 * A new element with an id is in the state as soon as it is on the page.
 */
const EXPORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>export</title></head>
<body>
<input id="name">
<select id="color"><option value="">-</option><option value="r">Red</option><option value="g">Green</option></select>
<label><input type="checkbox" id="agree"> Agree</label>
<span id="code">ORD-42</span>
<input id="echo">
<button id="submit">Submit</button><button id="after">After</button><button id="never">Never</button>
<div id="people">
  <div class="row"><span id="nameAlice">Alice</span> <button id="editAlice" class="edit">Edit</button></div>
  <div class="row"><span id="nameBob">Bob <i id="tagBob">VIP</i></span> <button id="editBob" class="edit special">Edit</button></div>
  <span id="note" style="display:none">ref 7731</span>
  <span id="ownTxt">Hello<b id="ownB">x</b>World</span>
</div>
<input id="picked">
<div id="conds">
  <div id="tagged" data-id="5">tagged</div>
  <div id="fixedBox" style="position:fixed;top:0;right:0;width:40px;height:20px">fixed</div>
  <div id="ghost" style="opacity:0">ghost</div>
  <div id="note2">Note <span style="display:none">secret</span></div>
  <div id="total">  Total: 42  </div>
  <button id="c1">c1</button><button id="c2">c2</button><button id="c3">c3</button>
  <button id="c4">c4</button><button id="c5">c5</button><button id="c6">c6</button>
</div>
<div id="acts">
  <div id="mdBtn">press</div>
  <div id="hoverMenu">menu</div>
  <div id="rich" contenteditable="true" style="min-height:20px;border:1px solid"></div>
  <input id="blurField">
  <div id="dragSrc" draggable="true">drag</div><div id="dropZone" style="min-height:30px">drop here</div>
  <button id="done">done</button>
  <input type="date" id="when"><input type="time" id="at"><input type="color" id="shade">
</div>
<div id="locs">
  <button id="okA">okA</button><button id="okB">okB</button>
  <button id="okCancel">OK Cancel</button> <button id="okBtn"><span id="okSpan">OK</span></button>
</div>
<input type="file" id="files" multiple style="display:none">
<div id="pickBox">Choose…</div>
<ul id="pickMenu" style="display:none"><li>One</li><li>Two</li><li>Three</li></ul>
<select id="pickSel"><option value="">-</option><option value="a">A</option><option value="b">B</option></select>
<shadow-box id="sbox"></shadow-box>
<div id="fileZone" style="min-height:30px">drop files here</div>
<iframe id="frm" src="/frame" style="height:160px"></iframe>
<div id="tall" style="height:3000px"></div>
<script>
  const run = new URLSearchParams(location.search).get('run');
  const clicks = [], alerts = [], marks = [];
  let seq = 0;
  const fields = () => Object.fromEntries([...document.querySelectorAll('input[id], select[id], textarea[id], [contenteditable][id]')]
    .map((el) => [el.id, el.type === 'checkbox' ? el.checked : (el.isContentEditable ? el.textContent : el.value)]));
  // seq: two posts in flight may arrive in either order; the harness keeps the latest.
  const report = () => fetch('/state', { method: 'POST', keepalive: true,
    body: JSON.stringify({ run, seq: ++seq, state: { fields: fields(), clicks, alerts, marks, headless: /Headless/.test(navigator.userAgent), width: innerWidth } }) });
  // The bookmarklet reports its errors with alert(), which would block a headless page.
  window.alert = (m) => { alerts.push(String(m)); report(); };
  // Fields are in the state by value; a click on one is not counted.
  document.addEventListener('click', (e) => {
    if (e.target.id && !e.target.matches('input, select, textarea')) { clicks.push(e.target.id); report(); }
  }, true);
  for (const type of ['input', 'change']) document.addEventListener(type, report, true);
  // A widget waiting for an event playback fires; sorted, as a real browser may fire them in another order.
  const mark = (m) => { if (!marks.includes(m)) { marks.push(m); marks.sort(); report(); } };
  const on = (id, type) => document.getElementById(id).addEventListener(type, () => mark(id + ' ' + type));
  on('mdBtn', 'mousedown');
  on('hoverMenu', 'mousemove');
  on('blurField', 'blur');
  on('color', 'click');
  const zone = document.getElementById('dropZone');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => { e.preventDefault(); mark('dropZone drop'); });
  const pickMenu = document.getElementById('pickMenu');
  document.getElementById('pickBox').addEventListener('click', () => { pickMenu.style.display = 'block'; });
  pickMenu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    pickMenu.style.display = 'none';
    mark('picked ' + li.textContent);
  }));
  const files = document.getElementById('files');
  files.addEventListener('change', () => mark('files ' + [...files.files].map((f) => f.name).join(',')));
  // A drop zone for files: it names those dropped on it.
  const fileZone = document.getElementById('fileZone');
  for (const t of ['dragenter', 'dragover']) fileZone.addEventListener(t, (e) => e.preventDefault());
  fileZone.addEventListener('drop', (e) => { e.preventDefault(); mark('fileZone ' + [...e.dataTransfer.files].map((f) => f.name).join(',')); });
  // The frame (/frame) reports what is done in it through its parent.
  window.frameMark = (m) => mark(m);
  // ?xo: the same frame from another origin (localhost, the page being on 127.0.0.1).
  if (location.search.includes('xo')) {
    const xo = document.createElement('iframe');
    xo.src = 'http://localhost:' + location.port + '/frame?xo';
    document.body.insertBefore(xo, document.getElementById('tall'));
  }
  // A web component: a button in its open shadow root, and one added there a moment later.
  customElements.define('shadow-box', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const button = (id) => {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = id;
        b.addEventListener('click', () => mark('shadow ' + id));
        root.append(b);
      };
      button('inShadow');
      setTimeout(() => button('lateShadow'), 700);
    }
  });
  report();
</script></body></html>`;

/**
 * The page EXPORT_PAGE frames (same origin): a field and a button whose click its
 * parent marks, and for the CDP steps a file input, a drop zone, a dropdown and a
 * box of known size to capture.
 */
const FRAME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head>
<body><input id="fName"><button id="fGo">go</button>
<input type="file" id="fFiles" multiple><div id="fZone">frame drop</div>
<div id="fDd">frame choose</div><ul id="fMenu" style="display:none"><li>fa</li><li>fb</li></ul>
<span id="fShot" style="display:inline-block;width:57px;height:23px;background:#f80"></span>
<script>
  const frameMark = (m) => { try { parent.frameMark(m); } catch (e) { /* another origin: nothing to tell */ } };
  document.getElementById('fGo').addEventListener('click', () => frameMark('frame go ' + document.getElementById('fName').value));
  const fFiles = document.getElementById('fFiles');
  fFiles.addEventListener('change', () => frameMark('frame files ' + [...fFiles.files].map((f) => f.name).join(',')));
  const fZone = document.getElementById('fZone');
  for (const t of ['dragenter', 'dragover']) fZone.addEventListener(t, (e) => e.preventDefault());
  fZone.addEventListener('drop', (e) => { e.preventDefault(); frameMark('frame zone ' + [...e.dataTransfer.files].map((f) => f.name).join(',')); });
  const fMenu = document.getElementById('fMenu');
  document.getElementById('fDd').addEventListener('click', (e) => { fMenu.style.display = 'block'; frameMark('frame dd ' + (e.isTrusted ? 'trusted' : 'untrusted')); });
  fMenu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { fMenu.style.display = 'none'; frameMark('frame picked ' + li.textContent); }));
</script></body></html>`;

/** The latest state each run of EXPORT_PAGE posted, by its ?run= key. */
const exportStates = new Map();

function saveExportState(req, reply) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const { run, seq, state } = JSON.parse(body);
      if (!(exportStates.get(run)?.seq > seq)) exportStates.set(run, { seq, state });
    } catch { /* not a state post: nothing to keep */ }
    reply.statusCode = 204;
    reply.end();
  });
}

/**
 * Scenarios export-run plays, then runs as each export, on EXPORT_PAGE. `expect`
 * is what playback must leave (fields listed; clicks, alerts and marks in full,
 * none when left out); each export of `runners` (default both) must then leave
 * exactly what playback left; `files` are what the Selenium and Playwright runs must save, by
 * name, each with a check on the PNG's { width, height }. With `pageVar`, each run
 * starts on another page and that variable holds the URL of its own; with
 * `bookmarkletClicks: 2` the bookmark is clicked once there, then again on the
 * page it opened. With `failedAsserts` (the titles of the steps of its false Asserts),
 * every export run must fail at its end naming them, and no other step (checkFailedAsserts).
 * Add a case per behaviour an export has to share with playback.
 */
// The folder of this harness: Upload File cases upload its own files.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const EXPORT_CASES = [
  {
    name: 'form',
    // Also as the exported pytest test (python -m pytest).
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    variables: { salute: 'Hi' },
    actions: [
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Alice' },
      { type: 'input', selector: '#color', selectors: { css: '#color' }, value: 'g' },
      { type: 'click', selector: '#agree', selectors: { css: '#agree' } },
      { type: 'readdom', selector: '#code', selectors: { css: '#code' }, varName: 'code', readFrom: 'text' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${salute} ${code}' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#submit', selectors: { css: '#submit' }, skipCount: 1 },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#nope', selectors: { css: '#nope' }, skipCount: 1 },
      { type: 'click', selector: '#never', selectors: { css: '#never' } },
    ],
    expect: { fields: { name: 'Alice', color: 'g', agree: true, echo: 'Hi ORD-42' }, clicks: ['submit', 'after'], marks: ['color click'] },
  },
  {
    // Child Condition: the innermost element holding the text, ALL, a Fallback
    // variable, and a text the page hides (playback matches textContent).
    name: 'child-condition',
    variables: { who: '{fallback:Carol|Bob}' },
    actions: [
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: 'VIP' } },
      { type: 'click', selector: '#people', selectors: { css: '#people' },
        conditions: { matchMode: 'all', textContains: 'Edit', classContains: 'special' } },
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: '${who}' } },
      { type: 'readdom', selector: '#people', selectors: { css: '#people' }, varName: 'ref', readFrom: 'text',
        conditions: { textContains: 'ref' } },
      { type: 'input', selector: '#picked', selectors: { css: '#picked' }, value: '${ref}' },
      // Text the element holds in its own text nodes, a child between them: only those match it.
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: 'HelloWorld' } },
    ],
    expect: { fields: { picked: 'ref 7731' }, clicks: ['tagBob', 'editBob', 'nameBob', 'ownTxt'], alerts: [] },
  },
  {
    // Each Condition guards one click: hasAttribute name=value, visible / hidden by
    // style and size (a fixed element has no offsetParent), text by textContent,
    // textEquals trimmed on both sides.
    name: 'conditions',
    actions: [
      ['hasAttribute', '#tagged', 'data-id=5', '#c1'],
      ['elementVisible', '#fixedBox', '', '#c2'],
      ['elementHidden', '#ghost', '', '#c3'],
      ['textContains', '#note2', 'secret', '#c4'],
      ['textEquals', '#total', ' Total: 42 ', '#c5'],
      ['elementVisible', '#ghost', '', '#c6'],
    ].flatMap(([conditionType, sel, expectedValue, guarded]) => [
      { type: 'condition', conditionType, selector: sel, selectors: { css: sel }, expectedValue, skipCount: 1 },
      { type: 'click', selector: guarded, selectors: { css: guarded } },
    ]),
    expect: { clicks: ['c1', 'c2', 'c3', 'c4', 'c5'] },
  },
  {
    // Events a page may wait for, fired as playback fires them: mousedown before a
    // click, mousemove on a hover, text into a contenteditable, blur after an Input.
    name: 'actions',
    actions: [
      { type: 'click', selector: '#mdBtn', selectors: { css: '#mdBtn' } },
      { type: 'hover', selector: '#hoverMenu', selectors: { css: '#hoverMenu' } },
      { type: 'input', selector: '#rich', selectors: { css: '#rich' }, value: 'Hello' },
      { type: 'input', selector: '#blurField', selectors: { css: '#blurField' }, value: 'x' },
      // In the Selenium run, the real click that blurs the field.
      { type: 'click', selector: '#done', selectors: { css: '#done' } },
    ],
    expect: { fields: { rich: 'Hello', blurField: 'x' }, clicks: ['mdBtn', 'done'],
      marks: ['blurField blur', 'hoverMenu mousemove', 'mdBtn mousedown'] },
  },
  {
    // HTML5 drag and drop: dragstart … drop with one DataTransfer, as playback fires them.
    name: 'drag',
    actions: [{ type: 'dragdrop', selector: '#dragSrc', selectors: { css: '#dragSrc' },
      targetSelector: '#dropZone', targetSelectors: { css: '#dropZone' } }],
    expect: { marks: ['dropZone drop'] },
  },
  {
    // Fields send_keys cannot fill the same way everywhere: a date or time is typed
    // in the browser locale's format, a color takes no typing.
    name: 'typed-fields',
    actions: [
      { type: 'input', selector: '#when', selectors: { css: '#when' }, value: '2026-10-10' },
      { type: 'input', selector: '#at', selectors: { css: '#at' }, value: '13:45' },
      { type: 'input', selector: '#shade', selectors: { css: '#shade' }, value: '#336699' },
    ],
    expect: { fields: { when: '2026-10-10', at: '13:45', shade: '#336699' } },
  },
  {
    // Every locator tried in playback's order until one finds the element; a Text
    // locator matches the exact text, innermost.
    name: 'locators',
    actions: [
      // The CSS is stale; the id, which playback tries before it, is not.
      { type: 'click', selector: '#broken1', selectors: { css: '#broken1', id: 'okA' } },
      // The id is stale; the XPath, tried next, is not.
      { type: 'click', selector: '#broken2', selectors: { id: 'broken2', xpath: '//button[@id="okB"]' } },
      { type: 'click', selectors: { text: 'OK' }, selectorType: 'text' },
    ],
    expect: { clicks: ['okA', 'okB', 'okSpan'] },
  },
  {
    // Upload File into a file input the page hides, a ${var} file name included.
    // Two of the harness's own files; a bookmarklet cannot read files.
    name: 'upload',
    runners: ['selenium', 'playwright'],
    variables: { second: 'verify.mjs' },
    actions: [{ type: 'uploadFile', selector: '#files', selectors: { css: '#files' }, uploadMode: 'input',
      folderPath: TOOLS_DIR, fileNames: ['e2e.mjs', '${second}'] }],
    expect: { marks: ['files e2e.mjs,verify.mjs'] },
  },
  {
    // Upload File to a drop zone: the files set on a hidden file input, then dropped on the
    // zone, as playback does it through CDP. A bookmarklet cannot read files.
    name: 'dropzone',
    runners: ['selenium', 'pytest', 'playwright'],
    variables: { second: 'verify.mjs' },
    actions: [{ type: 'uploadFile', selector: '#fileZone', selectors: { css: '#fileZone' }, uploadMode: 'dropzone',
      folderPath: TOOLS_DIR, fileNames: ['e2e.mjs', '${second}'] }],
    expect: { marks: ['fileZone e2e.mjs,verify.mjs'] },
  },
  {
    // Dropdown "Choose item #": item 2 of a list that opens on a click, the last option of a <select>.
    name: 'dropdown-pick',
    actions: [
      { type: 'dropdown', selector: '#pickBox', selectors: { css: '#pickBox' }, pick: { by: 'index', index: '2', itemSelector: '#pickMenu li' } },
      { type: 'dropdown', selector: '#pickSel', selectors: { css: '#pickSel' }, pick: { by: 'index', index: '-1' } },
    ],
    expect: { fields: { pickSel: 'b' }, clicks: ['pickBox'], marks: ['picked Two'] },
  },
  {
    // A full-page screenshot holds the whole page (3000px of #tall), not the window.
    name: 'full-shot',
    runners: ['selenium', 'playwright'],
    actions: [{ type: 'screenshot_full' }],
    files: { 'screenshot_full_step1.png': ({ height }) => height > 3000 },
  },
  {
    // A Navigate first. The bookmarklet, clicked on another page, opens the page
    // and stops; clicked again there, it plays the rest.
    name: 'navigate-first',
    pageVar: 'page',
    bookmarkletClicks: 2,
    actions: [
      { type: 'navigate', url: '${page}' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
    ],
    expect: { clicks: ['submit'] },
  },
  {
    // Buttons inside a web component's open shadow root, one added there mid-wait: playback
    // finds them by CSS through the shadow root; so must every export.
    name: 'shadow',
    actions: [
      { type: 'click', selector: '#inShadow', selectors: { css: '#inShadow' } },
      { type: 'click', selector: '#lateShadow', selectors: { css: '#lateShadow' } },
    ],
    // A click inside the shadow root reaches the document as one on its host.
    expect: { clicks: ['sbox', 'sbox'], marks: ['shadow inShadow', 'shadow lateShadow'] },
  },
  {
    // A field and a button inside the page's iframe, then a button of the page. `inFrame`
    // steps get the frameId playback knows the frame by (as recording gives it).
    name: 'iframe',
    // The frame is of the page's own origin: within the bookmarklet's reach.
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'input', selector: '#fName', selectors: { css: '#fName' }, value: 'Zoe', inFrame: true },
      { type: 'click', selector: '#fGo', selectors: { css: '#fGo' }, inFrame: true },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['after'], marks: ['frame go Zoe'] },
  },
  {
    // Conditions on elements inside the iframe: checked in the frame, as playback checks
    // them (the exports used to look in the top page, where none of them is).
    name: 'iframe-condition',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'condition', conditionType: 'elementExists', selector: '#fGo', selectors: { css: '#fGo' }, skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c1', selectors: { css: '#c1' } },
      { type: 'condition', conditionType: 'textContains', selector: '#fDd', selectors: { css: '#fDd' }, expectedValue: 'choose', skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c2', selectors: { css: '#c2' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#noSuch', selectors: { css: '#noSuch' }, skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c3', selectors: { css: '#c3' } },
    ],
    expect: { clicks: ['c1', 'c2'] },
  },
  // A Switch block on a variable: the case whose value it has runs its action, then the step
  // after the block — the default case when no case has the value.
  ...[['switch-block', 'user', 'c2'], ['switch-default', 'guest', 'c3']].map(([name, role, clicked]) => ({
    name,
    variables: { role },
    actions: [
      { type: 'switch', switchVar: 'role', cases: [
        { value: 'admin', scenarioId: '__self__', startAt: 2, endAt: 2 },
        { value: 'user', scenarioId: '__self__', startAt: 3, endAt: 3 },
        { value: '__default__', scenarioId: '__self__', startAt: 4, endAt: 4 },
      ] },
      { type: 'click', selector: '#c1', selectors: { css: '#c1' } },
      { type: 'click', selector: '#c2', selectors: { css: '#c2' } },
      { type: 'click', selector: '#c3', selectors: { css: '#c3' } },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: [clicked, 'after'] },
  })),
  {
    // A value read on one page, a Navigate to a page that redirects, the value typed on the
    // page it lands on. The bookmarklet goes on there at its second click.
    name: 'multi-page',
    pageVar: 'next',
    redirect: true,
    bookmarkletClicks: 2,
    actions: [
      { type: 'readdom', selector: '#code', selectors: { css: '#code' }, varName: 'code', readFrom: 'text' },
      { type: 'navigate', url: '${next}' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${code} ok' },
    ],
    expect: { fields: { echo: 'ORD-42 ok' } },
  },
  {
    // An Assert is checked until it holds, as playback checks it: the text a script puts on the
    // page 2 s later passes; one that never holds fails the run at its end — the click after it
    // still runs — naming that step alone (`failedAsserts`), in every export as in playback.
    name: 'assert',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    failedAsserts: ['Step 4: assert — textEquals — Never'],
    actions: [
      { type: 'script', code: "setTimeout(() => { document.getElementById('code').textContent = 'Saved'; }, 2000)" },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Saved', label: 'Late' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Nope', label: 'Never' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['submit', 'after'] },
  },
  {
    // Every Assert holds — one only after 2 s: every export passes, the bookmarklet with no alert.
    name: 'assert-held',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'script', code: "setTimeout(() => { document.getElementById('code').textContent = 'Saved'; }, 2000)" },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Saved' },
      { type: 'assert', conditionType: 'urlContains', expectedValue: '/export' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['after'] },
  },
  {
    // A false Assert before a Navigate to a page of the site, one after it: the run fails at its
    // end naming both — the bookmarklet, going on there at its second click, kept the first.
    name: 'assert-pages',
    pageVar: 'next',
    bookmarkletClicks: 2,
    failedAsserts: ['Step 1: assert — textEquals — Before', 'Step 4: assert — urlContains — After'],
    actions: [
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Nope', label: 'Before' },
      { type: 'navigate', url: '${next}' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
      { type: 'assert', conditionType: 'urlContains', expectedValue: '/nowhere', label: 'After' },
    ],
    expect: { clicks: ['after'] },
  },
  {
    // A one-line Script that ends in a quote: the Selenium literal closed early on it.
    name: 'script-quote',
    actions: [{ type: 'script', code: 'alert("hi"); window.done = "yes"' }],
    expect: { alerts: ['hi'] },
  },
  {
    // A ${ that names no variable, beside one that does, stays text: the JS exports'
    // template literal did not parse.
    name: 'dollar-brace',
    variables: { who: 'Bob' },
    actions: [
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'price ${' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: 'tick ` ${who} ${}' },
    ],
    expect: { fields: { name: 'price ${', echo: 'tick ` Bob ${}' } },
  },
  {
    // Variables named as what the code uses itself: `location` hid the page's from the
    // bookmarklet's first Navigate, `el2` was step 2's element (Playwright: declared twice).
    name: 'own-names',
    pageVar: 'page',
    bookmarkletClicks: 2,
    variables: { location: 'Hanoi', el2: 'x' },
    actions: [
      { type: 'navigate', url: '${page}' },
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${location} ${el2}' },
    ],
    expect: { fields: { name: 'Hanoi x' } },
  },
];

// A folder with @playwright/test installed (npm install @playwright/test): the Playwright
// runs use it, with the installed Edge. Unset, they are skipped, not failed.
const PLAYWRIGHT_DIR = process.env.PQA_PLAYWRIGHT_DIR || '';

// The exported Selenium script, first run included (Selenium Manager may fetch a driver).
const PYTHON_RUN_TIMEOUT_MS = 180_000;
// The bookmarklet runs in the page; its own step delays and waits add up.
const BOOKMARKLET_RUN_TIMEOUT_MS = 60_000;

const runFile = (file, args, opts) => new Promise((res) => {
  execFile(file, args, { windowsHide: true, ...opts }, (error, stdout, stderr) => res({ error, stdout, stderr }));
});

/** Whether `python -m pytest` runs here. */
async function hasPytest() {
  return !(await runFile('python', ['-m', 'pytest', '--version'])).error;
}

/** Run a pytest file from `dir`, no cache written; its report in UTF-8 (a pipe here is cp1252). */
const runPytest = (file, dir) => runFile('python', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', file],
  { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

// A python with Robot Framework and SeleniumLibrary (pip install robotframework-seleniumlibrary):
// the Robot runs use it. Without, they are skipped, not failed.
const ROBOT_PYTHON = process.env.PQA_ROBOT_PYTHON || 'python';

/** Whether ROBOT_PYTHON runs Robot Framework with SeleniumLibrary. */
async function hasRobot() {
  return !(await runFile(ROBOT_PYTHON, ['-c', 'import robot, SeleniumLibrary'])).error;
}

/** Run a .robot file, its output (log, screenshots) into `outDir`; its console in UTF-8. */
const runRobot = (file, outDir, env = process.env) => runFile(ROBOT_PYTHON,
  ['-m', 'robot', '--outputdir', outDir, '--consolecolors', 'off', '--consolewidth', '160', file],
  { cwd: outDir, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...env, PYTHONIOENCODING: 'utf-8' } });

// A JDK and a folder of the selenium-java and testng jars (with their own): the Java runs use them.
// Without either, they are skipped, not failed.
const JAVA_HOME = process.env.PQA_JAVA_HOME || '';
const JAVA_LIBS = process.env.PQA_JAVA_LIBS || '';
const javaTool = (tool) => join(JAVA_HOME, 'bin', tool);

/** Why the Java runs cannot happen here, or null when they can. */
function javaMissing() {
  if (!JAVA_HOME || !existsSync(javaTool(process.platform === 'win32' ? 'javac.exe' : 'javac'))) return 'no JDK (set PQA_JAVA_HOME)';
  return JAVA_LIBS && existsSync(JAVA_LIBS) ? null : 'no selenium-java + testng jars (set PQA_JAVA_LIBS)';
}

/**
 * Compile a test class into `outDir` and run it there with TestNG (what it saves
 * lands there), its output in UTF-8; a failed compile is returned as the run.
 */
async function runJava(file, className, outDir, env = process.env) {
  const libs = join(JAVA_LIBS, '*');
  const built = await runFile(javaTool('javac'), ['-encoding', 'UTF-8', '-cp', libs, '-d', outDir, file], { timeout: PYTHON_RUN_TIMEOUT_MS });
  if (built.error) return built;
  return runFile(javaTool('java'), ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', [outDir, libs].join(delimiter),
    'org.testng.TestNG', '-testclass', className, '-verbose', '2'],
  { cwd: outDir, timeout: PYTHON_RUN_TIMEOUT_MS, env });
}

/** Why the Selenium run cannot happen on this machine, or null when it can. */
async function pythonMissing() {
  const { error, stderr } = await runFile('python', ['-c', 'import selenium']);
  if (!error) return null;
  return error.code === 'ENOENT' ? 'no python on PATH' : `no selenium for python (${String(stderr).trim().split('\n').pop()})`;
}

/** The files a case expects (c.files) that a run saved into `folder`, checked on the PNG's size. */
function checkFiles(c, runner, folder) {
  for (const [name, ok] of Object.entries(c.files || {})) {
    const size = existsSync(join(folder, name)) ? pngSize(join(folder, name)) : null;
    check(size && ok(size), `${c.name}: the ${runner} run saves ${name} as expected`, size);
  }
}

/** Wait (up to PLAY_TIMEOUT_MS) until `page` has loaded `url`, then a moment more. */
async function untilOn(page, url) {
  for (let waited = 0; waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
    // Mid-navigation the page may not answer at all.
    const href = await page.evaluate('document.readyState === "complete" && location.href').catch(() => null);
    if (href === url) break;
    await sleep(POLL_MS);
  }
  await sleep(PAGE_SETTLE_MS);
}

/** The fields whose values differ between two page states, as { field: [a, b] }. */
function stateDiff(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a?.fields || {}), ...Object.keys(b?.fields || {})])) {
    if (a?.fields?.[k] !== b?.fields?.[k]) out[k] = [a?.fields?.[k], b?.fields?.[k]];
  }
  for (const k of ['clicks', 'alerts', 'marks']) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out[k] = [a?.[k], b?.[k]];
  }
  return out;
}

// A scenario whose step 3, "Sign in", finds nothing: what each export says when it fails.
const FAILING_STEPS = [
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Alice' },
  { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
  { type: 'click', selector: '#nope', selectors: { css: '#nope' }, label: 'Sign in' },
  { type: 'click', selector: '#after', selectors: { css: '#after' } },
];
// What a failure report has to say: the step, its label, and what was looked for.
const NAMES_STEP_3 = /Step 3: click — Sign in/;
const NAMES_LOCATOR = /#nope/;

/** Each export of FAILING_STEPS, run: its error names step 3 and its label, and what it looked for. */
async function checkFailsAtStep(ctx, run) {
  const opts = { elTimeout: 1000, stepDelay: 0 };
  const page = (runner) => run.pageUrl(`fails-at-step:${runner}`);

  // A tab of its own: the error the bookmarklet logs is meant, not one of the test page's.
  const tab = await ctx.browser.openPage(page('bookmarklet'));
  await sleep(PAGE_SETTLE_MS);
  const url = run.toBookmarkletUrl(run.generateBookmarklet('fails at step', FAILING_STEPS, {}, opts).code);
  await tab.evaluate(decodeURIComponent(url.slice('javascript:'.length)), BOOKMARKLET_RUN_TIMEOUT_MS).catch(() => {});
  await sleep(SETTLE_MS);
  await tab.close();
  const alerts = exportStates.get('fails-at-step:bookmarklet')?.state?.alerts || [];
  check(alerts.length === 1 && NAMES_STEP_3.test(alerts[0]) && NAMES_LOCATOR.test(alerts[0]),
    'fails-at-step: the bookmarklet\'s alert names step 3, its label and what it looked for', alerts);

  if (!run.noPython) {
    const file = join(run.dir, 'fails_at_step.py');
    writeFileSync(file, run.generateSeleniumPy('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('selenium'), headless: !HEADED }).code);
    const r = await runFile('python', [file], { cwd: run.dir, timeout: PYTHON_RUN_TIMEOUT_MS });
    const said = String(r.stdout).trim();
    check(r.error && NAMES_STEP_3.test(said) && NAMES_LOCATOR.test(said),
      'fails-at-step: the Selenium script fails, printing step 3, its label and what it looked for', said.split('\n').pop());
    check(existsSync(join(run.dir, 'fails_at_step_failure.png')), 'fails-at-step: the Selenium script leaves fails_at_step_failure.png', null);
  }
  if (run.pwRun) {
    // The list reporter, as on a terminal: each test.step and the failing one.
    const spec = 'fails_at_step.spec.js';
    writeFileSync(join(run.pwRun, spec), run.generatePlaywright('fails at step', FAILING_STEPS, {}, { ...opts, startUrl: page('playwright') }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', spec, '--config', 'playwright.config.mjs', '--reporter=list'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...process.env, PLAYWRIGHT_LIST_PRINT_STEPS: '1' } });
    const report = String(r.stdout);
    // Reported under its step (test.step), not only near the step's comment in the code frame.
    check(r.error && /› Step 3: click — Sign in/.test(report) && NAMES_LOCATOR.test(report),
      'fails-at-step: the Playwright report names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 3));
    const results = join(run.pwRun, 'test-results');
    const shots = existsSync(results) ? readdirSync(results, { recursive: true }).map(String).filter((f) => f.endsWith('.png')) : [];
    check(shots.length > 0, 'fails-at-step: the Playwright test keeps a screenshot in test-results/', shots);
  }
  if (run.pytestHere) {
    const file = join(run.dir, 'test_fails_at_step.py');
    writeFileSync(file, run.generateSeleniumPy('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('pytest'), headless: !HEADED, output: 'pytest' }).code);
    const r = await runPytest(file, run.dir);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => /^E\s/.test(l) && NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the pytest report\'s error names step 3, its label and what it looked for', report.split('\n').filter((l) => /^E\s/.test(l)).slice(0, 2));
    check(existsSync(join(run.dir, 'test_fails_at_step_failure.png')), 'fails-at-step: the pytest test leaves test_fails_at_step_failure.png', null);
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-'));
    const file = join(out, 'fails_at_step.robot');
    writeFileSync(file, run.generateRobot('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('robot'), headless: !HEADED }).code);
    const r = await runRobot(file, out);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the Robot report\'s message names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 2));
    check(existsSync(join(out, 'fails_at_step_failure.png')), 'fails-at-step: the Robot test leaves fails_at_step_failure.png', null);
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-'));
    const cls = run.javaClassName('fails at step');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('java'), headless: !HEADED }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the TestNG report names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 2));
    check(existsSync(join(out, `${cls}_failure.png`)), `fails-at-step: the Java test leaves ${cls}_failure.png`, null);
  }
}

/**
 * One export, run with the environment set (PQA_BASE_URL, PQA_<name>), changes the
 * run without an export: its start URL is on a site nothing answers on, and the
 * echo field gets the variable's value from the environment.
 */
async function checkEnvOverrides(ctx, run) {
  const steps = [{ type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${salute} there' }];
  const env = (runner) => ({ ...process.env, PQA_BASE_URL: ctx.base, PQA_salute: 'Yo', PQA_TEST_RUN: runner });
  // Port 9 (discard): nothing to open there; the run has to go to PQA_BASE_URL instead.
  const deadStart = (runner) => `http://127.0.0.1:9/export?run=${encodeURIComponent(`env:${runner}`)}`;
  const reached = (runner) => exportStates.get(`env:${runner}`)?.state;
  if (!run.noPython) {
    const file = join(run.dir, 'env.py');
    writeFileSync(file, run.generateSeleniumPy('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('selenium'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runFile('python', [file], { cwd: run.dir, timeout: PYTHON_RUN_TIMEOUT_MS, env: env('selenium') });
    await sleep(SETTLE_MS);
    check(!r.error && reached('selenium')?.fields?.echo === 'Yo there',
      'env: the Selenium script opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').pop() : reached('selenium')?.fields?.echo);
  }
  if (run.pwRun) {
    writeFileSync(join(run.pwRun, 'env.spec.js'), run.generatePlaywright('env', steps, { salute: 'Hi' }, { startUrl: deadStart('playwright'), stepDelay: 0 }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', 'env.spec.js', '--config', 'playwright.config.mjs'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS, env: env('playwright') });
    await sleep(SETTLE_MS);
    check(!r.error && reached('playwright')?.fields?.echo === 'Yo there',
      'env: the Playwright test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').slice(-3) : reached('playwright')?.fields?.echo);
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-'));
    writeFileSync(join(out, 'env.robot'), run.generateRobot('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('robot'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runRobot(join(out, 'env.robot'), out, env('robot'));
    await sleep(SETTLE_MS);
    check(!r.error && reached('robot')?.fields?.echo === 'Yo there',
      'env: the Robot test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').slice(-6) : reached('robot')?.fields?.echo);
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-'));
    const cls = run.javaClassName('env');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('java'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out, env('java'));
    await sleep(SETTLE_MS);
    check(!r.error && reached('java')?.fields?.echo === 'Yo there',
      'env: the Java test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout + r.stderr).trim().split('\n').slice(-6) : reached('java')?.fields?.echo);
  }
}

/**
 * A pytest test, a Playwright spec, a Robot test (DataDriver, through the
 * exported reader) and a Java TestNG class exported with a data file run once per
 * row of it, each with its row's values: the page to open (a column no variable has)
 * and "who", whose column wins over the variable's "Zed" — one value quoted,
 * holding the delimiter.
 */
async function checkCsvData(ctx, run) {
  const steps = [
    { type: 'navigate', url: '${page}' },
    { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${who}' },
  ];
  const who = ['Ann', 'Bo, Jr.', 'Cy'];
  const writeCsv = (folder, runner) => writeFileSync(join(folder, 'data.csv'),
    ['page,who', ...who.map((w, k) => `${run.pageUrl(`csv:${runner}:${k + 1}`)},"${w}"`)].join('\r\n') + '\r\n');
  const names = (runner) => who.map((w, k) => exportStates.get(`csv:${runner}:${k + 1}`)?.state?.fields?.name);
  if (run.pytestHere) {
    writeCsv(run.dir, 'pytest');
    writeFileSync(join(run.dir, 'test_csv_data.py'), run.generateSeleniumPy('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, output: 'pytest', dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runPytest('test_csv_data.py', run.dir);
    await sleep(SETTLE_MS);
    const summary = String(r.stdout).trim().split('\n').pop();
    check(!r.error && /^3 passed/.test(summary) && JSON.stringify(names('pytest')) === JSON.stringify(who),
      'csv-data: pytest runs a test per row of data.csv, each with its row', { summary, names: names('pytest') });
  }
  if (run.pwRun) {
    writeCsv(run.pwRun, 'playwright');
    writeFileSync(join(run.pwRun, 'csv_data.spec.js'), run.generatePlaywright('csv data', steps, { who: 'Zed' },
      { dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', 'csv_data.spec.js', '--config', 'playwright.config.mjs'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS });
    await sleep(SETTLE_MS);
    const out = String(r.stdout);
    check(!r.error && /\b3 passed\b/.test(out) && JSON.stringify(names('playwright')) === JSON.stringify(who),
      'csv-data: Playwright runs a test per row of data.csv, each with its row', { out: out.trim().split('\n').slice(-2), names: names('playwright') });
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-csv-'));
    writeCsv(out, 'robot');
    writeFileSync(join(out, run.ROBOT_READER_FILE), run.robotReaderPy());
    writeFileSync(join(out, 'csv_data.robot'), run.generateRobot('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runRobot(join(out, 'csv_data.robot'), out);
    await sleep(SETTLE_MS);
    const out2 = String(r.stdout);
    check(!r.error && /3 tests, 3 passed, 0 failed/.test(out2) && JSON.stringify(names('robot')) === JSON.stringify(who),
      'csv-data: Robot (DataDriver) runs a test per row of data.csv, each with its row', { out: out2.trim().split('\n').slice(-8), names: names('robot') });
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-csv-'));
    writeCsv(out, 'java');
    const cls = run.javaClassName('csv data');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out);
    await sleep(SETTLE_MS);
    const out2 = String(r.stdout) + String(r.stderr);
    check(!r.error && /Total tests run: 3, Passes: 3, Failures: 0/.test(out2) && JSON.stringify(names('java')) === JSON.stringify(who),
      'csv-data: Java (TestNG) runs a test per row of data.csv, each with its row', { out: out2.trim().split('\n').slice(-8), names: names('java') });
  }
}

/** The frameId the extension knows the test tab's frame at `path` by, or null. */
const frameIdOf = (ctx, path) => ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
  { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.pathname },
  (r) => res((r || []).find((f) => f.result === ${JSON.stringify(path)})?.frameId ?? null)))`);

async function checkExportRun(ctx) {
  const extModule = (p) => pathToFileURL(join(EXT, p)).href;
  const { generateBookmarklet, toBookmarkletUrl } = await import(extModule('popup/export-bookmarklet.js'));
  const { generateSeleniumPy } = await import(extModule('popup/export-selenium.js'));
  const { getUsedVarNames } = await import(extModule('popup/utils.js'));
  const noPython = await pythonMissing();
  if (noPython) console.log(`  – the Selenium runs are skipped: ${noPython}`);
  const pytestHere = !noPython && await hasPytest();
  // An export a version does not have (an older checkout under --ext) is not run.
  const { generatePlaywright } = await import(extModule('popup/export-playwright.js')).catch(() => ({}));
  const pwCli = PLAYWRIGHT_DIR && join(PLAYWRIGHT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
  const pwRun = generatePlaywright && pwCli && existsSync(pwCli) ? mkdtempSync(join(PLAYWRIGHT_DIR, 'pqa-run-')) : null;
  if (pwRun) {
    // outputDir beside the config: by default it goes beside the nearest package.json, outside pwRun.
    writeFileSync(join(pwRun, 'playwright.config.mjs'),
      `export default { use: { channel: 'msedge', headless: ${!HEADED} }, reporter: 'line', workers: 1, outputDir: './test-results' };\n`);
  } else {
    console.log('  – the Playwright runs are skipped: set PQA_PLAYWRIGHT_DIR to a folder with @playwright/test installed');
  }
  if (!noPython && !pytestHere) console.log('  – the pytest runs are skipped: no pytest for python');
  const { generateRobot, robotReaderPy, ROBOT_READER_FILE } = await import(extModule('popup/export-robot.js')).catch(() => ({}));
  const robotHere = !!generateRobot && await hasRobot();
  if (generateRobot && !robotHere) console.log(`  – the Robot runs are skipped: no robotframework-seleniumlibrary for ${ROBOT_PYTHON} (set PQA_ROBOT_PYTHON)`);
  const { generateJava, javaClassName } = await import(extModule('popup/export-java.js')).catch(() => ({}));
  const noJava = generateJava && javaMissing();
  if (noJava) console.log(`  – the Java runs are skipped: ${noJava}`);
  const javaHere = !!generateJava && !noJava;
  const dir = mkdtempSync(join(tmpdir(), 'pqa-export-'));
  let headlessChecked = false;
  const pageUrl = (key) => `${ctx.base}/export?run=${encodeURIComponent(key)}`;
  // A case whose Asserts are false (c.failedAsserts, their steps' titles): a run of it fails at its
  // end (`failed`) and what it said (`said`) names each of them — and no other Assert: one that
  // held, if only after a while, is no failure. A failure's message is "<title>: expected …"; a
  // title elsewhere (pytest's code listing, a report's heading) is none.
  const checkFailedAsserts = (c, runner, failed, said) => {
    const named = [...new Set([...said.matchAll(/Step \d+: assert[^:\n"]*(?=: expected )/g)].map((m) => m[0]))];
    check(failed && c.failedAsserts.every((t) => named.includes(t)) && named.every((t) => c.failedAsserts.includes(t)),
      `${c.name}: the ${runner} run fails at its end, naming the false Assert(s) and no other`, { failed: !!failed, named });
  };
  try {
    for (const c of EXPORT_CASES.filter((x) => !CASES || CASES.includes(x.name))) {
      // The URL of each run's own page, in the variable named by `pageVar`.
      // Through /redirect with `redirect`: the page a Navigate opens sends it on to the run's page.
      const pageVars = (runner) => (c.pageVar ? { [c.pageVar]: c.redirect
        ? `${ctx.base}/redirect?to=${encodeURIComponent(pageUrl(`${c.name}:${runner}`))}` : pageUrl(`${c.name}:${runner}`) } : {});
      const startUrl = (runner) => pageUrl(`${c.name}:${c.pageVar ? 'start' : runner}`);
      await ctx.send({ type: 'SAVE_VARIABLES', variables: { ...c.variables, ...pageVars('playback') } });
      // The playback page first: a step in its frame needs the frameId the frame has there.
      await ctx.web.goto(startUrl('playback'));
      await sleep(PAGE_SETTLE_MS);
      const frameId = c.actions.some((a) => a.inFrame) ? await frameIdOf(ctx, '/frame') : null;
      const id = await makeScenario(ctx, `e2e export ${c.name}`,
        c.actions.map(({ inFrame, ...a }) => (inFrame ? { ...a, frameId } : a)));
      // The exports get what the modal hands them: the stored actions, and the variables they use.
      const actions = (await ctx.send({ type: 'GET_SCENARIOS' })).scenarios[id].actions;
      const used = getUsedVarNames(actions);
      const variables = Object.fromEntries(Object.entries((await ctx.send({ type: 'GET_VARIABLES' })).variables || {})
        .filter(([k]) => used.has(k)));
      const states = {};
      const runners = c.runners || ['bookmarklet', 'selenium', 'playwright'];

      const played = await play(ctx, id);
      if (played.timedOut) fail(`${c.name}: playback did not finish`);
      states.playback = exportStates.get(`${c.name}:playback`)?.state;

      if (runners.includes('bookmarklet')) {
        // With false Asserts, a tab of its own: the errors the bookmarklet logs for them are meant, not the test page's.
        const tab = c.failedAsserts ? await ctx.browser.openPage(startUrl('bookmarklet')) : ctx.web;
        if (c.failedAsserts) await sleep(PAGE_SETTLE_MS);
        else await ctx.web.goto(startUrl('bookmarklet'));
        const url = toBookmarkletUrl(generateBookmarklet(c.name, actions, { ...variables, ...pageVars('bookmarklet') }).code);
        for (let click = 1; click <= (c.bookmarkletClicks || 1); click++) {
          if (click > 1) await untilOn(tab, pageUrl(`${c.name}:bookmarklet`));
          // What a click on the bookmark runs: the URL, percent-decoded.
          await tab.evaluate(decodeURIComponent(url.slice('javascript:'.length)), BOOKMARKLET_RUN_TIMEOUT_MS)
            .catch((e) => fail(`${c.name}: the bookmarklet threw on click ${click}: ${e.message}`));
        }
        await sleep(SETTLE_MS);
        if (c.failedAsserts) await tab.close();
        states.bookmarklet = exportStates.get(`${c.name}:bookmarklet`)?.state;
        // Its alert that lists the false Asserts is one playback does not show: checked, then left out.
        if (c.failedAsserts && states.bookmarklet) {
          const summary = states.bookmarklet.alerts.filter((a) => /Assert\(s\) failed/.test(a));
          checkFailedAsserts(c, 'bookmarklet', summary.length === 1, summary.join('\n'));
          states.bookmarklet = { ...states.bookmarklet, alerts: states.bookmarklet.alerts.filter((a) => !summary.includes(a)) };
        }
      }

      if (!noPython && runners.includes('selenium')) {
        const file = join(dir, `${c.name}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('selenium') },
          { driverType: 'Edge', startUrl: startUrl('selenium'), headless: !HEADED }).code);
        // In the temporary folder: what the script saves (screenshots) lands there.
        const r = await runFile('python', [file], { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS });
        if (c.failedAsserts) checkFailedAsserts(c, 'Selenium', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Selenium script failed: ${String(r.stderr || r.error.message).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.selenium = exportStates.get(`${c.name}:selenium`)?.state;
        if (!headlessChecked && states.selenium) {
          headlessChecked = true;
          check(states.selenium.headless === !HEADED, `the Selenium script runs ${HEADED ? 'with' : 'without'} a window, as exported`, states.selenium.headless);
          // Headless, the window is the size a desktop page is recorded at, not a phone's.
          // (A 1920 px window is 1896 px inside here; the default was 756.)
          if (!HEADED) check(states.selenium.width >= 1800, 'the headless Selenium window is a desktop one, 1920 px wide', states.selenium.width);
        }
        checkFiles(c, 'Selenium', dir);
      }

      if (pwRun && runners.includes('playwright')) {
        const spec = `${c.name.replace(/\W/g, '_')}.spec.js`;
        writeFileSync(join(pwRun, spec), generatePlaywright(c.name, actions, { ...variables, ...pageVars('playwright') },
          { startUrl: startUrl('playwright') }).code);
        // The file by its name: Playwright reads the argument as a pattern, and a Windows path's \ escapes.
        const r = await runFile(process.execPath, [pwCli, 'test', spec, '--config', 'playwright.config.mjs'],
          { cwd: pwRun, timeout: PYTHON_RUN_TIMEOUT_MS });
        if (c.failedAsserts) checkFailedAsserts(c, 'Playwright', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Playwright test failed: ${String(r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.playwright = exportStates.get(`${c.name}:playwright`)?.state;
        checkFiles(c, 'Playwright', pwRun);
      }

      if (pytestHere && runners.includes('pytest')) {
        const file = join(dir, `test_${c.name.replace(/\W/g, '_')}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('pytest') },
          { driverType: 'Edge', startUrl: startUrl('pytest'), headless: !HEADED, output: 'pytest' }).code);
        const r = await runPytest(file, dir);
        if (c.failedAsserts) checkFailedAsserts(c, 'pytest', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the pytest test failed: ${String(r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.pytest = exportStates.get(`${c.name}:pytest`)?.state;
      }

      // Every case the Selenium script runs, the Robot test runs too.
      if (robotHere && runners.includes('selenium')) {
        const out = mkdtempSync(join(dir, 'robot-'));
        const file = join(out, `${c.name.replace(/\W/g, '_')}.robot`);
        writeFileSync(file, generateRobot(c.name, actions, { ...variables, ...pageVars('robot') },
          { driverType: 'Edge', startUrl: startUrl('robot'), headless: !HEADED }).code);
        const r = await runRobot(file, out);
        if (c.failedAsserts) checkFailedAsserts(c, 'Robot', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Robot test failed: ${String(r.stdout).trim().split('\n').filter((l) => !/^(Output|Log|Report):/.test(l)).slice(-6).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.robot = exportStates.get(`${c.name}:robot`)?.state;
        checkFiles(c, 'Robot', out);
      }

      // And the Java test.
      if (javaHere && runners.includes('selenium')) {
        const out = mkdtempSync(join(dir, 'java-'));
        const cls = javaClassName(c.name);
        writeFileSync(join(out, `${cls}.java`), generateJava(c.name, actions, { ...variables, ...pageVars('java') },
          { driverType: 'Edge', startUrl: startUrl('java'), headless: !HEADED }).code);
        const r = await runJava(join(out, `${cls}.java`), cls, out);
        if (c.failedAsserts) checkFailedAsserts(c, 'Java', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Java test failed: ${String(r.stdout + r.stderr).trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-6).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.java = exportStates.get(`${c.name}:java`)?.state;
        checkFiles(c, 'Java', out);
      }

      // Fields not named in `expect` are taken as playback left them.
      const expected = { clicks: [], alerts: [], marks: [], ...c.expect, fields: { ...states.playback?.fields, ...c.expect?.fields } };
      const wanted = stateDiff(states.playback, expected);
      check(states.playback && !Object.keys(wanted).length, `${c.name}: playback leaves the expected page`, wanted);
      for (const runner of ['bookmarklet', 'selenium', 'pytest', 'playwright', 'robot', 'java']) {
        if (!(runner in states)) continue;
        const diff = stateDiff(states.playback, states[runner]);
        check(states[runner] && !Object.keys(diff).length,
          `${c.name}: the ${runner} export leaves the page as playback does`, states[runner] ? diff : 'no state posted');
      }
    }
    if (!CASES || CASES.includes('csv-data')) {
      await checkCsvData(ctx, { dir, pageUrl, pytestHere, pwRun, pwCli, robotHere, javaHere, generateSeleniumPy, generatePlaywright,
        generateRobot, robotReaderPy, ROBOT_READER_FILE, generateJava, javaClassName });
    }
    if (!CASES || CASES.includes('env')) {
      await checkEnvOverrides(ctx, { dir, noPython, pwRun, pwCli, robotHere, javaHere, generateSeleniumPy, generatePlaywright, generateRobot, generateJava, javaClassName });
    }
    if (!CASES || CASES.includes('fails-at-step')) {
      await checkFailsAtStep(ctx, { dir, pageUrl, noPython, pytestHere, pwRun, pwCli, robotHere, javaHere, generateBookmarklet, toBookmarkletUrl,
        generateSeleniumPy, generatePlaywright, generateRobot, generateJava, javaClassName });
    }
    if (pytestHere && !CASES) {
      const file = join(dir, 'test_failing_step.py');
      writeFileSync(file, generateSeleniumPy('failing step', [
        { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
        { type: 'click', selector: '#nowhere', selectors: { css: '#nowhere' } },
      ], {}, { driverType: 'Edge', startUrl: pageUrl('failing-step:pytest'), headless: !HEADED, output: 'pytest', elTimeout: 1000 }).code);
      const r = await runPytest(file, dir);
      const out = String(r.stdout);
      const summary = out.trim().split('\n').pop();
      check(r.error && /# Step 2: click/.test(out) && /^1 failed in /.test(summary),
        'a pytest test fails on the step that fails, and its browser is closed (no teardown error)', summary);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (pwRun) rmSync(pwRun, { recursive: true, force: true });
    // The checks after this one reload the test page.
    await ctx.web.goto(`${ctx.base}/page`);
    await sleep(PAGE_SETTLE_MS);
  }
}

async function checkRecordUntrusted(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record untrusted', async () => {
    await ctx.web.evaluate(`document.getElementById('bg2').click();
      const out = document.getElementById('out');
      out.value = 'set by script';
      out.dispatchEvent(new Event('input', { bubbles: true }));`);
    await sleep(600); // past the input debounce
    await clickAt(ctx, '#bg1');
  });
  check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #bg1',
    'a click and an input event the page dispatches itself are not recorded', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
}

async function checkRecordCheckbox(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record checkbox', async () => {
    await clickAt(ctx, '#agree');
    await sleep(600); // past the input debounce
  });
  check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #agree',
    'ticking a checkbox records the click only, not an Input of its value', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
}

async function checkRecordInputOrder(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record input order', async () => {
    await clickAt(ctx, '#out');
    await ctx.web.send('Input.insertText', { text: 'Alice' });
    await clickAt(ctx, '#bg1'); // within the input debounce
  });
  check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #out,input #out,click #bg1',
    'text typed just before a click is recorded before it', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
}

async function checkRecordOtherTab(ctx) {
  await reloadTestPage(ctx);
  const other = await ctx.browser.openPage(`${ctx.base}/page?other`, { width: 1000, height: 700 });
  await sleep(PAGE_SETTLE_MS);
  try {
    const { actions } = await record(ctx, 'e2e record other tab', async () => {
      await other.bringToFront();
      await other.evaluate(`document.getElementById('out').focus()`);
      await other.send('Input.insertText', { text: 'typed elsewhere' });
      await sleep(600); // past the input debounce
      await ctx.web.bringToFront();
      await clickAt(ctx, '#bg1');
    });
    check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #bg1',
      'typing in another tab is not recorded; the recording tab still is', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
  } finally {
    await other.close();
  }
}

// Last in CHECKS: it stops the worker, and ctx.sw stays attached to the one that was stopped.
async function checkRecordRestart(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record restart', async () => {
    // Stands in for the worker going to sleep before the first click.
    await ctx.ext.send('ServiceWorker.enable');
    await ctx.ext.send('ServiceWorker.stopAllWorkers');
    await sleep(WORKER_STOP_SETTLE_MS);
    await clickAt(ctx, '#bg1');
  });
  check(actions.map((a) => a.selector).join() === '#bg1',
    'a recording whose worker stopped before the first action still records it', actions.map((a) => `${a.type} ${a.selector}`));
}

async function checkCsvZipAdvanced(ctx) {
  const state = `(() => { const d = document.getElementById('csvZipAdvanced');
    document.getElementById('csvRunCard').classList.remove('collapsed');
    return { shown: getComputedStyle(d).display !== 'none', open: d.open, name: document.getElementById('csvZipFolderName').value,
      rowNumber: document.getElementById('csvZipRowNumber').checked }; })()`;
  const reopen = async (stored) => {
    await ctx.ext.evaluate(`chrome.storage.local.set(${JSON.stringify(stored)})`);
    const popup = await openPopup(ctx);
    const s = await popup.evaluate(state);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    return { popup, s };
  };
  let { popup, s } = await reopen({ csvExportFormat: 'xlsx', csvZipFolderName: '' });
  check(!s.shown, 'XLSX: the ZIP Advanced section is hidden', s);
  // Set by code, as the restore does: no change event.
  await popup.evaluate(`document.getElementById('csvExportFormat').value = 'zip'`);
  s = await popup.evaluate(state);
  check(s.shown && !s.open, 'ZIP chosen: Advanced shows, closed', s);
  await popup.close();
  ({ popup, s } = await reopen({ csvExportFormat: 'zip', csvZipFolderName: 'abc ${name}', csvZipRowNumber: true }));
  check(s.shown && s.open && s.name === 'abc ${name}' && s.rowNumber,
    'reopened on ZIP with a saved folder name: shown, open, name and Add row number kept', s);
  await popup.evaluate(`(() => { const i = document.getElementById('csvZipFolderName'); i.value = 'x \${id}'; i.dispatchEvent(new Event('input'));
    document.getElementById('csvZipRowNumber').click(); })()`);
  await sleep(SETTLE_MS);
  const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get(['csvZipFolderName', 'csvZipRowNumber'], r))`);
  check(saved.csvZipFolderName === 'x ${id}' && saved.csvZipRowNumber === false, 'a typed folder name and the checkbox are saved', saved);
  await popup.close();
  ({ popup, s } = await reopen({ csvExportFormat: 'xlsx' }));
  check(!s.shown, 'reopened on XLSX: hidden again', s);
  await popup.close();
  await ctx.ext.evaluate(`chrome.storage.local.remove(['csvExportFormat', 'csvZipFolderName', 'csvZipRowNumber'])`);
}

async function checkCsvZipSuggest(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { env: 'qa', unused: 'x' } });
  const id = await makeScenario(ctx, 'e2e csv zip suggest', [
    { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${env}', delay: 0 },
    { type: 'readdom', selector: '#total', selectors: { css: '#total' }, varName: 'order', readFrom: 'text', delay: 0 },
  ]);
  const keys = ['csvExportFormat', 'csvZipFolderName', 'csvSessionData', 'csvScenarioId'];
  await ctx.ext.evaluate(`chrome.storage.local.remove(${JSON.stringify(keys)})`);
  await ctx.ext.evaluate(`chrome.storage.local.set({ csvExportFormat: 'zip' })`);
  // A new popup with nothing chosen in the CSV card: type "abc ${" key by key.
  const typeInFolderName = async (popup) => {
    await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabData"]').click();
      document.getElementById('csvRunCard').classList.remove('collapsed');
      document.getElementById('csvZipAdvanced').open = true;
      const i = document.getElementById('csvZipFolderName'); i.value = ''; i.focus();
    })()`);
    for (const ch of 'abc ${') {
      await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(SETTLE_MS);
    return popup.evaluate(`[...document.querySelectorAll('.var-suggest .vs-name')].map((e) => e.textContent)`);
  };
  let popup = await openPopup(ctx);
  try {
    let names = await typeInFolderName(popup);
    check(names.includes('env') && names.includes('unused'),
      'Folder name, no scenario ever chosen and no CSV: ${ lists the Data tab variables', names);
    // Choose a scenario and load a CSV once, as a user does, then open a new popup.
    await popup.evaluate(`(() => { const s = document.getElementById('csvScenarioSelect'); s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const csvDir = mkdtempSync(join(tmpdir(), 'pqa-csv-'));
    writeFileSync(join(csvDir, 'people.csv'), 'name,city\njohn,HN\n');
    const { result } = await popup.send('Runtime.evaluate', { expression: `document.getElementById('csvFile')` });
    await popup.send('DOM.getDocument', {});
    await popup.send('DOM.setFileInputFiles', { files: [join(csvDir, 'people.csv')], objectId: result.objectId });
    await sleep(SETTLE_MS);
    rmSync(csvDir, { recursive: true, force: true });
    await popup.close();
    popup = await openPopup(ctx);
    names = await typeInFolderName(popup);
    check(['name', 'city', 'order', 'env'].every((n) => names.includes(n)) && !names.includes('unused'),
      'reopened with nothing chosen: the last CSV\'s columns, what the last scenario writes and the Data tab variables it reads', names);
    for (const type of ['keyDown', 'keyUp']) await popup.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(SETTLE_MS);
    const value = await popup.evaluate(`document.getElementById('csvZipFolderName').value`);
    const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('csvZipFolderName', (s) => r(s.csvZipFolderName)))`);
    check(/^abc \$\{\w+\}$/.test(value) && saved === value, 'Enter inserts ${name}, and the folder name is saved', { value, saved });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove(${JSON.stringify(keys)})`);
  }
}

/** The file names inside a ZIP, from its central directory. */
function zipNames(file) {
  const b = readFileSync(file);
  const eocd = b.length - 22; // the ZIP export writes no archive comment
  const names = [];
  for (let off = b.readUInt32LE(eocd + 16), n = b.readUInt16LE(eocd + 10); n > 0; n--) {
    const len = b.readUInt16LE(off + 28);
    names.push(b.toString('utf8', off + 46, off + 46 + len));
    off += 46 + len + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
  }
  return names;
}

async function checkCsvZipRun(ctx) {
  await reloadTestPage(ctx);
  // kate's row expects a text #bg1 does not have: her Assert fails. The second john's
  // checks an element that is not there: the test is broken. The first john passes.
  const rows = [{ name: 'john', expect: 'bg1', sel: '#bg1' }, { name: 'kate', expect: 'nope', sel: '#bg1' },
    { name: 'john', expect: 'bg1', sel: '#gone' }];
  // Two Screenshot → Variable: one with a Filename, which only the ZIP uses.
  const id = await makeScenario(ctx, 'e2e csv zip', [
    { type: 'screenshot_tovar', target: 'page', varName: 'after', value: '${name}_after', delay: 0 },
    { type: 'screenshot_tovar', target: 'page', varName: 'shot', delay: 0 },
    { type: 'assert', conditionType: 'textEquals', selector: '${sel}', selectors: { css: '${sel}' }, expectedValue: '${expect}', delay: 0 },
  ]);
  await ctx.ext.evaluate(`chrome.storage.local.set(${JSON.stringify({
    csvSessionData: { headers: ['name', 'expect', 'sel'], rows }, csvExportFormat: 'zip', csvZipFolderName: 'abc ${name}', csvZipRowNumber: false })})`);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_CSV_PLAYBACK', scenarioId: id, rows, delayBetween: 100, exportFormat: 'zip' });
  await sleep(SETTLE_MS);
  for (let waited = 0; waited < PLAY_TIMEOUT_MS && (await ctx.send({ type: 'GET_CSV_STATUS' }))?.active; waited += POLL_MS) await sleep(POLL_MS);
  const popup = await openPopup(ctx);
  // Each Download click (in `format`; the select is locked, code can still set it):
  // the path of the file that appears in the download folder.
  const download = async (format) => {
    const files = () => readdirSync(ctx.browser.downloadDir).filter((f) => f.endsWith(`.${format}`));
    const before = new Set(files());
    await popup.evaluate(`document.getElementById('csvExportFormat').value = '${format}'; document.getElementById('csvDownloadResult').click()`);
    for (let waited = 0; waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
      const added = files().find((f) => !before.has(f));
      if (added) { await sleep(SETTLE_MS); return join(ctx.browser.downloadDir, added); }
      await sleep(POLL_MS);
    }
    throw new Error(`no .${format} downloaded`);
  };
  const entries = (folders) => ['results.csv', ...folders.flatMap((f, i) => [`${f}/${rows[i].name}_after.png`, `${f}/shot.png`])];
  try {
    const progress = await popup.evaluate(`document.getElementById('pbPanelCsvProgText')?.textContent`);
    check(progress === '1 passed · 1 failed · 1 broken', 'the finished run counts its rows by verdict', progress);
    const zipPath = await download('zip');
    const resultsCsv = readFileSync(zipPath, 'utf8');
    check(resultsCsv.includes('"name","expect","sel","after","shot","Run Result","Action Failed"')
      && resultsCsv.includes('"✗ Failed","[3] assert: Expected text ""nope"", got ""bg1"""')
      && resultsCsv.includes('"⚠ Test broken","[3] assert: Element not found — could not check"')
      && (resultsCsv.match(/"✓ Passed",""/g) || []).length === 1,
    'results.csv: a Run Result per row, and the failed Assert with its reason', resultsCsv.split('results.csv')[1]?.slice(0, 400));
    const named = zipNames(zipPath);
    check(JSON.stringify(named) === JSON.stringify(entries(['abc john', 'abc kate', 'abc john_2'])),
      'ZIP named "abc ${name}": abc john, abc kate, abc john_2; the Filename ${name}_after names its image', named);
    await popup.evaluate(`document.getElementById('csvZipRowNumber').click()`);
    const numbered = zipNames(await download('zip'));
    check(JSON.stringify(numbered) === JSON.stringify(entries(['abc john_01', 'abc kate_02', 'abc john_03'])),
      'with Add row number: abc john_01, abc kate_02, abc john_03 — downloaded again, no new run', numbered);
    // HTML and XLSX: the variables' columns and images as before; the Filename is nowhere.
    const html = readFileSync(await download('html'), 'utf8');
    const xlsx = readFileSync(await download('xlsx')).toString('latin1');
    check(/<th[^>]*>after<\/th>/.test(html) && (html.match(/<img /g) || []).length === 6 && !html.includes('_after')
      && xlsx.includes('xl/media/image6.png') && !xlsx.includes('_after'),
    'HTML / XLSX: one column per variable, six images, no Filename', { imgs: (html.match(/<img /g) || []).length });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove(['csvSessionData', 'csvExportFormat', 'csvZipFolderName', 'csvZipRowNumber'])`);
  }
}

const CHECKS = [
  ['dropdown', 'Dropdown', checkDropdown],
  ['switch', 'Switch Always and the Random cap', checkSwitchAlways],
  ['capture', 'Two visible screenshots in a row', checkCapture],
  ['overlays', 'The countdown, failed-action prompt and segment bar, loaded when needed', checkOverlays],
  ['suggest', 'Variable suggestions in the popup', checkSuggest],
  ['var-name-guard', 'A variable name already taken, or one no ${…} can reach', checkVarNameGuard],
  ['var-rename', 'A variable renamed in the Data tab, and in the scenarios using it', checkVarRename],
  ['switch-draft', 'Switch draft in the popup', checkSwitchDraft],
  ['edit-follows-list', 'An action open in the form while its list changes', checkEditFollowsList],
  ['numbers-by-position', 'Every action numbered by its position, in a Switch block too', checkNumbersByPosition],
  ['switch-insert', 'A new Switch over actions already in the list', checkNewSwitchOverActions],
  ['background-tab', 'A run in a background tab', checkBackgroundTab],
  ['label-click', 'A click on a label, recorded and played', checkLabelClick],
  ['child-condition', 'Child Condition: innermost text match, ALL', checkChildCondition],
  ['file-input', 'A file input, recorded and played', checkFileInput],
  ['hotkeys', 'Record hotkeys: activated tabs only, macOS Option', checkHotkeys],
  ['schedule', 'A scheduled run on its start URL', checkSchedule],
  ['record-overlay', 'Recording ignores the extension overlays', checkRecordOverlay],
  ['condition-unknown', 'A Condition of an unknown type', checkConditionUnknown],
  ['assert', 'Assert: waited for, and a false one does not stop the run', checkAssert],
  ['last-run', 'The Last run card in the popup', checkLastRun],
  ['selector-choice', 'The selector type chosen in the form plays first', checkSelectorChoice],
  ['shadow-dom', 'Elements in a shadow root', checkShadowDom],
  ['select-type', 'Child Condition type "select"', checkSelectType],
  ['form-roundtrip', 'Every action type through Edit → Save', checkFormRoundtrip],
  ['highlight', 'Highlights: made, saved, painted again after a reload', checkHighlight],
  ['import-warning', 'Importing actions that reach beyond the page', checkImportWarning],
  ['condition-choice', 'Condition and element screenshot use the chosen selector type', checkConditionChoice],
  ['cdp-targets', 'Upload, Dropdown and element screenshot act on the element the page found', checkCdpTargets],
  ['cdp-frames', 'Upload, Dropdown and element screenshot inside a frame', checkCdpFrames],
  ['click-through', 'Click through: off for the scenario or the action', checkClickThrough],
  ['typed-text', 'A Text selector typed in the form', checkTypedText],
  ['select-missing', 'Input of an option a <select> does not have', checkSelectMissing],
  ['export-file-name', 'The file name of an exported script', checkExportFileName],
  ['export-robot-data', 'The Robot export with a data file: the test and its reader', checkExportRobotData],
  ['export-steps', 'The export modal tells which steps were skipped', checkExportSteps],
  ['export-regenerate', 'Reload scenario in the export modals', checkExportRegenerate],
  ['export-headless', 'The Headless switch of the Selenium export', checkExportHeadless],
  ['export-start-url', 'The Selenium start URL taken from the tab', checkExportStartUrl],
  ['export-url-field', 'The Starting URL field of the export Settings', checkExportUrlField],
  ['export-output', 'The Output choice of the Selenium export', checkExportOutput],
  ['export-settings', 'The export Settings, kept between popups', checkExportSettings],
  ['export-live-settings', 'The export code follows its Settings', checkExportLiveSettings],
  ['export-layout', 'The export modal\'s size in a 600 and a 500 px popup', checkExportLayout],
  ['export-jump', 'From a row of the Actions tab to its code', checkExportJump],
  ['export-formats', 'The formats the Export Code card offers', checkExportFormats],
  ['export-card', 'The Export Code card: its buttons and its list', checkExportCard],
  ['export-tabs-keyboard', 'The export modal\'s tabs by keyboard', checkExportTabsKeyboard],
  ['export-playwright', 'The Playwright Test export in the popup', checkExportPlaywright],
  ['export-run', 'Exported code run on a page, as playback leaves it', checkExportRun],
  ['record-untrusted', 'Recording ignores events the page dispatches', checkRecordUntrusted],
  ['record-checkbox', 'Ticking a checkbox while recording', checkRecordCheckbox],
  ['record-input-order', 'Typing, then a click at once', checkRecordInputOrder],
  ['record-other-tab', 'Recording ignores the other tabs', checkRecordOtherTab],
  ['record-restart', 'A recording across a worker restart', checkRecordRestart],
  ['csv-zip-advanced', 'The ZIP\'s Advanced section in the CSV card', checkCsvZipAdvanced],
  ['csv-zip-suggest', 'Variable suggestions in the ZIP Folder name', checkCsvZipSuggest],
  ['csv-zip-run', 'A CSV run downloaded as a ZIP with named folders', checkCsvZipRun],
];

async function main() {
  if (ONLY && !CHECKS.some(([name]) => name === ONLY)) {
    console.error(`e2e: no check named "${ONLY}" (${CHECKS.map(([n]) => n).join(', ')})`);
    process.exit(1);
  }
  const server = await new Promise((res) => {
    const s = createServer((req, reply) => {
      if (req.method === 'POST' && req.url === '/state') { saveExportState(req, reply); return; }
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
    for (const [name, title, run] of CHECKS) {
      if (ONLY && ONLY !== name) continue;
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
