/**
 * tools/e2e/record.mjs — e2e suite "record". Run: node tools/e2e.mjs --suite record
 *
 * Recording: the hotkeys, Turn on, what is recorded and what is not, the recording pill,
 * a worker restart.
 *
 *   hotkeys       Alt+R on a tab that is not activated reaches the page; on an
 *                 activated tab, Option+R as macOS types it ("®") starts recording
 *   record-overlay  clicks and typing inside a [data-ext-overlay] box are not recorded
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
 *   record-check  ✓ Check while recording: Alt + click (or ✓ Check on the pill, then a
 *                 click) opens a menu of checks; the one chosen is recorded as an Assert,
 *                 after the text typed before it; the clicks that pick or close are not
 *                 steps, and the page gets none of them (an Alt + click on a link downloads nothing)
 */

import { asActiveTab, sleep } from '../lib/cdp-browser.mjs';
import { PAGE_SETTLE_MS, POLL_MS, POPUP_SETTLE_MS, POPUP_VIEWPORT, SETTLE_MS, check, clickAt, closeQuietly, fail, makeScenario, openPopup, record, reloadTestPage, showScenario } from './harness.mjs';
// After the worker is stopped: long enough for it to be gone before the next message wakes it.
const WORKER_STOP_SETTLE_MS = 1000;

export async function checkAutoActivate(ctx) {
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

// Settings → Allow on all tabs: reached from the "Off on this tab" question; then nothing asks,
// and the record hotkeys work on a tab never turned on.
export async function checkAllowAllTabs(ctx) {
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
export async function checkRecordDot(ctx) {
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

export async function checkHotkeys(ctx) {
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

export async function checkRecordOverlay(ctx) {
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

export async function checkRecordUntrusted(ctx) {
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

export async function checkRecordCheckbox(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record checkbox', async () => {
    await clickAt(ctx, '#agree');
    await sleep(600); // past the input debounce
  });
  check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #agree',
    'ticking a checkbox records the click only, not an Input of its value', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
}

export async function checkRecordInputOrder(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e record input order', async () => {
    await clickAt(ctx, '#out');
    await ctx.web.send('Input.insertText', { text: 'Alice' });
    await clickAt(ctx, '#bg1'); // within the input debounce
  });
  check(actions.map((a) => `${a.type} ${a.selector}`).join() === 'click #out,input #out,click #bg1',
    'text typed just before a click is recorded before it', actions.map((a) => `${a.type} ${a.selector} ${a.value ?? ''}`));
}

export async function checkRecordNames(ctx) {
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

export async function checkRecordingPill(ctx) {
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
  await clickAt(ctx, '#__pqa_recording button:last-of-type'); // ■ Stop, after ✓ Check
  await sleep(SETTLE_MS * 2);
  const status = await ctx.send({ type: 'GET_EXTENSION_STATUS' });
  const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('scenarios', (x) => r((x.scenarios[${JSON.stringify(id)}].actions || []).map((a) => a.selector))))`);
  const after = await pill();
  check(!status?.recording && after === null && JSON.stringify(saved) === '["#bg1"]',
    'Stop on the pill stops and saves the recording, the pill goes, and its click is not a step', { recording: status?.recording, after, saved });
  const idle = await buttons();
  check(idle.start === '▶ Start Recording' && !idle.startDisabled && !idle.stopDanger, 'stopped: Start and Stop are back as they were', idle);
}

export async function checkRecordOtherTab(ctx) {
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

/** A real click in the middle of `selector` with Alt held (CDP modifiers: Alt = 1). */
async function altClickAt(ctx, selector) {
  const { x, y } = await ctx.web.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.web.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers: 1 });
  }
}

/** A real click on the ✓ Check menu's button whose text starts with `text`. */
async function clickMenuItem(ctx, text) {
  const at = await ctx.web.evaluate(`(() => {
    const b = [...document.querySelectorAll('#__pqa_check_menu button')].find((x) => x.textContent.startsWith(${JSON.stringify(text)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.web.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  return true;
}

export async function checkRecordCheck(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.evaluate(`document.body.insertAdjacentHTML('afterbegin',
    '<div id="rcToast" style="padding:4px">Saved!</div><a id="rcLink" href="/rc-file.png" style="display:inline-block;padding:4px">Get the file</a>')`);
  const menu = () => ctx.web.evaluate(`(() => { const m = document.getElementById('__pqa_check_menu');
    return m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
  const pillLabel = () => ctx.web.evaluate(`document.getElementById('__pqa_recording')?.textContent || ''`);
  const downloadsBefore = ctx.browser.downloads().length;
  const urlBefore = await ctx.web.evaluate('location.href');
  let seen = {};
  const { actions } = await record(ctx, 'e2e record check', async () => {
    await clickAt(ctx, '#out');
    await ctx.web.send('Input.insertText', { text: 'Alice' });
    await altClickAt(ctx, '#rcToast'); // within the input debounce: the text comes first
    for (let waited = 0; !(await menu()) && waited < 3_000; waited += POLL_MS) await sleep(POLL_MS);
    seen.toastMenu = await menu();
    seen.picked = await clickMenuItem(ctx, 'Text is');
    await sleep(SETTLE_MS);
    seen.closedAfterPick = (await menu()) === null;

    // ✓ Check on the pill, then a click on the field: its value; Esc closes, nothing recorded.
    await clickAt(ctx, '#__pqa_recording button:first-of-type');
    await sleep(SETTLE_MS);
    seen.armedLabel = await pillLabel();
    await clickAt(ctx, '#out');
    for (let waited = 0; !(await menu()) && waited < 3_000; waited += POLL_MS) await sleep(POLL_MS);
    seen.fieldMenu = await menu();
    seen.disarmedLabel = await pillLabel();
    for (const type of ['keyDown', 'keyUp']) await ctx.web.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(SETTLE_MS);
    seen.closedByEsc = (await menu()) === null;

    // Alt + click on a link: no download, no navigation; a click elsewhere closes the menu and is not a step.
    await altClickAt(ctx, '#rcLink');
    for (let waited = 0; !(await menu()) && waited < 3_000; waited += POLL_MS) await sleep(POLL_MS);
    seen.linkMenu = await menu();
    await clickAt(ctx, '#bg1');
    await sleep(SETTLE_MS);
    seen.closedByClick = (await menu()) === null;
    await sleep(1_000); // a download would have started by now
  });
  seen.downloads = ctx.browser.downloads().length - downloadsBefore;
  seen.url = await ctx.web.evaluate('location.href');
  check(seen.toastMenu?.some((t) => t === 'Text is “Saved!”') && seen.toastMenu.some((t) => t === 'Is visible')
    && seen.toastMenu.some((t) => t === 'URL contains “/page”') && seen.toastMenu.includes('Text contains'),
  'Alt + click while recording opens a menu of the checks the element allows', seen.toastMenu);
  check(seen.picked && seen.closedAfterPick, 'choosing one closes the menu', seen);
  check(/Click what to check/.test(seen.armedLabel) && /Recording — Pocket QA/.test(seen.disarmedLabel)
    && seen.fieldMenu?.includes('Value is “Alice”') && seen.closedByEsc,
  '✓ Check on the pill: the next click opens the menu (a field: its value), then it is off again; Esc closes the menu', seen);
  check(!!seen.linkMenu && seen.closedByClick && seen.downloads === 0 && seen.url === urlBefore,
    'an Alt + click on a link opens the menu, not the link nor a download; a click on the page closes it', seen);
  const steps = actions.map((a) => (a.type === 'assert' ? `assert ${a.conditionType} ${a.selector} "${a.expectedValue}" ${a.label}` : `${a.type} ${a.selector}`));
  check(JSON.stringify(steps) === JSON.stringify(['click #out', 'input #out', 'assert textEquals #rcToast "Saved!" Saved!']),
    'recorded: the text typed first, then the Assert; the clicks that picked or closed are not steps', steps);
}

// Last in CHECKS: it stops the worker, and ctx.sw stays attached to the one that was stopped.
export async function checkRecordRestart(ctx) {
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

export const CHECKS = [
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
  ['record-check', '✓ Check while recording adds an Assert', checkRecordCheck],
  ['record-restart', 'A recording across a worker restart', checkRecordRestart],
];
