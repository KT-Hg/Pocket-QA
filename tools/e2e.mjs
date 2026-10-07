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
  // hotkeys: every Alt+key the page sees, and whether the extension kept it.
  window.addEventListener('keydown', (e) => { if (e.altKey) __log.push('key ' + e.code + ' ' + (e.defaultPrevented ? 'prevented' : 'free')); });
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
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  let prompt = false;
  while (!prompt && Date.now() - started < 15_000) {
    await sleep(POLL_MS);
    prompt = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]')].some((e) => /failed/i.test(e.textContent))`);
  }
  const seconds = (Date.now() - started) / 1000;
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(prompt && seconds < 4, 'an Input action on a file input fails at once', { prompt, seconds });
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
