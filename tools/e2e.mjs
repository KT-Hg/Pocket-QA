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
 *                 "✓ OK"); Selenium's, which exports it, as "✓ OK"
 *   export-regenerate  Regenerate in either export modal shows a step added to the
 *                 scenario since it opened, and lists and declares only the
 *                 variables the scenario uses
 *   export-headless  the Selenium modal's Headless switch exports a headless driver,
 *                 and turns off (disabled) with Safari
 *   export-output  the Selenium modal's Output pytest gives a test_….py file with a
 *                 test function
 *   export-run    each scenario of EXPORT_CASES, played, run as the exported bookmarklet
 *                 and run as the exported Selenium script (python, Edge exported
 *                 headless — with a window under --headed),
 *                 leaves the export page the same way; the form case runs as the
 *                 exported pytest test too, and a pytest test with a failing step
 *                 names it. No python, selenium or pytest: those runs are skipped,
 *                 not failed
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
 *
 * Usage: node tools/e2e.mjs [--only <name>] [--ext <extension dir>] [--headed]
 *        --ext runs another checkout (an older commit, to see a check fail there).
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asActiveTab, launchWithExtension, sleep } from './lib/cdp-browser.mjs';

const args = process.argv.slice(2);
const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const EXT = resolve(argValue('--ext') || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const ONLY = argValue('--only');
const HEADED = args.includes('--headed');

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
  return ctx.web.evaluate(`({ log: window.__log, dd: document.getElementById('dd')?.textContent,
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

/** The popup as if opened on the activated test page. */
async function openPopup(ctx) {
  const popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
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
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, varName: 'title', readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, pattern: 'Hello ${who}!', matchCase: true, readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#link', selectors: { css: '#link' }, varName: 'href', readFrom: 'attr', attrName: 'href', delay: 500 },
  { type: 'dragdrop', selector: '#a', selectors: { css: '#a' }, targetSelector: '#b', targetSelectors: { css: '#b' }, delay: 500 },
  { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, pick: { by: 'index', index: '-1', itemSelector: '.menu li' }, delay: 500 },
  { type: 'uploadFile', selector: '#file', selectors: { css: '#file' }, uploadMode: 'input', folderPath: 'C:\\data', fileNames: ['a.pdf', '${f}'], delay: 500 },
  { type: 'condition', conditionType: 'textContains', selector: '#title', selectors: { css: '#title' }, expectedValue: 'Hi', skipCount: 2, delay: 500 },
  { type: 'condition', conditionType: 'urlContains', expectedValue: '/login', skipCount: 1, delay: 500 },
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
  const editSave = async (i) => {
    const before = await actionAt(i);
    await popup.evaluate(`(async () => {
      const { startEdit } = await import('./popup/record/action-form.js');
      startEdit(${i}, ${JSON.stringify(before)});
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
    if (canonical(a1) !== canonical(fixtures[i])) bad.push({ i, type: fixtures[i].type, saved: a1 });
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
    await popup.evaluate(`[...document.querySelectorAll('#exportModal button')].find((b) => /\\.py/.test(b.textContent)).click()`);
    await sleep(SETTLE_MS);
    const dl = await popup.evaluate('window.__dl[0] || null');
    check(dl?.name === 'đăng_nhập__admin__selenium.py' && dl.bytes > 0,
      'an exported file keeps the letters of the scenario name, and holds the code', dl);
  } finally {
    await popup.close();
  }
}

async function checkExportSteps(ctx) {
  const id = await makeScenario(ctx, 'e2e export steps', [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'uploadFile', selector: '#upload', selectors: { css: '#upload' }, folderPath: 'C:\\in', fileNames: ['a.txt'] },
  ]);
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
        skipped: document.getElementById('exportStatSkippedPill').style.display === 'none' ? null
          : document.getElementById('exportStatSkipped').textContent,
        warning: document.getElementById('exportSkipMsg').textContent,
      })`);
      const said = skipped
        ? JSON.stringify(tab.rows) === '["✓ OK","— Skip"]' && tab.skipped === '1 skipped' && /local files/.test(tab.warning)
        : JSON.stringify(tab.rows) === '["✓ OK","✓ OK"]' && tab.skipped === null && tab.warning === '';
      check(said, `${button}: the Actions tab, the counts and the warning bar say whether Upload File is exported`, tab);
      await popup.evaluate(`document.getElementById('exportClose').click()`);
    }
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
      // The scenario changes while the modal is open; Regenerate has to show it.
      const marker = `regen${++added}`;
      await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id,
        action: { type: 'click', selector: `#${marker}`, selectors: { css: `#${marker}` } } });
      await popup.evaluate(`document.getElementById('exportRegenerate').click()`);
      await sleep(POPUP_SETTLE_MS);
      const shown = await popup.evaluate(`({
        vars: [...document.querySelectorAll('#exportVarList .export-bm-var-name')].map((el) => el.textContent),
        code: document.querySelector('#exportCode code').textContent,
      })`);
      check(JSON.stringify(shown.vars) === '["${used}"]' && shown.code.includes(`#${marker}`) && !/\bunused\b/.test(shown.code),
        `${button}: Regenerate reads the scenario again and keeps to the variables it uses`,
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
    // A click on the row's text flips the switch, as on any switch row.
    await popup.evaluate(`document.querySelector('#exportSeleniumHeadlessRow .export-bm-setting-label').click();
      document.getElementById('exportRegenerate').click()`);
    await sleep(POPUP_SETTLE_MS);
    const on = await code();
    check(/_options\.add_argument\("--headless=new"\)\ndriver = webdriver\.Chrome\(options=_options\)/.test(on),
      'Headless on: the script starts Chrome without a window', on.split('\n').filter((l) => /driver = |_options/.test(l)));
    await popup.evaluate(`(() => {
      const d = document.getElementById('exportSeleniumDriver');
      d.value = 'Safari';
      d.dispatchEvent(new Event('change'));
      document.getElementById('exportRegenerate').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const box = await popup.evaluate(`(({ checked, disabled }) => ({ checked, disabled }))(document.getElementById('exportSeleniumHeadless'))`);
    const safari = await code();
    check(!box.checked && box.disabled && /^driver = webdriver\.Safari\(\)$/m.test(safari),
      'Safari: Headless is off and cannot be turned on', box);
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
    await popup.evaluate(`(() => {
      const o = document.getElementById('exportSeleniumOutput');
      o.value = 'pytest';
      o.dispatchEvent(new Event('change'));
      document.getElementById('exportRegenerate').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const shown = await popup.evaluate(`({
      label: document.getElementById('exportCodeLabel').textContent,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.label === 'test_đăng_nhập_pytest.py' && /^import pytest$/m.test(shown.code) && /^def test_dang_nhap_pytest\(browser\):$/m.test(shown.code),
      'Output pytest: a test_….py file pytest finds, with a test function', { label: shown.label });
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
<div id="tall" style="height:3000px"></div>
<script>
  const run = new URLSearchParams(location.search).get('run');
  const clicks = [], alerts = [], marks = [];
  let seq = 0;
  const fields = () => Object.fromEntries([...document.querySelectorAll('input[id], select[id], textarea[id], [contenteditable][id]')]
    .map((el) => [el.id, el.type === 'checkbox' ? el.checked : (el.isContentEditable ? el.textContent : el.value)]));
  // seq: two posts in flight may arrive in either order; the harness keeps the latest.
  const report = () => fetch('/state', { method: 'POST', keepalive: true,
    body: JSON.stringify({ run, seq: ++seq, state: { fields: fields(), clicks, alerts, marks, headless: /Headless/.test(navigator.userAgent) } }) });
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
  const files = document.getElementById('files');
  files.addEventListener('change', () => mark('files ' + [...files.files].map((f) => f.name).join(',')));
  report();
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
 * exactly what playback left; `files` are what the Selenium run must save, by
 * name, each with a check on the PNG's { width, height }. With `pageVar`, each run
 * starts on another page and that variable holds the URL of its own; with
 * `bookmarkletClicks: 2` the bookmark is clicked once there, then again on the
 * page it opened. Add a case per
 * behaviour an export has to share with playback.
 */
// The folder of this harness: Upload File cases upload its own files.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const EXPORT_CASES = [
  {
    name: 'form',
    // Also as the exported pytest test (python -m pytest).
    runners: ['bookmarklet', 'selenium', 'pytest'],
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
    ],
    expect: { fields: { picked: 'ref 7731' }, clicks: ['tagBob', 'editBob', 'nameBob'], alerts: [] },
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
    runners: ['selenium'],
    variables: { second: 'verify.mjs' },
    actions: [{ type: 'uploadFile', selector: '#files', selectors: { css: '#files' }, uploadMode: 'input',
      folderPath: TOOLS_DIR, fileNames: ['e2e.mjs', '${second}'] }],
    expect: { marks: ['files e2e.mjs,verify.mjs'] },
  },
  {
    // A full-page screenshot holds the whole page (3000px of #tall), not the window.
    name: 'full-shot',
    runners: ['selenium'],
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
];

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

/** Run a pytest file from `dir`, no cache written. */
const runPytest = (file, dir) => runFile('python', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', file],
  { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS });

/** Why the Selenium run cannot happen on this machine, or null when it can. */
async function pythonMissing() {
  const { error, stderr } = await runFile('python', ['-c', 'import selenium']);
  if (!error) return null;
  return error.code === 'ENOENT' ? 'no python on PATH' : `no selenium for python (${String(stderr).trim().split('\n').pop()})`;
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

async function checkExportRun(ctx) {
  const extModule = (p) => pathToFileURL(join(EXT, p)).href;
  const { generateBookmarklet, toBookmarkletUrl } = await import(extModule('popup/export-bookmarklet.js'));
  const { generateSeleniumPy } = await import(extModule('popup/export-selenium.js'));
  const { getUsedVarNames } = await import(extModule('popup/utils.js'));
  const noPython = await pythonMissing();
  if (noPython) console.log(`  – the Selenium runs are skipped: ${noPython}`);
  const pytestHere = !noPython && await hasPytest();
  if (!noPython && !pytestHere) console.log('  – the pytest runs are skipped: no pytest for python');
  const dir = mkdtempSync(join(tmpdir(), 'pqa-export-'));
  let headlessChecked = false;
  const pageUrl = (key) => `${ctx.base}/export?run=${encodeURIComponent(key)}`;
  try {
    for (const c of EXPORT_CASES) {
      // The URL of each run's own page, in the variable named by `pageVar`.
      const pageVars = (runner) => (c.pageVar ? { [c.pageVar]: pageUrl(`${c.name}:${runner}`) } : {});
      const startUrl = (runner) => pageUrl(`${c.name}:${c.pageVar ? 'start' : runner}`);
      await ctx.send({ type: 'SAVE_VARIABLES', variables: { ...c.variables, ...pageVars('playback') } });
      const id = await makeScenario(ctx, `e2e export ${c.name}`, c.actions);
      // The exports get what the modal hands them: the stored actions, and the variables they use.
      const actions = (await ctx.send({ type: 'GET_SCENARIOS' })).scenarios[id].actions;
      const used = getUsedVarNames(actions);
      const variables = Object.fromEntries(Object.entries((await ctx.send({ type: 'GET_VARIABLES' })).variables || {})
        .filter(([k]) => used.has(k)));
      const states = {};
      const runners = c.runners || ['bookmarklet', 'selenium'];

      await ctx.web.goto(startUrl('playback'));
      await sleep(PAGE_SETTLE_MS);
      const played = await play(ctx, id);
      if (played.timedOut) fail(`${c.name}: playback did not finish`);
      states.playback = exportStates.get(`${c.name}:playback`)?.state;

      if (runners.includes('bookmarklet')) {
        await ctx.web.goto(startUrl('bookmarklet'));
        const url = toBookmarkletUrl(generateBookmarklet(c.name, actions, { ...variables, ...pageVars('bookmarklet') }).code);
        for (let click = 1; click <= (c.bookmarkletClicks || 1); click++) {
          if (click > 1) await untilOn(ctx.web, pageUrl(`${c.name}:bookmarklet`));
          // What a click on the bookmark runs: the URL, percent-decoded.
          await ctx.web.evaluate(decodeURIComponent(url.slice('javascript:'.length)), BOOKMARKLET_RUN_TIMEOUT_MS)
            .catch((e) => fail(`${c.name}: the bookmarklet threw on click ${click}: ${e.message}`));
        }
        await sleep(SETTLE_MS);
        states.bookmarklet = exportStates.get(`${c.name}:bookmarklet`)?.state;
      }

      if (!noPython && runners.includes('selenium')) {
        const file = join(dir, `${c.name}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('selenium') },
          { driverType: 'Edge', startUrl: startUrl('selenium'), headless: !HEADED }).code);
        // In the temporary folder: what the script saves (screenshots) lands there.
        const r = await runFile('python', [file], { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS });
        if (r.error) fail(`${c.name}: the Selenium script failed: ${String(r.stderr || r.error.message).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.selenium = exportStates.get(`${c.name}:selenium`)?.state;
        if (!headlessChecked && states.selenium) {
          headlessChecked = true;
          check(states.selenium.headless === !HEADED, `the Selenium script runs ${HEADED ? 'with' : 'without'} a window, as exported`, states.selenium.headless);
        }
        for (const [name, ok] of Object.entries(c.files || {})) {
          const size = existsSync(join(dir, name)) ? pngSize(join(dir, name)) : null;
          check(size && ok(size), `${c.name}: the Selenium run saves ${name} as expected`, size);
        }
      }

      if (pytestHere && runners.includes('pytest')) {
        const file = join(dir, `test_${c.name.replace(/\W/g, '_')}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('pytest') },
          { driverType: 'Edge', startUrl: startUrl('pytest'), headless: !HEADED, output: 'pytest' }).code);
        const r = await runPytest(file, dir);
        if (r.error) fail(`${c.name}: the pytest test failed: ${String(r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.pytest = exportStates.get(`${c.name}:pytest`)?.state;
      }

      // Fields not named in `expect` are taken as playback left them.
      const expected = { clicks: [], alerts: [], marks: [], ...c.expect, fields: { ...states.playback?.fields, ...c.expect?.fields } };
      const wanted = stateDiff(states.playback, expected);
      check(states.playback && !Object.keys(wanted).length, `${c.name}: playback leaves the expected page`, wanted);
      for (const runner of ['bookmarklet', 'selenium', 'pytest']) {
        if (!(runner in states)) continue;
        const diff = stateDiff(states.playback, states[runner]);
        check(states[runner] && !Object.keys(diff).length,
          `${c.name}: the ${runner} export leaves the page as playback does`, states[runner] ? diff : 'no state posted');
      }
    }
    if (pytestHere) {
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

const CHECKS = [
  ['dropdown', 'Dropdown', checkDropdown],
  ['switch', 'Switch Always and the Random cap', checkSwitchAlways],
  ['capture', 'Two visible screenshots in a row', checkCapture],
  ['suggest', 'Variable suggestions in the popup', checkSuggest],
  ['switch-draft', 'Switch draft in the popup', checkSwitchDraft],
  ['background-tab', 'A run in a background tab', checkBackgroundTab],
  ['label-click', 'A click on a label, recorded and played', checkLabelClick],
  ['child-condition', 'Child Condition: innermost text match, ALL', checkChildCondition],
  ['file-input', 'A file input, recorded and played', checkFileInput],
  ['hotkeys', 'Record hotkeys: activated tabs only, macOS Option', checkHotkeys],
  ['schedule', 'A scheduled run on its start URL', checkSchedule],
  ['record-overlay', 'Recording ignores the extension overlays', checkRecordOverlay],
  ['condition-unknown', 'A Condition of an unknown type', checkConditionUnknown],
  ['selector-choice', 'The selector type chosen in the form plays first', checkSelectorChoice],
  ['shadow-dom', 'Elements in a shadow root', checkShadowDom],
  ['select-type', 'Child Condition type "select"', checkSelectType],
  ['form-roundtrip', 'Every action type through Edit → Save', checkFormRoundtrip],
  ['highlight', 'Highlights: made, saved, painted again after a reload', checkHighlight],
  ['import-warning', 'Importing actions that reach beyond the page', checkImportWarning],
  ['condition-choice', 'Condition and element screenshot use the chosen selector type', checkConditionChoice],
  ['cdp-targets', 'Upload, Dropdown and element screenshot act on the element the page found', checkCdpTargets],
  ['click-through', 'Click through: off for the scenario or the action', checkClickThrough],
  ['typed-text', 'A Text selector typed in the form', checkTypedText],
  ['select-missing', 'Input of an option a <select> does not have', checkSelectMissing],
  ['export-file-name', 'The file name of an exported script', checkExportFileName],
  ['export-steps', 'The export modal tells which steps were skipped', checkExportSteps],
  ['export-regenerate', 'Regenerate in the export modals', checkExportRegenerate],
  ['export-headless', 'The Headless switch of the Selenium export', checkExportHeadless],
  ['export-output', 'The Output choice of the Selenium export', checkExportOutput],
  ['export-run', 'Exported code run on a page, as playback leaves it', checkExportRun],
  ['record-untrusted', 'Recording ignores events the page dispatches', checkRecordUntrusted],
  ['record-checkbox', 'Ticking a checkbox while recording', checkRecordCheckbox],
  ['record-input-order', 'Typing, then a click at once', checkRecordInputOrder],
  ['record-other-tab', 'Recording ignores the other tabs', checkRecordOtherTab],
  ['record-restart', 'A recording across a worker restart', checkRecordRestart],
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
      reply.end(req.url.startsWith('/export') ? EXPORT_PAGE : TEST_PAGE);
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
