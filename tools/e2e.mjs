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

import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asActiveTab, launchWithExtension, sleep } from './lib/cdp-browser.mjs';
import { DRAFT_SAVE_MS, EXT, HEADED, PAGE_SETTLE_MS, POLL_MS, POPUP_SETTLE_MS, POPUP_VIEWPORT, SETTLE_MS, argValue, args, check, clickAt, closeQuietly, exportStates, fail, failures, makeScenario, ok, openPopup, pageSoon, play, pngSize, record, reloadTestPage, showScenario } from './e2e/harness.mjs';
import { CHECKS as exportRunChecks, EXPORT_PAGE, saveExportState } from './e2e/export-run.mjs';
import { CHECKS as apiChecks, apiRoute } from './e2e/api.mjs';
import { FRAME_PAGE, TEST_PAGE } from './e2e/test-pages.mjs';
import { CHECKS as varsChecks } from './e2e/vars.mjs';
import { CHECKS as exportChecks } from './e2e/export.mjs';
import { CHECKS as csvChecks } from './e2e/csv.mjs';
import { CHECKS as pagesChecks } from './e2e/pages.mjs';
const ONLY = argValue('--only')?.split(',') || null;
const SUITE = argValue('--suite')?.split(',') || null;
const LIST = args.includes('--list');
// After the worker is stopped: long enough for it to be gone before the next message wakes it.
const WORKER_STOP_SETTLE_MS = 1000;

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

async function checkPreviewNoFlash(ctx) {
  const id = await makeScenario(ctx, 'e2e no flash', [
    { type: 'click', selector: '#a1' }, { type: 'click', selector: '#a2' }, { type: 'click', selector: '#a3' },
  ]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(id)} })`);
  const popup = await openPopup(ctx);
  // The list as each task leaves it — what the popup can paint, and size itself to.
  await popup.evaluate(`(() => {
    const list = document.getElementById('actions');
    window.__shown = [];
    new MutationObserver(() => __shown.push(list.querySelectorAll('li.action').length + (list.querySelector('.action-loading') ? ' loading' : '')))
      .observe(list, { childList: true });
  })()`);
  const rows = `[...document.querySelectorAll('#actions li.action')]`;
  const toggle = async (verb) => {
    await popup.evaluate(`__shown = []; document.querySelector('#actions button[aria-label^="${verb} action 2:"]').click()`);
    await sleep(SETTLE_MS);
    return popup.evaluate(`({ shown: __shown, disabled: ${rows}.map((li) => li.classList.contains('action-disabled')),
      button: ${rows}[1].querySelector('.btn-row button').textContent })`);
  };
  const off = await toggle('Disable');
  check(off.disabled.join() === 'false,true,false' && off.button === 'Enable', 'Disable greys out that action only, its button now Enable', off);
  check(off.shown.length > 0 && off.shown.every((s) => s === '3'), 'the list never empties or shows Loading… on the way', off.shown);
  const { scenarios } = await ctx.send({ type: 'GET_SCENARIOS' });
  check(scenarios[id].actions.map((a) => !!a.disabled).join() === 'false,true,false', 'the scenario has it disabled', scenarios[id].actions);
  const on = await toggle('Enable');
  check(on.disabled.join() === 'false,false,false' && on.button === 'Disable' && on.shown.every((s) => s === '3'), 'Enable puts it back, again without a flash', on);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

async function checkFolderFilter(ctx) {
  const { id: folder } = await ctx.send({ type: 'CREATE_FOLDER', name: 'e2e kept folder' });
  const { id: inside } = await ctx.send({ type: 'CREATE_SCENARIO', name: 'e2e in the folder', folderId: folder });
  await makeScenario(ctx, 'e2e in no folder', []);
  const popup = await openPopup(ctx);
  const state = () => popup.evaluate(`({ filter: document.getElementById('filterFolder').value,
    index: document.getElementById('filterFolder').selectedIndex, selected: document.getElementById('scenarioList').value,
    listed: [...document.getElementById('scenarioList').options].map((o) => o.value).filter(Boolean).join() })`);
  const pick = (id, value) => popup.evaluate(`(() => { const s = document.getElementById(${JSON.stringify(id)});
    s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  const reopen = async () => { await popup.reload(); await sleep(POPUP_SETTLE_MS); return state(); };

  await pick('filterFolder', folder);
  await sleep(SETTLE_MS);
  const chosen = await state();
  check(chosen.filter === folder && chosen.listed === inside, 'the folder filter lists that folder\'s scenarios', chosen);
  await popup.evaluate(`document.getElementById('newFolderInput').value = 'e2e another folder'; document.getElementById('createFolderAction').click()`);
  await sleep(SETTLE_MS * 2);
  const rebuilt = await state();
  check(rebuilt.filter === folder && rebuilt.listed === inside, 'creating a folder, which rebuilds the folder lists, keeps the filter', rebuilt);
  const reopened = await reopen();
  check(reopened.filter === folder && reopened.listed === inside, 'a reopened popup keeps the filter', reopened);

  // Moved out of the folder shown, the chosen scenario stays listed and chosen: the filter shows all.
  await pick('scenarioList', inside);
  await pick('moveToFolderSelect', '');
  await popup.evaluate(`document.getElementById('doMoveToFolder').click()`);
  await sleep(SETTLE_MS * 2);
  const moved = await state();
  check(moved.filter === '' && moved.selected === inside, 'a scenario moved out of the folder shown stays chosen, all folders shown', moved);
  const movedReopened = await reopen();
  check(movedReopened.filter === '' && movedReopened.selected === inside, 'and so after a reopen', movedReopened);

  await pick('filterFolder', folder);
  await ctx.send({ type: 'DELETE_FOLDER', folderId: folder });
  const gone = await reopen();
  check(gone.filter === '' && gone.index === 0, 'its folder deleted, a reopened popup shows All Folders', gone);
  const { folders } = await ctx.send({ type: 'GET_FOLDERS' });
  for (const [id, f] of Object.entries(folders)) if (f.name === 'e2e another folder') await ctx.send({ type: 'DELETE_FOLDER', folderId: id });
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
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

/** Scenario `id`'s actions as stored. */
const storedActions = (popup, id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);

async function checkPasteEmpty(ctx) {
  const from = await makeScenario(ctx, 'e2e paste from', [{ type: 'click', selector: '#a', selectors: { css: '#a' } }]);
  const { id: to } = await ctx.send({ type: 'CREATE_SCENARIO', name: 'e2e paste into empty' });
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, from);
    await rowButton(popup, 0, 2);
    await showScenario(popup, to);
    const shown = await popup.evaluate(`({ paste: !!document.querySelector('#actions .action-paste-btn'), empty: document.querySelector('#actions li.empty')?.textContent })`);
    check(shown.paste && /card below/.test(shown.empty || ''), 'an empty scenario shows the Paste row, and the card it points to is below', shown);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn')?.click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await storedActions(popup, to);
    check(acts.length === 1 && acts[0].selector === '#a', 'Paste into the empty scenario adds the copied action', acts);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

async function checkSaveSelects(ctx) {
  // An unsaved draft of two actions, nothing selected, as after a first recording.
  await ctx.send({ type: 'START_NEW_SCENARIO' });
  for (const sel of ['#a', '#b']) await ctx.send({ type: 'ADD_MANUAL_ACTION', action: { type: 'click', selector: sel, selectors: { css: sel } } });
  await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
      document.getElementById('scenarioName').value = 'e2e saved and kept';
      document.getElementById('saveFlow').click();
    })()`);
    await sleep(POPUP_SETTLE_MS * 2);
    const after = await popup.evaluate(`(() => {
      const list = document.getElementById('scenarioList');
      return { name: list.options[list.selectedIndex]?.textContent || '', play: !document.getElementById('playScenario').disabled,
        rows: document.querySelectorAll('#actions li.action').length, toast: document.getElementById('toast').textContent,
        notice: document.getElementById('autoSaveNotice').textContent };
    })()`);
    check(after.name === 'e2e saved and kept' && after.play && after.rows === 2,
      'after Save the scenario stays selected: its 2 actions listed, ▶ Play ready', after);
    check(/Saved "e2e saved and kept" — press ▶ Play/.test(after.toast) && /To start another one/.test(after.notice),
      'the toast points to Play, and the notice says how to start another scenario', after);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

/**
 * Add Action on scenario `id` with the page scrolled past the top of the card, as
 * after filling a long form: where the card and the new row (`last`) end up.
 */
async function addFromBelow(popup, id, last) {
  await showScenario(popup, id);
  await popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const type = document.getElementById('manualActionType'); type.value = 'click'; type.dispatchEvent(new Event('change'));
    document.getElementById('manualSelector').value = '#added';
    const card = document.getElementById('addManualActionCard');
    // body's overflow goes to the viewport: the document scrolls, not body.
    document.scrollingElement.scrollTop += card.getBoundingClientRect().top + 250;
  })()`);
  await sleep(SETTLE_MS);
  const before = await popup.evaluate(`Math.round(document.getElementById('addManualActionCard').getBoundingClientRect().top)`);
  await popup.evaluate(`document.getElementById('addManualAction').click()`);
  await sleep(POPUP_SETTLE_MS);
  return popup.evaluate(`(() => {
    const card = document.getElementById('addManualActionCard').getBoundingClientRect();
    const list = document.getElementById('actions');
    const row = list.querySelector('li.action[data-index="${last}"]')?.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    // The fixed header covers the top of the page: "in view" is below it.
    const bar = Math.round(document.querySelector('.sticky-header').getBoundingClientRect().bottom);
    return { before: ${before}, bar, cardTop: Math.round(card.top), rowShown: !!row && row.top >= box.top - 1 && row.bottom <= box.bottom + 1, listScroll: list.scrollTop };
  })()`);
}

async function checkFormScroll(ctx) {
  const click = (i) => ({ type: 'click', selector: `#row${i}`, selectors: { css: `#row${i}` } });
  const long = await makeScenario(ctx, 'e2e form scroll', Array.from({ length: 30 }, (_, i) => click(i + 1)));
  const short = await makeScenario(ctx, 'e2e form scroll short', [click(1), click(2), click(3)]);
  const popup = await openPopup(ctx, { width: 480, height: 600 });
  try {
    const a = await addFromBelow(popup, long, 30);
    check(a.before < 0 && a.cardTop >= a.bar && a.cardTop < 600, 'Add Action brings the Add Manual Action card back into view, below the header', a);
    check(a.rowShown && a.listScroll > 0, 'the list scrolls to the action just added', a);
    // A short list grows by the new row: the page scrolls once that row is in, so
    // the card still lands at the top rather than as far below as the row is tall.
    const b = await addFromBelow(popup, short, 3);
    check(b.before < 0 && b.cardTop >= b.bar && b.cardTop <= b.bar + 12, 'with a short list growing by the new row, the card lands right below the header', b);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

async function checkCopySwitchBlock(ctx) {
  const id = await makeScenario(ctx, 'e2e copy switch block', switchBlockActions());
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    await rowButton(popup, 3, 2);
    const label = await popup.evaluate(`document.querySelector('#actions .action-paste-btn')?.textContent`);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await storedActions(popup, id);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.selector)).join(' | ');
    const invalid = await popup.evaluate(`document.querySelectorAll('#actions li.sw-invalid, #actions .sw-warn').length`);
    check(label === '📋 Paste: switch + 3 actions' && invalid === 0
      && shape === '#a | #b | #c | switch 5–6 7–7 | #menu | #settings | #profile | #logout | #new | switch 11–12 13–13 | #menu | #settings | #profile',
    'Copy on a Switch takes its block; pasted, the new Switch runs its own copies', { label, invalid, shape });
    await popup.evaluate(`document.getElementById('undoAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const undone = (await storedActions(popup, id)).length;
    check(undone === 9, 'one Undo takes the whole pasted block away', undone);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

async function checkInsertPoint(ctx) {
  const id = await makeScenario(ctx, 'e2e insert point', switchBlockActions());
  const popup = await openPopup(ctx);
  const note = () => popup.evaluate(`(() => { const n = document.getElementById('insertPointNote'); return n.hidden ? '' : n.textContent.trim(); })()`);
  const fill = (type, selector) => popup.evaluate(`(() => {
    const t = document.getElementById('manualActionType'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change'));
    document.getElementById('manualSelector').value = ${JSON.stringify(selector)};
  })()`);
  const add = async () => { await popup.evaluate(`document.getElementById('addManualAction').click()`); await sleep(POPUP_SETTLE_MS); };
  const shape = async () => (await storedActions(popup, id)).map((a) => {
    if (a.type === 'switch') return `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}`;
    return a.type === 'condition' ? `if ${a.skipCount}` : a.selector;
  }).join(' | ');
  try {
    await showScenario(popup, id);
    await popup.evaluate(`document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      document.querySelector('#actions li.action[data-index="4"] .ins-gap').click()`);
    await sleep(SETTLE_MS);
    const ghost = await popup.evaluate(`(() => { const g = document.querySelector('#actions li.action-ghost');
      return { after: g?.previousElementSibling?.dataset.index, depth: g?.style.getPropertyValue('--sw-depth'), sub: g?.querySelector('.value-sub')?.textContent }; })()`);
    const picked = await note();
    check(ghost.after === '4' && ghost.depth === '1' && /#6 · Switch 4 › case "admin"/.test(ghost.sub || '') && /Insert at #6/.test(picked),
      '+ under row 5 puts the dummy row right under it, in case "admin"', { ghost, picked });
    await fill('click', '#x1'); await add();
    await fill('click', '#x2'); await add();
    const two = await shape();
    check(two === '#a | #b | #c | switch 5–8 9–9 | #menu | #x1 | #x2 | #settings | #profile | #logout | #new',
      'two adds in a row go in at the place, one after the other, inside the case', two);
    await fill('condition', '#guard');
    await sleep(POPUP_SETTLE_MS);
    const runTo = await popup.evaluate(`[...document.getElementById('conditionRunTo').options].map((o) => o.textContent)`);
    check(runTo.includes('Only the next action'), 'a Condition at the place counts the actions after the place', runTo);
    await popup.evaluate(`(() => { const r = document.getElementById('conditionRunTo'); r.value = '1'; r.dispatchEvent(new Event('change')); })()`);
    await add();
    await rowButton(popup, 0, 2);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn').click()`);
    await sleep(POPUP_SETTLE_MS);
    const pasted = await shape();
    check(pasted === '#a | #b | #c | switch 5–10 11–11 | #menu | #x1 | #x2 | if 2 | #a | #settings | #profile | #logout | #new',
      'the Condition guards the action after the place; Paste goes in at the place, under it', pasted);
    await popup.evaluate(`document.getElementById('undoAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    check(await note() === '' && !(await popup.evaluate(`!!document.querySelector('#actions li.action-ghost')`)), 'Undo drops the insertion point', await note());
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

/** The popup opened again as the toolbar button opens it: one load, so it restores what was kept once. */
async function reopenPopup(ctx) {
  const popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
  await sleep(POPUP_SETTLE_MS);
  return popup;
}

/**
 * The popup after an element was picked on the page: the worker opens it
 * (chrome.action.openPopup), and that one takes what the pick kept, so another
 * opened beside it would find nothing. Where the browser does not let the worker
 * open it, the toolbar button does.
 */
async function popupAfterPick(ctx) {
  const opened = await ctx.browser.pageOpenedAt(ctx.extUrl('popup.html'), POPUP_SETTLE_MS);
  if (!opened) return reopenPopup(ctx);
  await sleep(POPUP_SETTLE_MS);
  return opened;
}

async function checkInsertPointPick(ctx) {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const id = await makeScenario(ctx, 'e2e insert point pick', [click('a'), click('b'), click('c')]);
  const placeOf = (popup) => popup.evaluate(`(() => { const g = document.querySelector('#actions li.action-ghost');
    const n = document.getElementById('insertPointNote');
    return { after: g?.previousElementSibling?.dataset.index ?? null, note: n.hidden ? '' : n.textContent.trim(),
      selector: document.getElementById('manualSelector').value }; })()`);
  const add = async (popup) => { await popup.evaluate(`document.getElementById('addManualAction').click()`); await sleep(POPUP_SETTLE_MS); };
  const shape = async (popup) => (await storedActions(popup, id)).map((a) => a.selector).join(' | ');
  let popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    await popup.evaluate(`(() => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      document.querySelector('#actions li.action[data-index="0"] .ins-gap').click();
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
    })()`);
    await sleep(SETTLE_MS);
    // 🎯 keeps the form and closes the popup; the element is clicked on the page.
    await popup.evaluate(`document.getElementById('pickElement').click()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceA');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    const picked = await placeOf(popup);
    check(picked.selector === '#choiceA' && picked.after === '0' && /Insert at #2/.test(picked.note),
      'after 🎯 Pick the popup comes back with the place picked by + (under row 1)', picked);
    await add(popup);
    const one = await shape(popup);
    check(one === '#a | #choiceA | #b | #c', 'the action whose element was picked goes in at the place, not last', one);
    // The popup closed with an action half filled in: its draft keeps the place too.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('manualSelector'); s.value = '#x'; s.dispatchEvent(new Event('input'));
    })()`);
    await sleep(DRAFT_SAVE_MS);
    await closeQuietly(popup);
    popup = await reopenPopup(ctx);
    const drafted = await placeOf(popup);
    check(drafted.selector === '#x' && drafted.after === '1' && /Insert at #3/.test(drafted.note),
      'a draft brought back keeps the place: right after the action just added', drafted);
    await add(popup);
    const two = await shape(popup);
    check(two === '#a | #choiceA | #x | #b | #c', 'the drafted action goes in at that place', two);
    // A Drag & Drop's drop target picked on the page: the popup closes for it too.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'dragdrop'; t.dispatchEvent(new Event('change'));
      document.getElementById('manualSelector').value = '#from';
      document.getElementById('dragdropTargetPick').click();
    })()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceB');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    const target = await popup.evaluate(`document.getElementById('dragdropTarget').value`);
    const dd = await placeOf(popup);
    check(target === '#choiceB' && dd.after === '2' && /Insert at #4/.test(dd.note),
      'after picking a drop target the place is still there', { target, ...dd });
    await add(popup);
    const three = await shape(popup);
    check(three === '#a | #choiceA | #x | #from | #b | #c', 'the Drag & Drop goes in at the place', three);
    // A place kept for a list that has changed since is dropped, not used at a wrong index.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('manualSelector'); s.value = '#y'; s.dispatchEvent(new Event('input'));
    })()`);
    await sleep(DRAFT_SAVE_MS);
    await closeQuietly(popup);
    await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id, action: click('z') });
    popup = await reopenPopup(ctx);
    const stale = await placeOf(popup);
    check(stale.selector === '#y' && stale.note === '', 'the list changed while the popup was closed: the place is dropped, the action goes last', stale);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft', 'pendingEdit', 'lastPickedSelector', 'lastPickedSelectors', 'lastPickedFrameId', 'lastPickedLabel'])`);
    await closeQuietly(popup);
  }
}

// After a hover: the 150 ms intent, the message to the page and its answer.
const PREVIEW_SETTLE_MS = 500;
// After a click: the smooth scroll, then the flash (1.2 s) is still on.
const FLASH_SETTLE_MS = 900;

async function checkShowOnPage(ctx) {
  await reloadTestPage(ctx);
  // The page tells "under the popup" from where the popup says it is on the screen (placeLikeEdge below):
  // #choiceA goes to the left edge, clear of it, #choiceB to the window's top-right corner, right of it.
  await ctx.web.evaluate(`(() => { document.body.prepend(document.getElementById('choiceA'));
    Object.assign(document.getElementById('choiceB').style, { position: 'fixed', right: '40px', top: '120px' }); })()`);
  // Outlines the preview draws on the page: the text of each (its label, or the edge arrow's).
  const outlines = () => ctx.web.evaluate(`[...document.querySelectorAll(':root > [data-ext-overlay="1"]')].map((n) => n.textContent)`);
  // The popup is a tab here. For the page's sums, put it where Edge's toolbar popup sits: under the
  // extension's icon, 261 px in from the window's right edge (measured), not at the edge.
  const placeLikeEdge = async (p) => {
    const g = await ctx.web.evaluate(`({ screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight })`);
    const side = (g.outerWidth - g.innerWidth) / 2;
    const x = g.screenX + side + g.innerWidth - 480 - 261;
    const y = g.screenY + g.outerHeight - g.innerHeight - side;
    await p.evaluate(`void Object.defineProperties(window, { screenX: { get: () => ${x} }, screenY: { get: () => ${y} } })`);
  };
  let popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      document.getElementById('pickElement').click();
    })()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceA');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    await placeLikeEdge(popup);
    const name = await popup.evaluate(`document.querySelector('#pickedSelectorsInfo .pk-name')?.textContent`);
    check(name === 'button “choiceA”', 'after a pick the Picked line names the element', name);

    const eye = (event) => popup.evaluate(`document.getElementById('showSelectorOnPage').dispatchEvent(new MouseEvent('${event}'))`);
    const onName = (event) => popup.evaluate(`document.querySelector('#pickedSelectorsInfo .pk-name')
      .dispatchEvent(new MouseEvent('${event}', { bubbles: true, relatedTarget: document.body }))`);
    const typeSelector = (v) => popup.evaluate(`(() => { const s = document.getElementById('manualSelector');
      s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('input')); })()`);
    const message = () => popup.evaluate(`document.querySelector('#pickedSelectorsWrap + .field-error')?.textContent || ''`);
    const scrollY = () => ctx.web.evaluate('Math.round(scrollY)');

    // Hover 👁: an outline with the element's name, the page not scrolled; gone when the mouse leaves.
    const before = await scrollY();
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const peek = await outlines();
    const still = await scrollY();
    await eye('mouseleave');
    await sleep(SETTLE_MS);
    check(peek.length === 1 && peek[0].includes('choiceA') && still === before && (await outlines()).length === 0,
      'hovering 👁 outlines the element without scrolling; leaving takes the outline away', { peek, before, still });

    // Off-screen: a hover says where (an arrow at the page edge); a click scrolls to it and flashes it.
    await ctx.web.evaluate(`(() => { const s = document.createElement('div'); s.style.height = '3000px'; document.body.append(s);
      scrollTo(0, document.documentElement.scrollHeight); })()`);
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const edge = await outlines();
    await eye('mouseleave');
    check(edge.length === 1 && /^↑ .*choiceA.* above/.test(edge[0]), 'an off-screen element: the hover shows an arrow saying where it is', edge);
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS);
    const inView = await ctx.web.evaluate(`(() => { const r = document.getElementById('choiceA').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
    const flashed = await outlines();
    const icon = await popup.evaluate(`document.getElementById('showSelectorOnPage').textContent`);
    // The flash (1.2 s) starts once the scroll ends (up to 0.7 s): polled, not timed.
    const gone = !!(await pageSoon(ctx, `!document.querySelector(':root > [data-ext-overlay="1"]')`, 3_000));
    check(inView && flashed.some((t) => t.includes('choiceA')) && icon === '✓' && gone,
      'a click on 👁 scrolls the element into view, flashes it, shows ✓, and the flash goes', { inView, flashed, icon, gone });

    // The box edited: the name is struck out and still shows the picked element; 👁 shows what the box holds.
    await typeSelector('#bg2');
    const stale = await popup.evaluate(`document.getElementById('pickedSelectorsWrap').classList.contains('picked-stale')`);
    await onName('mouseover');
    await sleep(PREVIEW_SETTLE_MS);
    const byName = await outlines();
    await onName('mouseout');
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const byEye = await outlines();
    check(stale && byName.some((t) => t.includes('choiceA')) && byEye.some((t) => t.includes('bg2')),
      'with the box edited, the struck-out name shows the picked element and 👁 what the box holds', { stale, byName, byEye });
    // A click on the page takes away an outline the popup did not (it may have closed).
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);
    check((await outlines()).length === 0, 'a click on the page takes away an outline left on it', await outlines());
    await eye('mouseleave');

    // At the window's right edge, right of the popup: in view — no "Under this popup" line. (The old
    // guess put the popup at that edge and said it was under it, though it could be seen.)
    await typeSelector('#choiceB');
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS);
    const rightOfPopup = await message();
    check(!rightOfPopup.startsWith('Under this popup'), 'an element right of the popup, at the window\'s edge, is not called covered', rightOfPopup);
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);

    // Under the popup: the line says so, and the flash is held (until a click on the page) so Esc shows it.
    await ctx.web.evaluate(`document.getElementById('choiceB').style.right = '400px'`);
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS + 1_000);
    const held = { text: await message(), outlines: await outlines() };
    check(held.text === 'Under this popup — press Esc to see it.' && held.outlines.some((t) => t.includes('choiceB')),
      'an element under the popup: the line says so, and its outline outlasts the flash', held);
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);

    // What 👁 says when it finds no single visible element.
    const says = async (selector) => {
      await typeSelector(selector);
      await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
      await sleep(PREVIEW_SETTLE_MS);
      return { text: await message(), icon: await popup.evaluate(`document.getElementById('showSelectorOnPage').textContent`), outlines: await outlines() };
    };
    const missing = await says('#nope');
    check(missing.text.startsWith('Not on this page') && missing.icon === '✕', 'a selector that finds nothing: "Not on this page" and ✕', missing);
    const several = await says('.edit');
    check(several.text.startsWith('2 matches — playback uses the first') && several.outlines.length === 2 && several.icon === '!',
      'a selector with two matches: both outlined, the line says playback uses the first', several);
    const hidden = await says('#ctHidden');
    check(hidden.text.startsWith('On the page but hidden'), 'a hidden element: "On the page but hidden"', hidden);
    const variable = await says('#${who}');
    check(variable.text.includes('only known when it plays'), 'a selector with ${…}: not looked for, says why', variable);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft', 'pendingEdit', 'lastPickedSelector', 'lastPickedSelectors', 'lastPickedFrameId', 'lastPickedLabel'])`);
    await closeQuietly(popup);
  }
}

async function checkSwitchOtherCase(ctx) {
  const guest = await makeScenario(ctx, 'e2e guest', [{ type: 'click', selector: '#g', selectors: { css: '#g' } }]);
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  // #2 Switch: "admin" runs #3, "guest" runs another scenario; then #4.
  const id = await makeScenario(ctx, 'e2e switch other case', [
    click('a'),
    { type: 'switch', switchVar: '${role}', cases: [{ value: 'admin', scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt: 3, endAt: 3 },
      { value: 'guest', scenarioId: guest, scenarioName: 'e2e guest' }] },
    click('b'), click('c'),
  ]);
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const head = await popup.evaluate(`document.querySelector('#actions li.sw-case-other')?.textContent || ''`);
    check(head.includes('case "guest"') && head.includes('runs scenario “e2e guest”'), 'a case running another scenario has its own row in the block', head);
    const under = await dragRow(popup, 3, 'sw-case-head');
    await sleep(POPUP_SETTLE_MS);
    const order = (await storedActions(popup, id)).map((a) => a.selector || a.type).join(' ');
    const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
    check(order === '#a switch #b #c' && /another scenario/.test(toast), 'an action dropped under that case stays where it was', { under, order, toast });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
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

async function checkDraftSwitchFollows(ctx) {
  // #1 a … #6 f. A new Switch in the Add form runs #5–#6 (e, f); the list changes before Add Action.
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const id = await makeScenario(ctx, 'e2e draft switch follows', ['a', 'b', 'c', 'd', 'e', 'f'].map(wait));
  let popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const cases = () => popup.evaluate(`document.getElementById('switchCaseList').innerText.replace(/\\s+/g, ' ').trim()`);
    const pendingFrom = () => popup.evaluate(`document.getElementById('switchCaseFrom').selectedOptions[0]?.textContent.trim()`);
    await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const pick = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
      pick('switchCaseFrom', '4'); pick('switchCaseTo', '5');
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
      pick('switchCaseFrom', '2');   // a second case begun on "c", not added
    })()`);
    const added = await cases();
    const pending = await pendingFrom();

    await rowButton(popup, 0, 4);   // Delete "a"
    await popup.evaluate(`document.getElementById('confirmModalOk').click()`);
    await sleep(POPUP_SETTLE_MS);
    const deleted = await cases();
    const pendingAfter = await pendingFrom();
    check(added.includes('Run 5–6') && deleted.includes('Run 4–5') && !deleted.includes('Run 5–6'),
      'a Delete above a new Switch\'s case: the case still runs its actions, now #4–#5', { added, deleted });
    check(pending.endsWith(' c') && (pendingAfter === '— nothing —' || pendingAfter.endsWith(' c')),
      'a case begun but not added never names another action after a Delete', { pending, pendingAfter });

    const dropped = await dragRow(popup, 4, 'top');   // "f", the case's last action, to the top
    await sleep(POPUP_SETTLE_MS);
    const dragged = await cases();
    await popup.close();
    popup = await openPopup(ctx);
    // A draft restored before its list has loaded numbers a case "#5" (noOf), then "5".
    const reopened = (await cases()).replace('Run #', 'Run ');
    check(dropped === 'top' && dragged.includes('Run 5') && !dragged.includes('Run 4') && reopened === dragged,
      'an action dragged out of a new Switch\'s case leaves it; the draft keeps that', { dropped, dragged, reopened });

    await popup.evaluate(`document.getElementById('addManualAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.label)).join(' | ');
    check(shape === 'f | b | c | d | switch 6–6 | e', 'Add Action puts the Switch in front of the action its case still runs', shape);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

async function checkNestedBlockCheck(ctx) {
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const own = (value, startAt, endAt) => ({ value, scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt, endAt });
  const swOn = (v, ...cases) => ({ type: 'switch', switchVar: `\${${v}}`, cases });
  // #2 Switch runs #3–#4 (A, B); a new Switch over #2–#3 would hold it and half its block.
  const addId = await makeScenario(ctx, 'e2e nested check add', [wait('x'), swOn('role', own('1', 3, 4)), wait('A'), wait('B'), wait('C')]);
  // #1 Switch "1" runs #2–#4: #2 Switch and its block #3–#4. Cut to #2–#3, it would cross that block.
  const editId = await makeScenario(ctx, 'e2e nested check edit', [swOn('role', own('1', 2, 4)), swOn('mode', own('i', 3, 4)), wait('A'), wait('B'), wait('C')]);
  const popup = await openPopup(ctx);
  try {
    const stored = (id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(JSON.stringify(x.scenarios[${JSON.stringify(id)}].actions))))`);
    const tryToSave = () => popup.evaluate(`(async () => {
      const shown = document.getElementById('switchValidation').innerText.trim();
      document.getElementById('addManualAction').click();
      await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
      return { shown, toast: document.getElementById('toast').textContent };
    })()`);

    await showScenario(popup, addId);
    const before = await stored(addId);
    await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const pick = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
      pick('switchCaseFrom', '1'); pick('switchCaseTo', '2');
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const added = await tryToSave();
    const addWhy = 'the block of Switch #3 runs past the end of this case (#4)';
    check(added.shown.includes(addWhy) && added.toast.includes(addWhy) && await stored(addId) === before,
      'a new Switch over a Switch and half its block: the form says why and Add Action refuses', added);
    await popup.evaluate(`document.getElementById('cancelEdit')?.click()`);

    await showScenario(popup, editId);
    const beforeEdit = await stored(editId);
    await rowButton(popup, 0, 3);
    await popup.evaluate(`(async () => {
      document.querySelector('#switchCaseList .sw-case-edit[data-idx="0"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const to = document.getElementById('switchCaseTo'); to.value = '2'; to.dispatchEvent(new Event('change'));
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const edited = await tryToSave();
    const editWhy = 'the block of Switch #2 runs past the end of this case (#3)';
    check(edited.shown.includes(editWhy) && edited.toast.includes(editWhy) && await stored(editId) === beforeEdit,
      'a Switch\'s case cut through the block of a Switch in it: the form says why and Save Edit refuses', edited);
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
    text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
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
    prompt = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
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
    prompt ||= await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
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

async function checkNoChecks(ctx) {
  const lastVerdict = () => ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('lastRun', (x) => r(x.lastRun?.verdict || null)))`);
  const card = async () => {
    const popup = await openPopup(ctx);
    const seen = await popup.evaluate(`(() => {
      const c = document.getElementById('lastRunCard');
      return { verdict: c.querySelector('.lr-verdict').textContent, status: c.dataset.status, hint: c.querySelector('.lr-hint')?.hidden === false };
    })()`);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    await popup.close();
    return seen;
  };
  const clicks = [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ];
  const holds = { type: 'assert', conditionType: 'textEquals', selector: '#bg1', selectors: { css: '#bg1' }, expectedValue: 'bg1' };

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e no checks', clicks));
  const none = { verdict: await lastVerdict(), card: await card() };
  check(none.verdict?.status === 'passed' && none.verdict?.checks === 0
    && none.card.verdict === '✓ Finished · no checks' && none.card.status === 'unchecked' && none.card.hint,
  'a run with no Assert: "Finished · no checks", not Passed, and a hint to add one', none);

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e one check', [...clicks, holds]));
  const one = { verdict: await lastVerdict(), card: await card() };
  check(one.verdict?.status === 'passed' && one.verdict?.checks === 1
    && one.card.verdict === '✓ Passed' && one.card.status === 'passed' && !one.card.hint,
  'an Assert that holds: Passed, no hint', one);

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e check switched off', [...clicks, { ...holds, disabled: true }]));
  const off = await lastVerdict();
  check(off?.status === 'passed' && off?.checks === 0, 'a disabled Assert checks nothing', off);
}

async function checkLastRunLive(ctx) {
  const click = (sel) => ({ type: 'click', selector: sel, selectors: { css: sel } });
  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e live before', [click('#bg1')]));
  const stuck = await makeScenario(ctx, 'e2e live stuck', [click('#bg1'), click('#gone'), click('#bg2')]);
  const cardState = `(() => { const c = document.getElementById('lastRunCard');
    return { visible: !c.hidden && getComputedStyle(c).display !== 'none', verdict: c.querySelector('.lr-verdict').textContent,
      name: c.querySelector('.lr-name').textContent }; })()`;
  // On a tab of its own: the step that fails logs a console error there.
  const away = await ctx.browser.openPage(`${ctx.base}/page?live`, { width: 1000, height: 700 });
  let prompt = false, during = null, after = null;
  try {
    await sleep(PAGE_SETTLE_MS);
    await away.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: stuck });
    for (let waited = 0; !prompt && waited < 15_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      prompt = await away.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
    }
    const popup = await openPopup(ctx);
    during = await popup.evaluate(cardState);
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await sleep(POPUP_SETTLE_MS);
    after = await popup.evaluate(cardState);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    await popup.close();
  } finally {
    await away.close();
  }
  check(prompt && !during.visible, 'a run paused on its failed step: the Last run card of the run before is not shown', { prompt, during });
  check(after.visible && after.name === 'e2e live stuck' && /Test broken|Stopped/.test(after.verdict),
    'once the run ends, the card is back with its result', after);
}

async function checkAutoActivate(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e auto activate', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const activated = () => ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('activatedTabs', (x) => r(x.activatedTabs || [])))`);
  // The popup on the test page, Pocket QA off there.
  const openOff = async () => {
    await ctx.ext.evaluate(`chrome.storage.local.set({ activatedTabs: [] })`);
    const page = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
    await sleep(POPUP_SETTLE_MS);
    return page;
  };
  const asked = (page) => page.evaluate(`({ shown: document.getElementById('confirmModal').classList.contains('show'),
    title: document.getElementById('confirmModalTitle').textContent, ok: document.getElementById('confirmModalOk').textContent,
    msg: document.getElementById('confirmModalMsg').textContent })`);
  let popup = await openOff();
  try {
    const before = await popup.evaluate(`({ locked: document.getElementById('lockOverlayRecord').classList.contains('is-visible'),
      status: document.getElementById('activationStatus').textContent, startReady: !document.getElementById('startRecord').disabled })`);
    check(!before.locked && before.status === 'Off on this tab' && before.startReady,
      'a web page not turned on yet: no lock over Record & Play, Start Recording ready', before);

    // Start Recording on a tab that is off: nothing records; the popup says so and asks to turn it on.
    await popup.evaluate(`document.getElementById('startRecord').click()`);
    await sleep(SETTLE_MS);
    const rec = await asked(popup);
    const recording = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.recording;
    await popup.evaluate(`document.getElementById('confirmModalCancel').click()`);
    const afterCancel = await activated();
    check(rec.shown && rec.title === 'Off on this tab' && rec.ok === 'Turn on' && !recording && !afterCancel.includes(ctx.webTabId),
      'Start Recording on a tab that is off: nothing records, it asks to turn the tab on, Cancel leaves it off', { rec, recording, afterCancel });

    // 🎯 Pick too, and it stays out of pick mode.
    await popup.evaluate(`document.getElementById('pickElement').click()`);
    await sleep(SETTLE_MS);
    const pick = await asked(popup);
    const mode = await popup.evaluate(`document.getElementById('pickElement').textContent`);
    await popup.evaluate(`document.getElementById('confirmModalCancel').click()`);
    check(pick.shown && pick.ok === 'Turn on' && pick.msg === rec.msg && mode === '🎯',
      '🎯 Pick on a tab that is off asks the same question, without going into pick mode', { pick, mode });

    // Turn on: the tab is remembered as on, and the recording starts.
    await popup.evaluate(`document.getElementById('startRecord').click()`);
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.getElementById('confirmModalOk').click()`).catch(() => { /* the popup closes itself */ });
    await sleep(POPUP_SETTLE_MS);
    const started = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.recording;
    const on = await activated();
    await ctx.send({ type: 'STOP_RECORD' });
    check(started && on.includes(ctx.webTabId), 'Turn on: the tab is remembered as on and the recording starts', { started, on });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await closeQuietly(popup);
  }

  // ▶ Play asks the same: Cancel plays nothing; Turn on turns the tab on and plays.
  popup = await openOff();
  try {
    await showScenario(popup, id);
    await popup.evaluate(`document.getElementById('playScenario').click()`);
    await sleep(SETTLE_MS);
    const play = await asked(popup);
    await popup.evaluate(`document.getElementById('confirmModalCancel').click()`);
    await sleep(SETTLE_MS);
    const ranOff = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing;
    const offStill = !(await activated()).includes(ctx.webTabId);
    check(play.shown && play.ok === 'Turn on' && !ranOff && offStill,
      '▶ Play on a tab that is off: nothing plays, it asks the same question', { play, ranOff, offStill });
    await ctx.web.bringToFront();
    await popup.evaluate(`document.getElementById('playScenario').click()`);
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.getElementById('confirmModalOk').click()`).catch(() => { /* the popup closes itself */ });
    await sleep(SETTLE_MS);
  } finally {
    await closeQuietly(popup);
  }
  const played = await activated();
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(played.includes(ctx.webTabId), '▶ Play, then Turn on: the tab is turned on and the scenario plays there', { played, tab: ctx.webTabId });
}

// The run panel on the page a run plays on: what plays and how far, off the screen
// for a screenshot, gone when the run ends; its Stop ends a run.
async function checkRunPanel(ctx) {
  await reloadTestPage(ctx);
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  // What the page saw of the panel, each time it changed: "shown <text>" / "hidden <text>" / "none".
  const watch = () => ctx.web.evaluate(`(() => { window.__panel = ['none'];
    new MutationObserver(() => { const p = document.getElementById('__pqa_run');
      const s = p ? (p.style.visibility === 'hidden' ? 'hidden ' : 'shown ') + p.textContent : 'none';
      if (__panel.at(-1) !== s) __panel.push(s); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  await watch();
  const id = await makeScenario(ctx, 'e2e run panel', [
    { type: 'wait', delay: 700 },
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' }, delay: 300 },
    { type: 'screenshot', value: 'panel', delay: 300 },
    { type: 'wait', delay: 700 },
  ]);
  const before = ctx.browser.downloads().length;
  await play(ctx, id);
  const seen = await ctx.web.evaluate('window.__panel');
  const shown = seen.filter((s) => s.startsWith('shown'));
  check(shown.some((s) => s.includes('e2e run panel') && s.includes('step 1/4')) && shown.some((s) => s.includes('step 4/4')) && seen.at(-1) === 'none',
    'a run shows its panel — the scenario and its step — and takes it away at the end', seen);
  const hiddenAt = seen.findIndex((s) => s.startsWith('hidden') && s.includes('step 3/4'));
  check(hiddenAt > 0 && seen.slice(hiddenAt + 1).some((s) => s.startsWith('shown')) && ctx.browser.downloads().length - before === 1,
    'the screenshot step takes the panel off the screen, then puts it back', { seen, saved: ctx.browser.downloads().length - before });

  // ■ Stop on the panel ends the run.
  await reloadTestPage(ctx);
  const long = await makeScenario(ctx, 'e2e run panel stop', [{ type: 'wait', delay: 8000 }, { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } }]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: long });
  const up = await pageSoon(ctx, `!!document.getElementById('__pqa_run')`, 5_000);
  await clickAt(ctx, '#__pqa_run button');
  let st = null;
  for (let waited = 0; waited < 3_000; waited += POLL_MS) { st = await ctx.send({ type: 'GET_EXTENSION_STATUS' }); if (!st?.playing) break; await sleep(POLL_MS); }
  const gone = !!(await pageSoon(ctx, `!document.getElementById('__pqa_run')`, 3_000));
  const log = await ctx.web.evaluate('window.__log');
  if (st?.playing) await ctx.send({ type: 'STOP_PLAYBACK' });
  check(up && !st?.playing && gone && !log.some((l) => l.startsWith('bg2')), "the panel's ■ Stop ends the run, and the panel goes", { up, playing: st?.playing, gone, log });
}

// A new action being filled in: Cancel beside Add Action (laid out as Save Edit / Cancel),
// and the dummy row's ✕ — both empty the card, and the dummy row goes with it.
async function checkAddCancel(ctx) {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const id = await makeScenario(ctx, 'e2e add cancel', [click('a'), click('b')]);
  const popup = await openPopup(ctx);
  const fill = () => popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.getElementById('manualSelector'); s.value = '#new'; s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const state = () => popup.evaluate(`(() => {
    const c = document.getElementById('cancelEdit'), a = document.getElementById('addManualAction');
    return { type: document.getElementById('manualActionType').value, selector: document.getElementById('manualSelector').value,
      ghost: !!document.querySelector('#actions li.action-ghost'), cancel: c.offsetWidth > 0,
      cancelW: c.offsetWidth, addW: a.offsetWidth, addText: a.textContent };
  })()`);
  try {
    await showScenario(popup, id);
    await fill();
    await sleep(SETTLE_MS);
    const adding = await state();
    check(adding.ghost && adding.cancel && adding.addText === 'Add Action', 'filling in a new action: the dummy row, and Cancel beside Add Action', adding);
    await rowButton(popup, 0, 3); // Edit on row 1: Save Edit / Cancel
    const editing = await state();
    check(editing.cancel && editing.addText === 'Save Edit' && editing.cancelW === adding.cancelW && editing.addW === adding.addW,
      'Add Action / Cancel take the widths Save Edit / Cancel take', { adding, editing });
    await popup.evaluate(`document.getElementById('cancelEdit').click()`);
    await sleep(SETTLE_MS);

    await fill();
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.querySelector('#actions li.action-ghost [data-g="cancel"]').click()`);
    await sleep(SETTLE_MS);
    const byX = await state();
    check(!byX.ghost && byX.type === '' && byX.selector === '', "the dummy row's ✕ empties the Add Action card, and the row goes", byX);

    await fill();
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.getElementById('cancelEdit').click()`);
    await sleep(SETTLE_MS);
    const byCancel = await state();
    check(!byCancel.ghost && byCancel.type === '' && byCancel.selector === '', 'Cancel while adding empties the card the same way', byCancel);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft'])`);
    await closeQuietly(popup);
  }
}

// Settings → Allow on all tabs: reached from the "Off on this tab" question; then nothing asks,
// and the record hotkeys work on a tab never turned on.
async function checkAllowAllTabs(ctx) {
  await reloadTestPage(ctx);
  await ctx.ext.evaluate(`chrome.storage.local.set({ activatedTabs: [], allowAllTabs: false })`);
  let popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
  await sleep(POPUP_SETTLE_MS);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabRecord"]').click(); document.getElementById('startRecord').click()`);
    await sleep(SETTLE_MS);
    const link = await popup.evaluate(`(() => { const l = document.getElementById('confirmModalLink'); return l.hidden ? null : l.textContent; })()`);
    await popup.evaluate(`document.getElementById('confirmModalLink').click()`);
    await sleep(SETTLE_MS);
    const landed = await popup.evaluate(`({ tab: document.body.dataset.activeTab, modal: document.getElementById('confirmModal').classList.contains('show'),
      flashed: document.getElementById('allowAllTabsCard').classList.contains('setting-flash') })`);
    check(/Allow on all tabs/.test(link || '') && landed.tab === 'tabSettings' && !landed.modal && landed.flashed,
      'the "Off on this tab" question links to Settings → Allow on all tabs', { link, ...landed });

    await popup.evaluate(`document.getElementById('allowAllTabs').click()`);
    await sleep(SETTLE_MS);
    const on = await popup.evaluate(`({ status: document.getElementById('activationStatus').textContent,
      turnOff: getComputedStyle(document.getElementById('deactivateTab')).display })`);
    const stored = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('allowAllTabs', (x) => r(x.allowAllTabs)))`);
    check(stored === true && on.status === 'Active · all tabs' && on.turnOff === 'none',
      'the toggle turns Pocket QA on for every tab: the status bar says so', { stored, ...on });

    // A record hotkey on the test tab, never turned on one by one.
    await ctx.web.bringToFront();
    for (const type of ['keyDown', 'keyUp']) {
      await ctx.web.send('Input.dispatchKeyEvent', { type, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, modifiers: 1 });
    }
    await sleep(SETTLE_MS);
    const byHotkey = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.recording;
    await ctx.send({ type: 'STOP_RECORD' });
    check(byHotkey, 'with every tab allowed, the record hotkey works on a tab never turned on', { byHotkey });
  } finally {
    await closeQuietly(popup);
  }
  // Start Recording no longer asks.
  popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
  await sleep(POPUP_SETTLE_MS);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabRecord"]').click(); document.getElementById('startRecord').click()`).catch(() => { /* the popup closes itself */ });
    await sleep(POPUP_SETTLE_MS);
    const started = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.recording;
    await ctx.send({ type: 'STOP_RECORD' });
    check(started, 'with every tab allowed, Start Recording records at once, without asking', { started });
  } finally {
    await closeQuietly(popup);
    await ctx.ext.evaluate(`chrome.storage.local.set({ allowAllTabs: false })`);
  }
}

// The status dot while recording, and once Stop has ended it (it stayed red until the popup reopened).
async function checkRecordDot(ctx) {
  const popup = await openPopup(ctx);
  const dotWhen = async (want, ms) => {
    let cls = '';
    for (let waited = 0; waited < ms; waited += POLL_MS) {
      cls = await popup.evaluate(`document.getElementById('statusDot').className`);
      if (want(cls)) break;
      await sleep(POLL_MS);
    }
    return cls;
  };
  try {
    await ctx.send({ type: 'START_RECORD', tabId: ctx.webTabId, scenarioId: null });
    const during = await dotWhen((c) => c.includes('recording'), 4_000);
    await ctx.send({ type: 'STOP_RECORD' });
    const after = await dotWhen((c) => !c.includes('recording'), 4_000);
    check(during === 'status-dot recording' && after === 'status-dot active',
      'the status dot is red while recording and green again once Stop ends it', { during, after });
  } finally {
    await closeQuietly(popup);
  }
}

async function checkRunGroup(ctx) {
  const popup = await openPopup(ctx);
  try {
    const layout = await popup.evaluate(`(() => {
      const ids = [...document.querySelectorAll('#tabRecord .card[id]')].map((c) => c.id);
      return { tab: document.querySelector('.tab-btn[data-tab="tabData"]').textContent.trim(),
        group: document.querySelector('#tabRecord .tab-group-label')?.textContent.trim() || '',
        last: ids.slice(-3), inTools: !!document.querySelector('#tabData #scheduledPlaybackCard, #tabData #csvRunCard') };
    })()`);
    check(layout.tab === 'Tools' && /schedule/i.test(layout.group) && !layout.inTools
      && layout.last.join() === 'sequencePlaybackCard,scheduledPlaybackCard,csvRunCard',
    'Sequence, Scheduled Playback and the CSV run close Record & Play under one heading; the Data tab is Tools', layout);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
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
      text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
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

async function checkRecordNames(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.evaluate(`document.body.insertAdjacentHTML('afterbegin', '<form id="nf" onsubmit="return false">'
    + '<label for="nu">Tên đăng nhập</label> <input id="nu"> <input id="np" type="password" placeholder="Mật khẩu"> '
    + '<button id="nb" type="button"><span>Đăng nhập</span></button> <div id="nd" style="display:inline-block;width:40px;height:20px"></div></form>')`);
  const { id, actions } = await record(ctx, 'e2e record names', async () => {
    await clickAt(ctx, '#nu');
    await ctx.web.send('Input.insertText', { text: 'admin' });
    await clickAt(ctx, '#np');
    await ctx.web.send('Input.insertText', { text: 'hunter2' });
    await clickAt(ctx, '#nb');
    await clickAt(ctx, '#nd');
  });
  const named = actions.map((a) => `${a.type} ${a.selector} ${a.label ?? '-'}`);
  check(named.join(' | ') === 'click #nu Tên đăng nhập | input #nu Tên đăng nhập | click #np Mật khẩu | input #np Mật khẩu'
    + ' | click form > button > span Đăng nhập | click #nd -',
  'each recorded step is named after its element: the <label>, the placeholder, the button text; nothing names an empty box', named);
  check(!actions.some((a) => /admin|hunter2/.test(a.label || '')), 'a name is never what was typed', named);

  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const rows = await popup.evaluate(`[...document.querySelectorAll('#actions li.action')].map((li) =>
      li.querySelector('.value-main').textContent.trim() + ' / ' + (li.querySelector('.value-target')?.textContent ?? '-'))`);
    check(rows[1] === 'Tên đăng nhập (500ms) / #nu' && rows[3] === '🔒Mật khẩu (500ms) / #np' && rows[5] === '#nd (500ms) / -',
      'the list reads by name, the selector on the line under it; an unnamed step shows its selector as before', rows);
    const locks = await popup.evaluate(`[...document.querySelectorAll('#actions li.action')].map((li) => !!li.querySelector('.secret-mark'))`);
    check(JSON.stringify(locks) === '[false,false,false,true,false,false]' && actions[3].secret === true && !actions[1].secret,
      'what was typed into the password field is marked 🔒 in the list; the other field is not', { locks, secrets: actions.map((a) => a.secret ?? '-') });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }

  // An element that is not there: the reason says how it was looked for, in words.
  const gone = await makeScenario(ctx, 'e2e not found', [{ type: 'click', selector: '#gone', selectors: { css: '#gone', id: 'gone' } }]);
  // A hook of its own: the assert check's __fails one prefixes the index.
  await ctx.ext.evaluate(`window.__notFound = []; window.__notFoundHooked || chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'ACTION_FAILED') __notFound.push(m.reason);
  }); window.__notFoundHooked = true;`);
  // On a tab of its own: the page logs the failure as a console error, which the
  // test tab must not have.
  const away = await ctx.browser.openPage(`${ctx.base}/page?gone`, { width: 1000, height: 700 });
  try {
    await sleep(PAGE_SETTLE_MS);
    await away.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: gone });
    for (let waited = 0; waited < 15_000 && !(await ctx.ext.evaluate('__notFound.length')); waited += POLL_MS) await sleep(POLL_MS);
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await sleep(SETTLE_MS);
  } finally {
    await away.close();
  }
  const reasons = await ctx.ext.evaluate('__notFound');
  check(/^Element not found on the page within 5 s \(looked for it by ID and CSS\)$/.test(reasons[0] || ''),
    'a missing element: "not found on the page within 5 s (looked for it by ID and CSS)"', reasons);
}

async function checkRecordingPill(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e recording pill', []);
  const pill = () => ctx.web.evaluate(`(() => { const p = document.getElementById('__pqa_recording');
    return p ? p.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  const buttons = async () => {
    const popup = await openPopup(ctx);
    const b = await popup.evaluate(`(() => { const s = document.getElementById('startRecord'), t = document.getElementById('stopRecord');
      return { start: s.textContent.trim(), startDisabled: s.disabled, stopDanger: t.classList.contains('danger') }; })()`);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    await popup.close();
    return b;
  };
  const before = await pill();
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_RECORD', scenarioId: id, tabId: ctx.webTabId });
  await sleep(SETTLE_MS);
  const shown = await pill();
  const inFrame = await ctx.web.evaluate(`document.querySelector('iframe')?.contentDocument?.getElementById('__pqa_recording') ? 'yes' : 'no'`).catch(() => 'n/a');
  check(before === null && /Recording — Pocket QA/.test(shown || '') && /Stop/.test(shown || '') && inFrame !== 'yes',
    'recording: the page shows a "● Recording — Pocket QA" pill with Stop, in the top frame only', { before, shown, inFrame });
  const during = await buttons();
  check(during.start === '● Recording…' && during.startDisabled && during.stopDanger,
    'the popup while recording: Start reads "● Recording…" and is off, Stop stands out', during);

  await ctx.web.bringToFront();
  await clickAt(ctx, '#bg1');
  await sleep(SETTLE_MS);
  await clickAt(ctx, '#__pqa_recording button');
  await sleep(SETTLE_MS * 2);
  const status = await ctx.send({ type: 'GET_EXTENSION_STATUS' });
  const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('scenarios', (x) => r((x.scenarios[${JSON.stringify(id)}].actions || []).map((a) => a.selector))))`);
  const after = await pill();
  check(!status?.recording && after === null && JSON.stringify(saved) === '["#bg1"]',
    'Stop on the pill stops and saves the recording, the pill goes, and its click is not a step', { recording: status?.recording, after, saved });
  const idle = await buttons();
  check(idle.start === '▶ Start Recording' && !idle.startDisabled && !idle.stopDanger, 'stopped: Start and Stop are back as they were', idle);
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

const SUITES = {
  'locate': [
    ['dropdown', 'Dropdown', checkDropdown],
    ['switch', 'Switch Always and the Random cap', checkSwitchAlways],
    ['capture', 'Two visible screenshots in a row', checkCapture],
    ['background-tab', 'A run in a background tab', checkBackgroundTab],
    ['label-click', 'A click on a label, recorded and played', checkLabelClick],
    ['child-condition', 'Child Condition: innermost text match, ALL', checkChildCondition],
    ['file-input', 'A file input, recorded and played', checkFileInput],
    ['condition-unknown', 'A Condition of an unknown type', checkConditionUnknown],
    ['selector-choice', 'The selector type chosen in the form plays first', checkSelectorChoice],
    ['shadow-dom', 'Elements in a shadow root', checkShadowDom],
    ['select-type', 'Child Condition type "select"', checkSelectType],
    ['condition-choice', 'Condition and element screenshot use the chosen selector type', checkConditionChoice],
    ['cdp-targets', 'Upload, Dropdown and element screenshot act on the element the page found', checkCdpTargets],
    ['cdp-frames', 'Upload, Dropdown and element screenshot inside a frame', checkCdpFrames],
    ['click-through', 'Click through: off for the scenario or the action', checkClickThrough],
    ['typed-text', 'A Text selector typed in the form', checkTypedText],
    ['select-missing', 'Input of an option a <select> does not have', checkSelectMissing],
  ],
  'run': [
    ['overlays', 'The countdown, failed-action prompt and segment bar, loaded when needed', checkOverlays],
    ['schedule', 'A scheduled run on its start URL', checkSchedule],
    ['assert', 'Assert: waited for, and a false one does not stop the run', checkAssert],
    ['last-run', 'The Last run card in the popup', checkLastRun],
    ['no-checks', 'A run with no Assert says it checked nothing', checkNoChecks],
    ['last-run-live', 'The Last run card hides while a run is on', checkLastRunLive],
    ['run-panel', 'The run panel on the page: progress, off for a screenshot, its Stop', checkRunPanel],
    ['run-group', 'Sequence, schedule and CSV run in one group on Record & Play', checkRunGroup],
  ],
  'editor': [
    ['preview-no-flash', 'Disable / Enable an action without the list flashing', checkPreviewNoFlash],
    ['folder-filter', 'The Manage Scenarios folder filter, kept', checkFolderFilter],
    ['switch-draft', 'Switch draft in the popup', checkSwitchDraft],
    ['edit-follows-list', 'An action open in the form while its list changes', checkEditFollowsList],
    ['numbers-by-position', 'Every action numbered by its position, in a Switch block too', checkNumbersByPosition],
    ['switch-insert', 'A new Switch over actions already in the list', checkNewSwitchOverActions],
    ['switch-draft-follows', 'A new Switch in the form while its list changes', checkDraftSwitchFollows],
    ['switch-nested-check', 'A Switch whose case would cross the block of a Switch in it', checkNestedBlockCheck],
    ['paste-empty', 'Paste into a scenario with no actions', checkPasteEmpty],
    ['save-selects', 'Save keeps the saved scenario selected, ready to Play', checkSaveSelects],
    ['form-scroll', 'After Add Action: the card back in view, the list on the new action', checkFormScroll],
    ['switch-other-case', 'A Switch case running another scenario: listed, never dropped into', checkSwitchOtherCase],
    ['copy-switch-block', 'Copy and Paste a Switch with its block', checkCopySwitchBlock],
    ['insert-point', 'The + between rows: the dummy row, adds and a paste at that place', checkInsertPoint],
    ['insert-point-pick', 'The place picked by + kept across 🎯 Pick and a reopened draft', checkInsertPointPick],
    ['show-on-page', 'The picked element named in the form; 👁 and its name outline it on the page or scroll to it', checkShowOnPage],
    ['add-cancel','Cancel while adding, and the dummy row\'s ✕, empty the Add Action card', checkAddCancel],
    ['form-roundtrip', 'Every action type through Edit → Save', checkFormRoundtrip],
  ],
  'vars': varsChecks,
  'record': [
    ['hotkeys', 'Record hotkeys: activated tabs only, macOS Option', checkHotkeys],
    ['record-overlay', 'Recording ignores the extension overlays', checkRecordOverlay],
    ['auto-activate', 'No lock on a web page; Record, Play and Pick ask to turn the tab on, with one question', checkAutoActivate],
    ['record-dot', 'The status dot after Stop Recording', checkRecordDot],
    ['allow-all-tabs', 'Settings → Allow on all tabs, reached from the "Off on this tab" question', checkAllowAllTabs],
    ['record-untrusted', 'Recording ignores events the page dispatches', checkRecordUntrusted],
    ['record-checkbox', 'Ticking a checkbox while recording', checkRecordCheckbox],
    ['record-input-order', 'Typing, then a click at once', checkRecordInputOrder],
    ['record-other-tab', 'Recording ignores the other tabs', checkRecordOtherTab],
    ['record-names', 'Recorded steps named after their elements; "not found" in words', checkRecordNames],
    ['recording-pill', 'Recording shows on the page and in the popup; Stop on the page', checkRecordingPill],
    ['record-restart', 'A recording across a worker restart', checkRecordRestart],
  ],
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
