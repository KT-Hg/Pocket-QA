// Characterization test of playback: playActionsOnTab and the four entry points
// (single run, resume from a checkpoint, sequence, CSV).
//
// background.js is loaded against tests/helpers/chrome-fake.mjs (+ bg-fakes.mjs)
// and every action type is played through its success path and its failure paths
// — the in-page prompt answering retry / skip / stop, or not answering at all —
// with Condition skips, Switch jumps, nested scenarios and Switch blocks. For each
// run the transcript keeps the value returned, the failed actions, every chrome.*
// call, console output, and the worker state and storage when they changed.
// tests/golden/playback.json holds the expected transcript; splitting the
// playback engine must reproduce it exactly.
//
// Run:    node --test "tests/*.test.mjs"
// Update: node tests/playback.test.mjs --update   (only for an intended change)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { installChromeFake } from './helpers/chrome-fake.mjs';
import {
  installImageFakes, installTabMessages, installDebugger, installCaptureVisibleTab,
  installNavigation, installIndexedDb, showLogLine, showPictures, png, listenerShapes,
} from './helpers/bg-fakes.mjs';

const GOLDEN = new URL('./golden/playback.json', import.meta.url);
const UPDATE = process.argv.includes('--update');

process.env.TZ = 'UTC';
const START_TABS = () => [
  { id: 1, windowId: 1, active: true, url: 'https://example.com/start', title: 'Start', status: 'complete' },
  { id: 2, windowId: 1, active: false, url: 'https://example.com/other', title: 'Other', status: 'complete' },
];
const tabs = START_TABS();
const fake = installChromeFake({ tabs });
installImageFakes(fake);
const nav = installNavigation(fake, tabs);
const idb = installIndexedDb(fake);

const raw = (w, h, tag) => png(w, h, tag).split(',')[1];

// ── the page ────────────────────────────────────────────────────────────────
// PLAY_ACTION answers by selector: a list is consumed one reply per call (the
// last one repeats), a function is called with the message.
let page = {};
let conditions = {};
let choices = [];
let promptHook = null;
const take = (list) => (list.length > 1 ? list.shift() : list[0]);
installTabMessages(fake, {
  PLAY_ACTION: (msg) => {
    const r = page[msg.action?.selector];
    if (Array.isArray(r)) return take(r);
    if (typeof r === 'function') return r(msg);
    return r ?? {};
  },
  // true / false, or the page's whole reply ({ result, error }).
  CHECK_CONDITION: (msg) => {
    const c = conditions[msg.selector];
    return c && typeof c === 'object' ? c : { result: !!c };
  },
  ACTION_FAILED_PROMPT: (msg) => {
    promptHook?.(msg);
    const c = choices.shift();
    return c ? { choice: c } : {};
  },
  GET_PAGE_DIMENSIONS: { viewportWidth: 800, viewportHeight: 600, fullWidth: 800, fullHeight: 1500, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  GET_ELEMENT_RECT: (msg) => (msg.selector === '#missing' ? { error: 'Element not found' } : { x: 10, y: 20, width: 300, height: 200 }),
});
installDebugger(fake, {
  command(method, params, tabId, n) {
    const expr = params.expression || '';
    if (method === 'Runtime.evaluate') {
      if (expr.includes('isSelect')) {
        if (expr.includes('#native')) return { result: { value: JSON.stringify({ x: 40.4, y: 60.6, isSelect: true }) } };
        if (expr.includes('#dd')) return { result: { value: JSON.stringify({ x: 10.5, y: 20.2, isSelect: false }) } };
        return { result: { value: null } };
      }
      if (expr.includes("inp.type = 'file'")) return { result: { value: 'ok' } };
      if (expr.includes('throw new Error')) {
        return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom\n    at <anonymous>:1:7' } } };
      }
      if (expr.includes('dragenter')) return { result: { value: expr.includes('#dz-missing') ? 'dropzone element not found for selector: "#dz-missing"' : 'ok' } };
      if (expr.includes('vpW: window.innerWidth')) return { result: { value: { x: 10, y: 900, width: 300, height: 200, dpr: 1, vpW: 800, vpH: 600 } } };
      return {};
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return params.selector === '#nofile' ? {} : { nodeId: 7 };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 800, height: 1500 } };
    if (method === 'Page.captureScreenshot') return { data: raw(params.clip.width, params.clip.height, `cdp${n}`) };
    return {};
  },
});
installCaptureVisibleTab(fake, (windowId, n) => png(800, 600, `visible${n}`));

// ── stored data ─────────────────────────────────────────────────────────────
const hover = (sel, extra) => ({ type: 'hover', selector: sel, ...extra });
const blk = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
Object.assign(fake.data.local, {
  scenarios: {
    tgt: { name: 'Target', actions: [hover('#t1'), hover('#t2'), hover('#t3')] },
    empty: { name: 'Empty', actions: [] },
    sBasic: { name: 'Basic', actions: [hover('#a'), { type: 'readdom', selector: '#loop', varName: '${n}' }, { type: 'wait', delay: 100 }] },
    sFail: { name: 'Fails', actions: [{ type: 'click', selector: '#fail' }, hover('#ok')] },
    sBlocks: { name: 'Blocks', actions: [
      { type: 'switch', switchVar: '${a}', cases: [blk('1', 2, 3), blk('2', 4, 5)] },
      hover('#A'), hover('#B'), hover('#C'), hover('#D'), hover('#E'),
    ] },
    sCsv: { name: 'Csv', actions: [
      { type: 'input', selector: '#name', value: '${user}' },
      { type: 'readdom', selector: '#total', varName: 'total' },
      { type: 'screenshot_tovar', varName: 'shot' },
      { type: 'switch', switchVar: '${user}', cases: [{ value: 'bob', scenarioId: 'csvNested' }] },
    ] },
    csvNested: { name: 'Nested', actions: [{ type: 'screenshot_tovar', varName: '${inner}', target: 'element', selector: '#el' }] },
    sLoop: { name: 'Loop', actions: [{ type: 'switch', switchVar: 'x', cases: [{ value: '1', scenarioId: '__self__', startAt: 1 }] }] },
    sDeep: { name: 'Deep', actions: [{ type: 'switch', switchVar: 'x', cases: [{ value: '1', scenarioId: 'sDeep' }] }] },
  },
  variables: { user: 'alice', x: '1', a: '1' },
});
Object.assign(fake.data.sync, { screenshotSaveMode: 'ask', screenshotPrefix: 'pb', notifyOnComplete: true });

const transcript = [];
let logMark = 0, consoleMark = 0;
let lastStorage = '', lastState = '';
const { state } = await import('../bg/state.js');

function stateView() {
  const { playback, sequencePlayback, csvPlayback, csvInterrupted, recording } = state;
  return { playback, sequencePlayback, csvPlayback, csvInterrupted, recording };
}

function snapshot(entry, { summary = false } = {}) {
  const calls = fake.log.slice(logMark);
  if (summary) {
    const counts = {};
    for (const line of calls) { const p = line.split(' ')[0]; counts[p] = (counts[p] || 0) + 1; }
    entry.callCounts = counts;
    entry.firstCalls = calls.slice(0, 40).map(showLogLine);
    entry.lastCalls = calls.slice(-40).map(showLogLine);
  } else {
    entry.calls = calls.map(showLogLine);
  }
  entry.console = fake.consoleLog.slice(consoleMark);
  logMark = fake.log.length;
  consoleMark = fake.consoleLog.length;
  const storage = JSON.stringify(showPictures(fake.data));
  if (storage !== lastStorage) { entry.storage = JSON.parse(storage); lastStorage = storage; }
  const st = JSON.stringify(stateView());
  if (st !== lastState) { entry.state = JSON.parse(st); lastState = st; }
  entry.pendingTimers = fake.pendingTimers();
  transcript.push(JSON.parse(JSON.stringify(entry)));
}

// ── start-up ────────────────────────────────────────────────────────────────
await import('../background.js');
await fake.settle(5_000);
snapshot({
  step: 'startup',
  listeners: listenerShapes(fake, ['runtime.onMessage', 'tabs.onRemoved', 'tabs.onUpdated', 'debugger.onDetach', 'windows.onRemoved', 'alarms.onAlarm']),
});

const { playActionsOnTab, startPlayback, startPlaybackFromCheckpoint, startSequence, startCsvPlayback } = await import('../bg/playback.js');

function idle() {
  state.playback = { active: false };
  state.sequencePlayback = { active: false };
  state.csvPlayback = { active: false };
  state.recording = false;
}

/** Run one case to completion (or until the virtual-time budget runs out). */
async function run(step, fn, { setup, teardown, summary = false, budget = 600_000 } = {}) {
  idle();
  tabs.splice(0, tabs.length, ...START_TABS());
  page = {}; conditions = {}; choices = []; promptHook = null;
  if (setup) setup();
  const box = { done: false };
  fn().then((v) => { box.done = true; box.value = v; }, (e) => { box.done = true; box.error = e?.message || String(e); });
  await fake.settle(budget);
  if (teardown) teardown();
  snapshot({ step, done: box.done, result: showPictures(box.value ?? null), error: box.error }, { summary });
}

const saved = {};

/** playActionsOnTab on tab 1 with playback marked active, as the entry points do. */
const play = (actions, vars, opts = {}) => async () => {
  state.playback = {
    active: true, tabId: 1, scenarioId: opts.scenarioId ?? null, scenarioName: 'Direct',
    originalScenarioName: 'Direct', actionIndex: 0, totalActions: actions.length,
  };
  const failed = [];
  const shots = opts.shots ? {} : null;
  const vars2 = await playActionsOnTab(
    1, actions, { vars, screenshotsResult: shots, forceAutoSave: !!opts.forceAutoSave, skipDownload: !!opts.skipDownload, startFromIndex: opts.start ?? 0, failedActions: failed, depth: 0, endAtIndex: opts.end ?? null },
  );
  return { vars: vars2, failed, shots };
};

// ── content-script actions, waits, CDP actions ──────────────────────────────
await run('content actions and waits', play([
  { type: 'click', selector: '#a' },
  { type: 'input', selector: '${sel}', value: '${u}', selectors: { css: '${sel}', xpath: '//*[@id="${u}"]' } },
  { type: 'wait', delay: 250 },
  { type: 'wait', value: '700' },
  { type: 'wait', value: 'abc' },
  { type: 'wait' },
  { type: 'wait', delay: '40', value: '900' },
  { type: 'script', code: 'console.log("${u}")', delay: 100 },
  { type: 'script', code: 'javascript: void 0' },
  { type: 'hover', selector: '#h', delay: 30, disabled: true },
  { type: 'input', selector: '#fb', value: '${fb}' },
  { type: 'input', selector: '#fb2', value: '${fb}' },
  { type: 'hover', selector: '#frame', frameId: 3, timeout: 15_000, delay: 10 },
], { u: 'alice', sel: '#b', fb: '{fallback:x|y}' }), {
  setup: () => { page['#fb'] = { resolvedFallbacks: { '{fallback:x|y}': 'y' } }; },
});

await run('dropdowns', play([
  { type: 'dropdown', selectors: { css: '#dd' }, delay: 50 },
  { type: 'dropdown', selector: '#native' },
  { type: 'dropdown', selector: '#unknown' },
  { type: 'dropdown' },
  { type: 'dropdown', selectors: { id: 'dd2' } },
], {}), { setup: () => { choices = ['skip']; } });

await run('dropdown on an attached session', play([
  { type: 'dropdown', selector: '#dd' },
  { type: 'script', code: '1' },
], {}), {
  setup: () => {
    saved.attach = chrome.debugger.attach;
    chrome.debugger.attach = (target, ver, cb) => saved.attach(target, ver, () => {
      fake.setLastError({ message: 'Another debugger is already attached' });
      try { cb(); } finally { fake.setLastError(undefined); }
    });
  },
  teardown: () => { chrome.debugger.attach = saved.attach; },
});

await run('dropdown: opened by the page', play([
  { type: 'dropdown', selector: '//div[@id="x"]', selectors: { xpath: '//div[@id="x"]' } },
  { type: 'dropdown', selector: '#framed', frameId: 2 },
  { type: 'dropdown', selector: '(//ul)[2]', selectors: { xpath: '(//ul)[2]' } },
  hover('#end'),
], {}), { setup: () => { page['(//ul)[2]'] = { failed: true }; } });

await run('clicks that navigate, fail, retry', play([
  { type: 'select', selector: '#s', delay: 20 },
  { type: 'click', selector: '#navaway', delay: 15 },
  { type: 'click', selector: '#gone' },
  { type: 'input', selector: '#bad' },
  { type: 'click', selector: '#err' },
  { type: 'hover', selector: '#last' },
], {}), {
  setup: () => {
    page['#s'] = () => { tabs[0].url = 'https://example.com/after-select'; return {}; };
    page['#navaway'] = () => { tabs[0].url = 'https://example.com/after-click'; return { __lastError: 'Could not establish connection. Receiving end does not exist.' }; };
    page['#gone'] = { __lastError: 'Could not establish connection. Receiving end does not exist.' };
    page['#bad'] = [{ failed: true, error: 'Element not found' }, {}];
    page['#err'] = { failed: true };
    choices = ['skip', 'retry', 'skip'];
  },
});

await run('a page that never answers', play([
  { type: 'click', selector: '#slow', timeout: 20_000 },
  { type: 'hover', selector: '#after' },
], {}), {
  setup: () => {
    choices = ['skip'];
    saved.send = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (...args) => {
      if (args[1]?.action?.selector === '#slow') { fake.log.push(`tabs.sendMessage (no reply) ${JSON.stringify(args[1])}`); return undefined; }
      return saved.send(...args);
    };
  },
  teardown: () => { chrome.tabs.sendMessage = saved.send; },
});

await run('prompt not shown: notify and move on', play([
  { type: 'click', selector: '#x1', label: 'First' },
  { type: 'hover', selector: '#x2' },
], {}), {
  setup: () => {
    page['#x1'] = { failed: true, error: 'Nope' };
    tabs[0].status = 'loading';
  },
});

await run('prompt answered stop', play([
  { type: 'click', selector: '#x1' },
  { type: 'hover', selector: '#never' },
], {}), { setup: () => { page['#x1'] = { failed: true, error: 'Nope' }; choices = ['stop']; } });

await run('stopped while the prompt is up', play([
  { type: 'click', selector: '#x1' },
  { type: 'hover', selector: '#never' },
], {}), {
  setup: () => {
    page['#x1'] = { failed: true, error: 'Nope' };
    // The prompt never answers; the user presses Stop in the popup after 2 s.
    saved.send = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (...args) => {
      if (args[1]?.type === 'ACTION_FAILED_PROMPT') { fake.log.push(`tabs.sendMessage (held) ${JSON.stringify(args[1])}`); return undefined; }
      return saved.send(...args);
    };
    setTimeout(() => { state.playback.active = false; }, 2_000);
  },
  teardown: () => { chrome.tabs.sendMessage = saved.send; },
});

// ── navigate ────────────────────────────────────────────────────────────────
await run('navigate', play([
  { type: 'navigate', url: 'https://example.com/ok', delay: 100 },
  { type: 'navigate', value: 'https://spa.example.com/spa/page', url: 'https://ignored.example.com/' },
  { type: 'navigate', url: 'https://example.com/never' },
  { type: 'navigate', url: 'https://example.com/never-again' },
  { type: 'hover', selector: '#after-nav' },
], {}), { setup: () => { choices = ['retry', 'skip', undefined, undefined, undefined]; } });

await run('navigate: tab closes', play([
  { type: 'navigate', url: 'https://example.com/closes' },
  { type: 'hover', selector: '#unreached' },
], {}));

await run('navigate: stopped while loading', play([
  { type: 'navigate', url: 'https://example.com/never' },
  { type: 'hover', selector: '#unreached' },
], {}), {
  setup: () => {
    setTimeout(() => { state.playback.active = false; nav.fire('tabs.onUpdated', 2, { status: 'loading' }, {}); }, 1_000);
  },
});

await run('tab closed during a wait', play([
  { type: 'wait', delay: 5_000 },
  { type: 'hover', selector: '#unreached' },
], {}), { setup: () => { setTimeout(() => nav.closeTab(1), 1_000); } });

// ── screenshots ─────────────────────────────────────────────────────────────
await run('screenshots', play([
  { type: 'screenshot', value: 'named' },
  { type: 'screenshot', delay: 25 },
  { type: 'screenshot_full' },
  { type: 'screenshot_full', value: 'whole.png' },
  { type: 'screenshot_element', selector: '#el', selectors: { css: '#el', id: 'el' }, delay: 5 },
  { type: 'screenshot_tovar', target: 'element', selector: '#el', varName: '${shotA}' },
  { type: 'screenshot_tovar', target: 'full', varName: 'shotB' },
  { type: 'screenshot_tovar', varName: 'shotC', delay: 7 },
  { type: 'screenshot_tovar', target: 'element', varName: 'noSelector' },
  { type: 'screenshot_tovar', target: 'element', selector: '#missing', varName: 'shotD' },
  { type: 'screenshot_element', selector: '#missing' },
  { type: 'hover', selector: '#unreached' },
], {}, { shots: true }), { setup: () => { choices = ['skip', 'retry', 'stop']; } });

await run('screenshots: CSV mode (auto save, no download)', play([
  { type: 'screenshot' },
  { type: 'screenshot_tovar', varName: 'v' },
  { type: 'screenshot_full' },
], {}, { shots: true, forceAutoSave: true, skipDownload: true }));

await run('screenshots: background tab', play([
  { type: 'screenshot' },
  { type: 'screenshot_tovar', varName: 'bg' },
], {}, { shots: true }), { setup: () => { tabs[0].active = false; choices = ['skip', 'skip']; } });

// ── readdom ─────────────────────────────────────────────────────────────────
await run('readdom', play([
  { type: 'readdom', selector: '#r', varName: '${name}' },
  { type: 'readdom', selector: '#code', varName: 'code', pattern: 'ID-${num} (${tag})' },
  { type: 'readdom', selector: '#code2', pattern: 'X-${n}', varName: 'whole', matchCase: true },
  { type: 'readdom', selector: '#flaky', varName: 'f' },
  { type: 'readdom', selector: '#frame', varName: 'fr', frameId: 3, timeout: 15_000, delay: 12 },
  { type: 'readdom', selector: '#nopattern', pattern: 'P-${p}' },
  { type: 'readdom', selector: '#fbv', varName: 'fbv' },
  { type: 'readdom', selector: '#rf', varName: 'rf' },
  { type: 'hover', selector: '#unreached' },
], { whole: 'old', n: 'old', fb: '{fallback:a|b}' }), {
  setup: () => {
    page['#r'] = { value: 'Alice' };
    page['#code'] = { value: 'id-42 (x)' };
    page['#code2'] = { value: 'nope' };
    page['#flaky'] = [{ failed: true, error: 'Element not found' }, { value: 'ok' }];
    page['#frame'] = { value: 'in frame' };
    page['#nopattern'] = { value: 'P-7' };
    page['#fbv'] = { value: 'b', resolvedFallbacks: { '{fallback:a|b}': 'b' } };
    page['#rf'] = { failed: true, error: 'gone' };
    choices = ['skip', 'retry', 'stop'];
  },
});

// ── condition ───────────────────────────────────────────────────────────────
await run('condition', play([
  { type: 'condition', conditionType: 'elementExists', selector: '#yes', skipCount: 2 },
  hover('#a'),
  { type: 'condition', selector: '#no', skipCount: 2, delay: 40 },
  hover('#skipped1'), hover('#skipped2'),
  { type: 'condition', selector: '#no', empty: true },
  hover('#after-empty'),
  { type: 'condition', selector: '#no', skipCount: 0 },
  hover('#skipped3'),
  { type: 'condition', conditionType: 'textEquals', selector: '#t', selectors: { css: '#t' }, expectedValue: '${v}', frameId: 2 },
  hover('#skipped4'),
  { type: 'condition', selector: '#no', skipCount: 9 },
  hover('#skipped5'),
], { v: 'val' }), { setup: () => { conditions['#yes'] = true; } });

await run('condition over a Switch block', play([
  { type: 'condition', conditionType: 'elementExists', selector: '#none', skipCount: 1 },
  { type: 'switch', switchVar: '${a}', cases: [blk('1', 3, 3)] },
  hover('#A'),
  hover('#E'),
], { a: '1' }));

// ── switch ──────────────────────────────────────────────────────────────────
await run('switch: jumps and nested scenarios', play([
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'tgt', startAt: 2, endAt: 3 }, { value: '__default__', scenarioId: 'tgt' }] },
  { type: 'switch', switchVar: '${mode}', cases: [{ value: 'y', scenarioId: 'tgt' }] },
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'tgt', startAt: 9 }] },
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'tgt', startAt: 2, endAt: 1 }] },
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'tgt', startAt: 1, endAt: 7 }] },
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'nope', scenarioName: 'Gone' }] },
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'empty' }] },
  { type: 'switch', switchVar: 'role', delay: 9, cases: [{ value: 'admin', scenarioId: '__self__', startAt: 10 }] },
  hover('#skippedBySelfJump'),
  hover('#landed'),
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: '__self__', startAt: 99 }] },
  { type: 'switch', switchVar: 'role', delay: 20, cases: [{ value: 'other', scenarioId: 'tgt' }, { value: '__default__', scenarioId: 'tgt', startAt: 3 }] },
  { type: 'switch', switchVar: '${missing}', cases: [{ value: 'admin', scenarioId: 'tgt' }] },
], { role: 'admin', mode: 'x' }), { setup: () => { choices = ['skip', 'skip', 'skip', 'retry', 'skip', 'skip', 'skip', 'skip', 'skip']; } });

await run('switch: nested run stopped', play([
  { type: 'switch', switchVar: 'role', cases: [{ value: 'admin', scenarioId: 'sFail' }] },
  hover('#unreached'),
], { role: 'admin' }), { setup: () => { page['#fail'] = { failed: true, error: 'x' }; choices = ['stop']; } });

await run('switch blocks', play([
  { type: 'switch', switchVar: '${a}', label: 'S', cases: [blk('1', 2, 3), blk('2', 4, 5)], delay: 3 },
  hover('#A'), hover('#B'), hover('#C'), hover('#D'),
  { type: 'switch', switchVar: '${b}', cases: [blk('p', 7, 7), blk('q', 8, 8)] },
  hover('#P'), hover('#Q'),
  { type: 'switch', switchVar: '${a}', disabled: true, cases: [blk('1', 10, 10)] },
  hover('#disabledBlock'),
  { type: 'switch', switchVar: '${a}', disabled: true, cases: [{ value: '1', scenarioId: '__self__', startAt: 13 }] },
  hover('#afterDisabledOld'),
  { type: 'switch', switchVar: '${zz}', cases: [blk('1', 14, 14)] },
  hover('#noCaseMatched'),
  hover('#end'),
], { a: '1', b: 'q' }));

await run('switch blocks: explicit continueAt and nested block', play([
  { type: 'switch', switchVar: '${a}', continueAt: 7, cases: [blk('1', 2, 5)] },
  hover('#A'),
  { type: 'switch', switchVar: '${b}', cases: [blk('p', 4, 4), blk('q', 5, 5)] },
  hover('#P'), hover('#Q'), hover('#X'), hover('#Y'),
], { a: '1', b: 'p' }));

await run('switch blocks: invalid block', play([
  { type: 'switch', switchVar: '${a}', cases: [blk('1', 2, 3), blk('2', 3, 4)] },
  hover('#A'), hover('#B'), hover('#C'), hover('#D'),
], { a: '1' }), { setup: () => { choices = ['retry', 'skip']; } });

await run('switch blocks: invalid block, stop', play([
  { type: 'switch', switchVar: '${a}', cases: [blk('1', 2, 3), blk('2', 3, 4)] },
  hover('#A'),
], { a: '1' }), { setup: () => { choices = ['stop']; } });

await run('switch blocks: backward continueAt loops to the cap', play([
  hover('#top'),
  { type: 'switch', switchVar: '${a}', continueAt: 1, cases: [blk('1', 3, 3)] },
  hover('#inBlock'),
], { a: '1' }), { summary: true, setup: () => { choices = ['skip']; } });

await run('switch: self-jump loop hits the cap', play([
  { type: 'switch', switchVar: 'x', cases: [{ value: '1', scenarioId: '__self__', startAt: 1 }] },
  hover('#after'),
], { x: '1' }), { summary: true, setup: () => { choices = ['stop']; } });

await run('switch: nesting deeper than 10', play([
  { type: 'switch', switchVar: 'x', cases: [{ value: '1', scenarioId: 'sDeep' }] },
], { x: '1' }), { summary: true });

// ── upload ──────────────────────────────────────────────────────────────────
await run('uploadFile', play([
  { type: 'uploadFile', selector: '#f' },
  { type: 'uploadFile', selectors: { css: '#file' }, folderPath: 'C:\\data\\', fileNames: ['a.txt', '${n}.txt'], delay: 8 },
  { type: 'uploadFile', selector: '#dz', uploadMode: 'dropzone', folderPath: '/tmp/x//', fileName: 'c.png' },
  { type: 'uploadFile', selector: '#nofile', folderPath: '/tmp', fileName: 'd.png' },
  { type: 'uploadFile', selector: '#dz-missing', uploadMode: 'dropzone', folderPath: '/tmp', fileNames: [] , fileName: 'e.png' },
  { type: 'uploadFile', selectors: { id: 'file2' }, folderPath: 'x', fileName: 'y' },
  hover('#end'),
], { n: 'b' }), { setup: () => { choices = ['skip', 'skip', 'skip', 'skip']; } });

// ── run boundaries ──────────────────────────────────────────────────────────
await run('start and end index', play([hover('#0'), hover('#1'), hover('#2'), hover('#3'), hover('#4')], {}, { start: 1, end: 2 }));
await run('end index past the end', play([hover('#0'), hover('#1')], {}, { start: 1, end: 7 }));
await run('not active: nothing runs', async () => {
  state.playback = { active: false };
  return playActionsOnTab(1, [hover('#a')], { vars: { k: 'v' } });
});
await run('variables from storage, random and pick', play([
  { type: 'input', selector: '#r', value: '${user}|${rnd}|${pk}|${dt}' },
], null), {
  setup: () => {
    fake.data.local.variables = { user: 'alice', rnd: '{random:numeric:6}', pk: '{pick:a|b|c}', dt: '{random:datetime:0}', obj: { activeType: 'p', p: ['q'] } };
  },
});
await run('an action that throws', play([null, hover('#after')], {}), { setup: () => { choices = ['retry', 'skip']; } });
await run('checkpoint per action', play([hover('#a'), hover('#b')], {}, { scenarioId: 'sBasic' }));

// ── entry points ────────────────────────────────────────────────────────────
fake.data.local.variables = { user: 'alice', x: '1', a: '1' };
await run('startPlayback: refused while recording', () => startPlayback('sBasic'), { setup: () => { state.recording = true; } });
await run('startPlayback: already running', () => startPlayback('sBasic'), { setup: () => { state.csvPlayback = { active: true }; } });
await run('startPlayback: unknown scenario', () => startPlayback('zz'));
await run('startPlayback: no active tab', () => startPlayback('sBasic'), {
  setup: () => { for (const t of tabs) t.active = false; delete fake.data.session._lastActiveTabId; },
});
await run('startPlayback: two loops', () => startPlayback('sBasic', 2, 50), { setup: () => { page['#loop'] = [{ value: 'v1' }, { value: 'v2' }]; } });
await run('startPlayback: one loop, fractional count', () => startPlayback('sBasic', 0.4));
await run('startPlayback: failures counted', () => startPlayback('sFail'), { setup: () => { page['#fail'] = { failed: true, error: 'x' }; choices = ['skip']; } });
await run('startPlayback: stopped from the prompt', () => startPlayback('sFail', 3), { setup: () => { page['#fail'] = { failed: true, error: 'x' }; choices = ['stop']; } });
await run('resume: inside a block case', () => startPlaybackFromCheckpoint('sBlocks', 1, 1));
await run('resume: plain', () => startPlaybackFromCheckpoint('sBasic', 2, 1));
await run('resume: refused while running', () => startPlaybackFromCheckpoint('sBasic', 0, 1), { setup: () => { state.sequencePlayback = { active: true }; } });
await run('resume: refused while recording', () => startPlaybackFromCheckpoint('sBasic', 0, 1), { setup: () => { state.recording = true; } });
await run('resume: unknown scenario', () => startPlaybackFromCheckpoint('zz', 0, 1));
await run('sequence', () => startSequence([
  { id: 'sBasic', delay: 30 }, { id: 'missing', delay: 5 }, { id: 'sFail', disabled: true }, { id: 'sFail', delay: 0 },
]), { setup: () => { page['#fail'] = { failed: true, error: 'x' }; choices = ['skip']; } });
await run('sequence: tab closed', () => startSequence([{ id: 'sBasic', delay: 0 }, { id: 'sBasic', delay: 0 }]), {
  setup: () => { setTimeout(() => nav.closeTab(1), 150); },
});
await run('sequence: no active tab', () => startSequence([{ id: 'sBasic' }]), {
  setup: () => { for (const t of tabs) t.active = false; delete fake.data.session._lastActiveTabId; },
});
await run('sequence: refused while recording', () => startSequence([{ id: 'sBasic' }]), { setup: () => { state.recording = true; } });
await run('sequence: already running', () => startSequence([{ id: 'sBasic' }]), { setup: () => { state.playback = { active: true }; } });

const csvRows = [{ user: 'bob', inner: 'innerShot' }, { user: 'carol' }, { user: 'dave' }];
await run('csv: xlsx run', () => startCsvPlayback('sCsv', csvRows, 20, 'xlsx'), {
  setup: () => { page['#total'] = [{ value: '10' }, { failed: true, error: 'no total' }, { value: '30' }]; choices = ['skip']; },
});
await run('csv: csv run with downloads, stop after row', () => startCsvPlayback('sCsv', csvRows, 0, 'csv'), {
  setup: () => {
    page['#total'] = () => { state.csvPlayback.stopAfterRow = true; return { value: '1' }; };
  },
});
await run('csv: resume from row 2', () => startCsvPlayback('sCsv', csvRows, 0, 'zip', 2));
await run('csv: unknown scenario', () => startCsvPlayback('zz', csvRows, 0));
await run('csv: no active tab, last-known tab used', () => startCsvPlayback('sCsv', csvRows.slice(0, 1), 0), {
  setup: () => { for (const t of tabs) t.active = false; },
});
await run('csv: refused while running', () => startCsvPlayback('sCsv', csvRows, 0), { setup: () => { state.playback = { active: true }; } });
await run('csv: stopped from the prompt', () => startCsvPlayback('sCsv', csvRows, 0, 'html'), {
  setup: () => { page['#total'] = { failed: true, error: 'x' }; choices = ['stop']; },
});
await run('csv: storage fails mid-run', () => startCsvPlayback('sCsv', csvRows, 0, 'xlsx'), {
  setup: () => { idb.failWrites = 'results'; },
});
idb.failWrites = null;

// "Choose item #": the page sets a <select> itself; anything else answers
// needsOpen, is opened (CDP, or the page when in a frame / known by XPath), and
// the page then clicks the item.
const picked = (index, text) => ({ picked: { index, text, count: 4 } });
await run('dropdown: choose item #', play([
  { type: 'dropdown', selector: '#native', pick: { by: 'index', index: '${n}' } },
  { type: 'dropdown', selector: '#dd', selectors: { css: '#dd' }, pick: { by: 'index', index: '-1', itemSelector: '.m-${m} li' }, delay: 20 },
  { type: 'dropdown', selector: '#framed', frameId: 2, pick: { by: 'index', index: '2' } },
  { type: 'dropdown', selector: '//div[@id="x"]', selectors: { xpath: '//div[@id="x"]' }, pick: { by: 'index', index: 'random' } },
  { type: 'dropdown', selector: '#short', pick: { by: 'index', index: '9' } },
  { type: 'dropdown', selector: '#stale', pick: { by: 'index', index: '1' } },
  { type: 'dropdown', selector: '#gone', pick: { by: 'index', index: '1' } },
], { n: '3', m: 'top' }), {
  setup: () => {
    choices = ['skip', 'skip', 'skip'];
    page['#native'] = (msg) => (msg.pickStage === 'select' ? picked(3, 'C') : { failed: true, error: 'opened' });
    const custom = (msg) => {
      if (msg.pickStage === 'select') return { needsOpen: true };
      if (msg.pickStage === 'items') return picked(4, 'Last');
      return {}; // the page's own click
    };
    page['#dd'] = custom;
    page['#framed'] = custom;
    page['//div[@id="x"]'] = custom;
    page['#short'] = (msg) => (msg.pickStage === 'select'
      ? { needsOpen: true }
      : { failed: true, error: 'Dropdown: there is no item #9 (4 found); items looked for: role=option / menuitem' });
    page['#stale'] = {}; // a content script from before this action answers without choosing
    page['#gone'] = { __lastError: 'Could not establish connection. Receiving end does not exist.' };
  },
});

// Switch "Always" (the form's mode): no variable, one default case — played
// with no code of its own, the default case runs every time, then the parent
// goes on. The variables do not matter, even one equal to "" or "__default__".
await run('switch: always plays its scenario', play([
  { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'tgt', scenarioName: 'Target' }] },
  hover('#after1'),
  { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'tgt', scenarioName: 'Target', startAt: 2, endAt: 2 }] },
  hover('#after2'),
  { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'nope', scenarioName: 'Deleted' }] },
  hover('#after3'),
], { blank: '', role: '__default__' }), { setup: () => { choices = ['skip']; } });

// Play pressed twice before the first run has marked itself active: one run,
// and the second press told so. Last, so nothing above changes in the golden.
await run('startPlayback: twice at once', () => Promise.all([startPlayback('sBasic'), startPlayback('sBasic')]));
await run('resume: twice at once', () => Promise.all([startPlaybackFromCheckpoint('sBasic', 0, 1), startPlaybackFromCheckpoint('sBasic', 0, 1)]));
const _countCalls = (step, text) => transcript.find((e) => e.step === step)?.calls.filter((c) => c.includes(text)).length;
test('Play twice at once plays the scenario once', () => {
  assert.equal(_countCalls('startPlayback: twice at once', '"PLAY_ACTION"'), _countCalls('startPlayback: one loop, fractional count', '"PLAY_ACTION"'));
  assert.equal(_countCalls('startPlayback: twice at once', 'PLAYBACK_ALREADY_RUNNING'), 1);
});
test('Resume twice at once resumes once', () => {
  assert.equal(_countCalls('resume: twice at once', 'PLAYBACK_ALREADY_RUNNING'), 1);
});

// A Script that throws, or that finds no debugger session, fails its action
// (it used to pass whatever happened).
await run('script: throws', play([{ type: 'script', code: 'throw new Error("boom")' }, hover('#after')], {}), {
  setup: () => { choices = ['skip']; },
});
await run('script: no debugger session', play([{ type: 'script', code: 'document.title' }, hover('#after')], {}), {
  setup: () => {
    choices = ['skip'];
    saved.attach = chrome.debugger.attach;
    saved.sendCommand = chrome.debugger.sendCommand;
    const withError = (base, message) => (...args) => {
      const cb = args.pop();
      base(...args, (...r) => {
        fake.setLastError({ message });
        try { cb(...r); } finally { fake.setLastError(undefined); }
      });
    };
    chrome.debugger.attach = withError(saved.attach, 'Cannot attach to this target.');
    chrome.debugger.sendCommand = withError(saved.sendCommand, 'Debugger is not attached to the tab with id: 1.');
  },
  teardown: () => { chrome.debugger.attach = saved.attach; chrome.debugger.sendCommand = saved.sendCommand; },
});
// Inside another scenario a Switch went into, the checkpoint stays on the Switch
// and says where in the other scenario the run is; a resume finishes that
// scenario, then goes on after the Switch.
const toTarget = { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'tgt', scenarioName: 'Target' }] };
await run('checkpoint inside another scenario', play([toTarget, hover('#after')], {}, { scenarioId: 'sNest' }));
await run('resume: inside another scenario', () => startPlaybackFromCheckpoint('sNest', 1, 1, [{ scenarioId: 'tgt', actionIndex: 0, endAtIndex: null }]), {
  setup: () => { fake.data.local.scenarios.sNest = { name: 'Nest', actions: [toTarget, hover('#after')] }; },
});
const _callsOf = (step) => transcript.find((e) => e.step === step)?.calls || [];
test('a checkpoint inside another scenario stays on the Switch and names that scenario', () => {
  const inTarget = _callsOf('checkpoint inside another scenario')
    .filter((c) => c.startsWith('storage.local.set') && c.includes('"nested"'))
    .map((c) => JSON.parse(c.slice(c.indexOf(' ') + 1))[0].playbackCheckpoint)
    .map((cp) => [cp.actionIndex, cp.nested[0].scenarioId, cp.nested[0].actionIndex]);
  assert.deepEqual(inTarget, [[0, 'tgt', 0], [0, 'tgt', 1], [0, 'tgt', 2]]);
});
test('a resume inside another scenario finishes it, then goes on after the Switch', () => {
  const played = _callsOf('resume: inside another scenario').filter((c) => c.includes('"PLAY_ACTION"')).map((c) => /"selector":"([^"]+)"/.exec(c)?.[1]);
  assert.deepEqual(played, ['#t2', '#t3', '#after']);
});
// A Dropdown on a native <select> keeps its CDP session open (detaching would
// close the list); the run detaches it when it ends.
await run('startPlayback: a native select left open is detached at the end', () => startPlayback('sSelect'), {
  setup: () => { fake.data.local.scenarios.sSelect = { name: 'Select', actions: [{ type: 'dropdown', selector: '#native' }, hover('#after')] }; },
});
test('a run detaches the session a native <select> Dropdown left open', () => {
  const calls = _callsOf('startPlayback: a native select left open is detached at the end');
  const pressed = calls.findIndex((c) => c.includes('mousePressed'));
  assert.ok(pressed >= 0);
  assert.equal(calls.slice(pressed).filter((c) => c.startsWith('debugger.detach')).length, 1);
});
const _failedOf = (step) => JSON.stringify(transcript.find((e) => e.step === step)?.result?.failed);
test('a Script that throws fails its action', () => assert.match(_failedOf('script: throws'), /boom/));
test('a Script with no debugger session fails its action', () => assert.match(_failedOf('script: no debugger session'), /not attached/));

// A Condition the page cannot evaluate (an unknown type) is reported, not passed;
// skipping it leaves the guarded action to run.
await run('condition: the page cannot evaluate it', play([
  { type: 'condition', conditionType: 'bogus', selector: '#bogus', skipCount: 1 }, hover('#guarded'), hover('#after'),
], {}), {
  setup: () => { conditions['#bogus'] = { result: false, error: 'Unknown condition type "bogus"' }; choices = ['skip']; },
});
test('a Condition the page cannot evaluate fails, and skip runs what it guards', () => {
  assert.match(_failedOf('condition: the page cannot evaluate it'), /Unknown condition type/);
  assert.ok(_callsOf('condition: the page cannot evaluate it').some((c) => c.includes('"selector":"#guarded"')));
});

// ── compare ─────────────────────────────────────────────────────────────────
function stringify(v, depth = 3, pad = '') {
  if (depth === 0 || v === null || typeof v !== 'object' || !Object.keys(v).length) return JSON.stringify(v);
  const inner = pad + ' ';
  if (Array.isArray(v)) return '[\n' + v.map((x) => inner + stringify(x, depth - 1, inner)).join(',\n') + '\n' + pad + ']';
  return '{\n' + Object.keys(v).map((k) => inner + JSON.stringify(k) + ': ' + stringify(v[k], depth - 1, inner)).join(',\n') + '\n' + pad + '}';
}

if (UPDATE) {
  writeFileSync(GOLDEN, stringify(transcript) + '\n');
  process.stdout.write(`wrote tests/golden/playback.json (${transcript.length} steps)
`);
} else {
  const expected = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : [];
  test('playback transcript: same steps', () => {
    assert.deepStrictEqual(transcript.map((e) => e.step), expected.map((e) => e.step));
  });
  test('playback transcript', async (t) => {
    for (let i = 0; i < Math.max(transcript.length, expected.length); i++) {
      await t.test(`${i} ${transcript[i]?.step ?? expected[i]?.step}`, () => assert.deepStrictEqual(transcript[i], expected[i]));
    }
  });
}
