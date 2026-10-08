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
 *                 and ALL needs every condition
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
 *                 with Edit and saved twice, comes back as it was each time
 *   highlight     a text selection opens the highlight tooltip, which follows the
 *                 popup theme; a colour saves the highlight, and a reload paints it again.
 *                 With Highlight off a page loads no highlight engine; turned on, the
 *                 open page loads it and paints the highlight
 *   record-other-tab  typing in another tab while recording is not recorded; the
 *                 recording tab still is
 *   record-restart  a recording whose worker stopped before the first action (it
 *                 sleeps after 30 s with nothing to do) still records that action
 *
 * Usage: node tools/e2e.mjs [--only <name>] [--ext <extension dir>] [--headed]
 *        --ext runs another checkout (an older commit, to see a check fail there).
 * Exit:  0 OK, 1 a check failed, 2 no browser found.
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
<div id="dd">Choose…</div>
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
<script>
  window.__log = [];
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
  return ctx.web.evaluate(`({ log: window.__log, dd: document.getElementById('dd').textContent,
    sel: document.getElementById('sel').value, out: document.getElementById('out').value,
    big: document.getElementById('big').value, timedOut: ${running} })`);
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
      reply.setHeader('content-type', 'text/html; charset=utf-8');
      reply.end(TEST_PAGE);
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
