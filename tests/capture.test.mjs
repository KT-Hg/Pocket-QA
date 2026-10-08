// Characterization test of screen capture in the service worker: visible,
// full page, vertical / horizontal scroll, segments, element, window capture,
// the crop editor hand-off, watermark, image diff and the capture messages.
//
// background.js is loaded against tests/helpers/chrome-fake.mjs (+ bg-fakes.mjs).
// The debugger answers like Chrome would; captured frames are "pictures" whose
// bytes describe them, and canvases record every drawImage, so the transcript
// shows each CDP command in order, every tile, and where each tile was stitched.
// It covers zoom ≠ 100 %, pages over the 4 000 px capture limit, device-pixel
// ratios, a cancel mid-capture (ESC or the debugging banner), a debugger that
// will not attach, and the hotkey notifications. tests/golden/capture.json holds
// the expected transcript; splitting bg/screenshot.js must reproduce it exactly.
//
// Run:    node --test "tests/*.test.mjs"
// Update: node tests/capture.test.mjs --update   (only for an intended change)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { installChromeFake } from './helpers/chrome-fake.mjs';
import {
  installImageFakes, installTabMessages, installDebugger, installCaptureVisibleTab, installDownloads,
  showLogLine, showPictures, png, listenerShapes,
} from './helpers/bg-fakes.mjs';

const GOLDEN = new URL('./golden/capture.json', import.meta.url);
const UPDATE = process.argv.includes('--update');

process.env.TZ = 'UTC';
// The watermark's {datetime}: locale-independent here.
Date.prototype.toLocaleString = function () { return this.toISOString(); };

const START_TABS = () => [
  { id: 1, windowId: 1, active: true, url: 'https://example.com/start', title: 'Start', status: 'complete' },
  { id: 2, windowId: 1, active: false, url: 'https://example.com/other', title: 'Other', status: 'complete' },
  { id: 3, windowId: 2, active: true, url: 'https://very-long-host-name.example.com/a/rather/deep/path/to/a/page/with/a/name?and=query&string=values', title: 'Long', status: 'complete' },
];
const tabs = START_TABS();
const fake = installChromeFake({ tabs });
installImageFakes(fake);

const raw = (w, h, tag) => png(w, h, tag).split(',')[1];
const saved = {};

// ── per-case behaviour ──────────────────────────────────────────────────────
let page, cdp, visible, download;
function defaults() {
  page = {
    dims: { viewportWidth: 800, viewportHeight: 600, fullWidth: 800, fullHeight: 1500, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    rect: { x: 10, y: 20, width: 300, height: 200 },
    countdown: { __lastError: 'Could not establish connection. Receiving end does not exist.' },
  };
  cdp = {
    phys: 1,
    layout: { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 800, height: 1500 } },
    rect: { x: 10, y: 900, width: 300, height: 200, dpr: 1, vpW: 800, vpH: 600 },
  };
  visible = (windowId, n) => png(800, 600, `visible${n}`);
  download = () => 7;
}
defaults();

installTabMessages(fake, {
  GET_PAGE_DIMENSIONS: () => page.dims,
  GET_ELEMENT_RECT: () => page.rect,
  START_VISIBLE_COUNTDOWN: () => page.countdown,
  FULL_CAPTURE_STATE: {},
});
const debuggerCtl = installDebugger(fake, {
  attach: () => (cdp.attachError ? { __lastError: cdp.attachError } : undefined),
  detach: () => (cdp.detachError ? { __lastError: cdp.detachError } : undefined),
  command(method, params, tabId, n) {
    cdp.onCommand?.(method, params, n);
    if (cdp.dead) return { __lastError: `Debugger is not attached to the tab with id: ${tabId}.` };
    if (method === 'Page.getLayoutMetrics') return cdp.layout;
    if (method === 'Page.captureScreenshot') {
      if (cdp.capture) return cdp.capture(params, n);
      const s = params.clip.scale * cdp.phys;
      return { data: raw(Math.round(params.clip.width * s), Math.round(params.clip.height * s), `cap${n}`) };
    }
    if (method === 'Runtime.evaluate' && params.returnByValue && String(params.expression).includes('vpW')) {
      return { result: { value: typeof cdp.rect === 'function' ? cdp.rect(n) : cdp.rect } };
    }
    return {};
  },
});
const visibleCtl = installCaptureVisibleTab(fake, (windowId, n) => visible(windowId, n));
installDownloads(fake, (opts) => download(opts));

// ── stored data ─────────────────────────────────────────────────────────────
Object.assign(fake.data.sync, { screenshotSaveMode: 'auto', screenshotPrefix: 'cap' });

const transcript = [];
let logMark = 0, consoleMark = 0;
let lastStorage = '', lastState = '';
const { state } = await import('../bg/state.js');

function snapshot(entry) {
  entry.calls = fake.log.slice(logMark).map(showLogLine);
  entry.console = fake.consoleLog.slice(consoleMark);
  logMark = fake.log.length;
  consoleMark = fake.consoleLog.length;
  const storage = JSON.stringify(showPictures(fake.data));
  if (storage !== lastStorage) { entry.storage = JSON.parse(storage); lastStorage = storage; }
  const st = JSON.stringify({ recording: state.recording, playback: state.playback, pickMode: state.pickMode });
  if (st !== lastState) { entry.state = JSON.parse(st); lastState = st; }
  entry.zoom = { ...fake.zoom };
  entry.pendingTimers = fake.pendingTimers();
  transcript.push(JSON.parse(JSON.stringify(entry)));
}

// ── start-up ────────────────────────────────────────────────────────────────
await import('../background.js');
await fake.settle(5_000);
snapshot({
  step: 'startup',
  listeners: listenerShapes(fake, ['runtime.onMessage', 'tabs.onRemoved', 'debugger.onDetach', 'windows.onRemoved', 'alarms.onAlarm']),
});

const shot = await import('../bg/screenshot.js');
const { markSessionOpen } = await import('../bg/cdp/session.js');

function reset(setup) {
  defaults();
  debuggerCtl.reset();
  visibleCtl.reset();
  tabs.splice(0, tabs.length, ...START_TABS());
  fake.zoom[1] = 1.25;
  fake.zoom[3] = 1;
  if (setup) setup();
}

/** Call `fn` and record what it returned and everything it did. */
async function call(step, fn, { setup, budget = 300_000 } = {}) {
  reset(setup);
  const box = { done: false };
  Promise.resolve().then(fn).then((v) => { box.done = true; box.value = v; }, (e) => { box.done = true; box.error = e?.message || String(e); });
  await fake.settle(budget);
  snapshot({ step, done: box.done, result: showPictures(box.value ?? null), error: box.error });
}

const SENDER = { tab: { id: 1, windowId: 1, url: 'https://example.com/start' }, frameId: 0 };

/** Send a message to every onMessage listener, as Chrome does. */
async function send(step, request, { sender = SENDER, setup, budget = 300_000 } = {}) {
  reset(setup);
  const responses = [];
  const returned = [];
  for (const fn of [...fake.events['runtime.onMessage']]) {
    let r;
    try {
      r = fn(request, sender, (payload) => responses.push(showPictures(JSON.parse(JSON.stringify(payload ?? null)))));
    } catch (e) {
      r = `threw: ${e.message}`;
    }
    returned.push(r === undefined ? '‹undefined›' : r);
  }
  await fake.settle(budget);
  snapshot({ step, type: request?.type, returned, responses });
}

const cancelOn = (pred) => (method, params, n) => {
  if (pred(method, params, n)) {
    for (const fn of [...fake.events['runtime.onMessage']]) fn({ type: 'CANCEL_FULL_SCREENSHOT' }, SENDER, () => {});
  }
};

// ── helpers ─────────────────────────────────────────────────────────────────
await call('filenames', () => ({
  date: shot.buildDateFolder(),
  auto: shot.buildScreenshotFilename('p', null),
  tagged: shot.buildScreenshotFilename('p', '', '_full'),
  named: shot.buildScreenshotFilename('p', 'mine'),
  png: shot.buildScreenshotFilename('p', 'mine.png', '_elem'),
  // From a variable: characters Windows refuses, a backslash folder, "..", a leading "/".
  unsafe: shot.buildScreenshotFilename('p', 'order:12?"x"|y*<z>'),
  folders: shot.buildScreenshotFilename('p', '/..\\login\\step 1'),
  prefix: shot.buildScreenshotFilename('a:b', null),
}));
test('screenshot names from variables are names Windows and chrome.downloads accept', () => {
  assert.equal(shot.buildScreenshotFilename('p', 'order:12?"x"|y*<z>'), 'order_12__x__y__z_.png');
  assert.equal(shot.buildScreenshotFilename('p', '/..\\login\\step 1'), '_/login/step 1.png');
  assert.match(shot.buildScreenshotFilename('a:b', null), /^a_b_\d{4}-/);
});
await call('report result', () => {
  shot.reportCaptureResult({ success: true, filename: 'a.png' });
  shot.reportCaptureResult({ success: true, filename: 'b.png' }, { fromHotkey: true });
  shot.reportCaptureResult({ success: true }, { fromHotkey: true, label: 'Full-page screenshot' });
  shot.reportCaptureResult({ error: 'boom' }, { fromHotkey: true, label: 'Element screenshot' });
  shot.reportCaptureResult({ cancelled: true }, { fromHotkey: true });
  shot.reportCaptureResult({ cropping: true }, { fromHotkey: true });
  shot.reportCaptureResult(null, { fromHotkey: true });
});
await call('download outcomes', async () => [
  await shot.downloadDataUrl('data:,x', 'a.png', false),
  await (download = () => ({ __lastError: 'Download canceled by the user' }), shot.downloadDataUrl('data:,x', 'b.png', true)),
  await (download = () => ({ __lastError: 'Invalid filename' }), shot.downloadDataUrl('data:,x', 'c.png', false)),
  await (download = () => ({ __lastError: '' }), shot.downloadDataUrl('data:,x', 'd.png', false)),
]);

// ── visible ─────────────────────────────────────────────────────────────────
await call('visible: auto', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }));
await call('visible: ask, named', () => shot.takeVisibleScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: 'named' }));
await call('visible: crop', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: true }));
await call('visible: crop, ask', () => shot.takeVisibleScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: 'x.png', crop: true }));
await call('visible: base64, no download', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, returnBase64: true, skipDownload: true }));
await call('visible: background tab', () => shot.takeVisibleScreenshot(2, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }));
await call('visible: tab gone', () => shot.takeVisibleScreenshot(99, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }));
await call('visible: rate limited once', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { visible = (w, n) => (n === 2 ? { __lastError: 'Rate limit exceeded' } : png(800, 600, `visible${n}`)); },
});
await call('visible: quota message (no "rate" in it)', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { visible = (w, n) => (n === 2 ? { __lastError: 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.' } : png(800, 600, `visible${n}`)); },
});
await call('visible: rate limited twice', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { visible = (w, n) => (n >= 2 ? { __lastError: 'rate limit' } : png(800, 600, `visible${n}`)); },
});
await call('visible: capture refused', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { visible = () => ({ __lastError: 'Cannot access contents of the page.' }); },
});
await call('visible: save dialog cancelled', () => shot.takeVisibleScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: null }), {
  setup: () => { download = () => ({ __lastError: 'Download canceled by the user' }); },
});
await call('visible: download fails', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { download = () => ({ __lastError: 'Invalid filename' }); },
});
await call('visible: other window', () => shot.takeVisibleScreenshot(3, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }));

// ── full page ───────────────────────────────────────────────────────────────
await call('full: zoomed page, one shot', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }));
await call('full: 100 %, named, no type tag', () => shot.takeFullPageScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: 'page' }), {
  setup: () => { fake.zoom[1] = 1; fake.data.sync.screenshotTypeInName = false; },
});
delete fake.data.sync.screenshotTypeInName;
await call('full: zoom slow to settle', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    const base = chrome.tabs.getZoom;
    let polls = 0;
    chrome.tabs.getZoom = (id, cb) => base(id, (z) => cb(z === 1 && ++polls < 4 ? 1.25 : z));
    saved.restore = () => { chrome.tabs.getZoom = base; };
  },
});
saved.restore?.(); saved.restore = null;
await call('full: tall page, tiled and stitched', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    page.dims = { ...page.dims, fullHeight: 9000 };
    cdp.layout = { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 800, height: 9000 } };
  },
});
await call('full: wide and tall at dpr 1.25', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.phys = 1.25;
    page.dims = { ...page.dims, fullWidth: 5000, fullHeight: 3400, devicePixelRatio: 1.25 };
    cdp.layout = { cssVisualViewport: { clientWidth: 800.6, clientHeight: 560.4 }, cssContentSize: { width: 5000.2, height: 3400.7 } };
  },
});
await call('full: vertical scroll at dpr 2', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'vertical' }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.phys = 2;
    page.dims = { viewportWidth: 800, viewportHeight: 600, fullWidth: 1200, fullHeight: 5000, scrollX: 40, scrollY: 300, devicePixelRatio: 2 };
    cdp.layout = { visualViewport: { clientWidth: 800, clientHeight: 560 }, contentSize: { width: 1200, height: 5000 } };
  },
});
await call('full: horizontal scroll, one shot', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'horizontal' }), {
  setup: () => {
    fake.zoom[1] = 1;
    page.dims = { viewportWidth: 800, viewportHeight: 600, fullWidth: 3000, fullHeight: 900, scrollX: 100, scrollY: 50, devicePixelRatio: 1 };
    cdp.layout = { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 3000, height: 900 } };
  },
});
await call('full: layout metrics unavailable', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'full', returnBase64: true, skipDownload: true }), {
  setup: () => { fake.zoom[1] = 1; cdp.layout = { __lastError: "'Page.getLayoutMetrics' wasn't found" }; },
});
await call('full: layout metrics empty', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'vertical' }), {
  setup: () => { fake.zoom[1] = 1; cdp.layout = { cssVisualViewport: { clientWidth: 0, clientHeight: 0 } }; },
});
await call('full: segment, vertical', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'full', returnBase64: false, skipDownload: false, segmentClip: { x: 0, y: 100, width: 500, height: 300 }, segmentDir: 'vertical' }));
await call('full: segment, horizontal, tall', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: false, scrollDir: 'full', returnBase64: false, skipDownload: false, segmentClip: { x: 120, y: 0, width: 1700, height: 1300 }, segmentDir: 'horizontal' }), {
  setup: () => { cdp.phys = 1.25; },
});
await call('full: segment, element', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null, crop: true, scrollDir: 'full', returnBase64: false, skipDownload: false, segmentClip: { x: 5, y: 6, width: 70, height: 80 }, segmentDir: 'elem' }));
await call('full: crop, ask', () => shot.takeFullPageScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: null, crop: true }), { setup: () => { fake.zoom[1] = 1; } });
await call('full: save dialog cancelled', () => shot.takeFullPageScreenshot(1, { saveMode: 'ask', prefix: 'cap', requestedFilename: null }), {
  setup: () => { fake.zoom[1] = 1; download = () => ({ __lastError: 'Download canceled by the user' }); },
});
await call('full: download fails', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { fake.zoom[1] = 1; download = () => ({ __lastError: 'Invalid filename' }); },
});
await call('full: page dimensions missing', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { page.dims = { failed: true }; },
});
await call('full: no content script', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { page.dims = { __lastError: 'Could not establish connection. Receiving end does not exist.' }; },
});
await call('full: debugger will not attach', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { cdp.attachError = 'Another debugger is already attached to the tab with id: 1.'; },
});
await call('full: our session still open', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { fake.zoom[1] = 1; markSessionOpen(1); },
});
await call('full: no stale session', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { fake.zoom[1] = 1; cdp.detachError = 'Debugger is not attached to the tab with id: 1.'; },
});
await call('full: no data', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { fake.zoom[1] = 1; cdp.capture = () => ({}); },
});
await call('full: capture command fails', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { cdp.capture = () => ({ __lastError: 'Unable to capture screenshot' }); },
});
await call('full: rAF evaluate fails', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    const base = cdp;
    cdp = { ...base, onCommand: (m, p) => { cdp.dead = m === 'Runtime.evaluate' && p.awaitPromise === true && p.timeout === 5000; } };
  },
});
await call('full: ESC before the first tile', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    page.dims = { ...page.dims, fullHeight: 9000 };
    cdp.layout = { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 800, height: 9000 } };
    cdp.onCommand = cancelOn((m, p) => m === 'Runtime.evaluate' && p.expression === 'window.scrollTo(0, 0)');
  },
});
await call('full: ESC after three rows', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    page.dims = { ...page.dims, fullHeight: 9000 };
    cdp.layout = { cssVisualViewport: { clientWidth: 800, clientHeight: 560 }, cssContentSize: { width: 800, height: 9000 } };
    cdp.onCommand = cancelOn((m, p, n) => m === 'Page.captureScreenshot' && n === 3);
  },
});
await call('full: ESC before the one-shot capture', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => { cdp.onCommand = cancelOn((m) => m === 'Runtime.evaluate'); },
});
await call('full: banner Cancel (debugger detached)', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.onCommand = (m) => {
      if (m === 'Page.getLayoutMetrics' && !cdp.dead) {
        cdp.dead = true;
        for (const fn of [...fake.events['debugger.onDetach']]) fn({ tabId: 1 }, 'canceled_by_user');
      }
    };
  },
});
await call('full: target closed while capturing', () => shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.onCommand = (m) => {
      if (m === 'Page.getLayoutMetrics' && !cdp.dead) {
        cdp.dead = true;
        for (const fn of [...fake.events['debugger.onDetach']]) fn({ tabId: 1 }, 'target_closed');
      }
    };
  },
});
await call('full: detach without a tab', () => {
  for (const fn of [...fake.events['debugger.onDetach']]) fn({ extensionId: 'x' }, 'canceled_by_user');
});

// ── element ─────────────────────────────────────────────────────────────────
await call('element: zoomed page', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }));
await call('element: locators, crop', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'ask', prefix: 'cap', crop: true, returnBase64: false, skipDownload: false, selectors: { fullXpath: '/html/body/div[2]', xpath: '//*[@id="el"]', id: 'el' } }), {
  setup: () => { fake.zoom[1] = 1; },
});
await call('element: larger than the viewport', () => shot.takeElementScreenshot(1, { selector: '#big', saveMode: 'auto', prefix: 'cap', crop: false, returnBase64: true, skipDownload: true }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.phys = 1.25;
    cdp.rect = { x: 30.5, y: 2000.25, width: 1200.4, height: 1500.6, dpr: 1.25, vpW: 800, vpH: 600 };
  },
});
await call('element: re-measured after the scroll', () => shot.takeElementScreenshot(1, { selector: '#sticky', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => {
    fake.zoom[1] = 1;
    cdp.rect = (n) => (n === 1 ? { x: 0, y: 3000, width: 800, height: 60, dpr: 1, vpW: 800, vpH: 600 } : { x: 0, y: 0, width: 800, height: 60, dpr: 1, vpW: 800, vpH: 600 });
    cdp.layout = { __lastError: 'not available' };
  },
});
await call('element: in-page measure fails', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { fake.zoom[1] = 1; cdp.rect = null; },
});
await call('element: not found', () => shot.takeElementScreenshot(1, { selector: '#missing', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { page.rect = { error: 'Element not found' }; },
});
await call('element: no rect', () => shot.takeElementScreenshot(1, { selector: '#x', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { page.rect = { __lastError: 'Could not establish connection. Receiving end does not exist.' }; },
});
await call('element: page dimensions missing', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { page.dims = { failed: true }; },
});
await call('element: no tiles', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { cdp.capture = () => ({}); },
});
await call('element: debugger will not attach', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { cdp.attachError = 'Cannot attach to this target.'; page.dims = { ...page.dims, scrollX: 12, scrollY: 340 }; },
});
await call('element: our session still open', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { fake.zoom[1] = 1; markSessionOpen(1); },
});
await call('element: no stale session', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { fake.zoom[1] = 1; cdp.detachError = 'Debugger is not attached'; },
});
await call('element: save dialog cancelled', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'ask', prefix: 'cap' }), {
  setup: () => { fake.zoom[1] = 1; download = () => ({ __lastError: 'Download canceled by the user' }); },
});
await call('element: download fails', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { fake.zoom[1] = 1; download = () => ({ __lastError: 'Invalid filename' }); },
});
// A Screenshot (Element) action's Filename: used as given, no "_elem" tag.
await call('element: named', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap', requestedFilename: 'login-page' }), {
  setup: () => { fake.zoom[1] = 1; },
});

// ── queue ───────────────────────────────────────────────────────────────────
await call('queue: captures on one tab run one after another', () => Promise.all([
  shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'q1', requestedFilename: null }),
  shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'q2', requestedFilename: null }),
  shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'q3' }),
  shot.takeVisibleScreenshot(3, { saveMode: 'auto', prefix: 'other-tab', requestedFilename: null }),
]), { setup: () => { fake.zoom[1] = 1; } });
await call('queue: a failed capture does not block the next', () => Promise.all([
  shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'q1' }),
  shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'q2', requestedFilename: null }),
]), { setup: () => { fake.zoom[1] = 1; cdp.attachError = 'nope'; } });
await call('tab closed: queue and cancel marks dropped', () => {
  for (const fn of [...fake.events['runtime.onMessage']]) fn({ type: 'CANCEL_FULL_SCREENSHOT', tabId: 1 }, { url: 'chrome-extension://testextensionid/popup.html' }, () => {});
  for (const fn of [...fake.events['tabs.onRemoved']]) fn(1, { windowId: 1, isWindowClosing: false });
  return shot.takeFullPageScreenshot(1, { saveMode: 'auto', prefix: 'after-close', requestedFilename: null });
}, { setup: () => { fake.zoom[1] = 1; } });

// ── watermark ───────────────────────────────────────────────────────────────
const WM = (extra) => () => { Object.assign(fake.data.local, { watermarkEnabled: true, watermarkFormat: undefined, watermarkFontSize: undefined }, extra); };
await call('watermark: visible, default format', () => shot.takeVisibleScreenshot(1, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), { setup: WM() });
await call('watermark: long URL elided', () => shot.takeVisibleScreenshot(3, { saveMode: 'auto', prefix: 'cap', requestedFilename: null }), { setup: WM({ watermarkFontSize: 30 }) });
await call('watermark: narrow element, bar below', () => shot.takeElementScreenshot(1, { selector: '#el', saveMode: 'auto', prefix: 'cap' }), {
  setup: () => { WM({ watermarkFormat: '{url} · {datetime} · {url}' })(); fake.zoom[1] = 1; cdp.rect = { x: 0, y: 0, width: 120, height: 30, dpr: 1, vpW: 800, vpH: 600 }; },
});
await call('watermark: tiny shot, text chopped', () => shot.applyWatermark(png(40, 400, 'tiny'), 3), { setup: WM({ watermarkFontSize: 4 }) });
await call('watermark: no URL', () => shot.applyWatermark(png(400, 300, 'w'), null, ''), { setup: WM({ watermarkFormat: '{url}  {datetime}  end' }) });
await call('watermark: tab gone', () => shot.applyWatermark(png(400, 300, 'w'), 99), { setup: WM() });
await call('watermark: undecodable image', () => shot.applyWatermark('data:image/png;base64,AAAA', 1), { setup: WM() });
await call('watermark: off', () => shot.applyWatermark(png(400, 300, 'w'), 1), { setup: () => { fake.data.local.watermarkEnabled = false; } });

// ── diff ────────────────────────────────────────────────────────────────────
await call('compare screenshots', () => shot.compareScreenshots(png(4, 3, 'a'), png(5, 2, 'b'), 30));
await call('compare screenshots: identical', () => shot.compareScreenshots(png(3, 3, 'a'), png(3, 3, 'a'), 0));

// ── crop editor hand-off ────────────────────────────────────────────────────
/** The token in the editor URL of the last crop window opened. */
const lastCropToken = () => {
  const line = [...fake.log].reverse().find((l) => l.startsWith('windows.create') && l.includes('editor.html?crop='));
  return /crop=([\w-]+)/.exec(line)?.[1] ?? null;
};
await call('crop: window opens, editor reads, window closes', async () => {
  const r = await shot.openCropUI(png(10, 10, 'crop'), 'screenshots/x.png', false);
  await new Promise((res) => setTimeout(res, 10));
  const token = lastCropToken();
  const before = shot.getPendingCrop(token);
  for (const fn of [...fake.events['windows.onRemoved']]) fn(9);
  return { r, token, before, after: shot.getPendingCrop(token), none: shot.getPendingCrop(null) };
});
await call('crop: window fails to open', async () => {
  const base = chrome.windows.create;
  chrome.windows.create = (opts, cb) => base(opts, () => {
    fake.setLastError({ message: 'No current window' });
    try { cb(undefined); } finally { fake.setLastError(undefined); }
  });
  try {
    const r = await shot.openCropUI(png(10, 10, 'crop'), 'y.png', true);
    await new Promise((res) => setTimeout(res, 10));
    return { r, token: lastCropToken(), pending: shot.getPendingCrop(lastCropToken()) };
  } finally {
    chrome.windows.create = base;
  }
});

// ── messages ────────────────────────────────────────────────────────────────
await send('TAKE_SCREENSHOT', { type: 'TAKE_SCREENSHOT' });
await send('TAKE_SCREENSHOT from the popup with a tab id', { type: 'TAKE_SCREENSHOT', tabId: 3, crop: true }, { sender: { url: 'chrome-extension://testextensionid/popup.html' } });
await send('TAKE_SCREENSHOT, no tab', { type: 'TAKE_SCREENSHOT' }, { sender: {} });
await send('TAKE_SCREENSHOT, countdown drawn by the page', { type: 'TAKE_SCREENSHOT', countdown: 3 }, {
  setup: () => { page.countdown = { ok: true }; },
});
await send('TAKE_SCREENSHOT, countdown on the badge', { type: 'TAKE_SCREENSHOT', countdown: 2, crop: true });
await send('TAKE_SCREENSHOT, hotkey', { type: 'TAKE_SCREENSHOT', fromHotkey: true });
await send('TAKE_SCREENSHOT_FULL', { type: 'TAKE_SCREENSHOT_FULL', filename: 'full-name' }, { setup: () => { fake.zoom[1] = 1; } });
await send('TAKE_SCREENSHOT_SCROLL_V, hotkey', { type: 'TAKE_SCREENSHOT_SCROLL_V', fromHotkey: true }, { setup: () => { fake.zoom[1] = 1; } });
await send('TAKE_SCREENSHOT_SCROLL_H, fails', { type: 'TAKE_SCREENSHOT_SCROLL_H', fromHotkey: true }, {
  setup: () => { fake.zoom[1] = 1; cdp.attachError = 'Cannot access a chrome:// URL'; },
});
await send('TAKE_SCREENSHOT_ELEMENT, hotkey', { type: 'TAKE_SCREENSHOT_ELEMENT', selector: '#el', selectors: { css: '#el' }, fromHotkey: true }, {
  setup: () => { fake.zoom[1] = 1; Object.assign(fake.data.sync, { screenshotSaveMode: 'ask', screenshotPrefix: '' }); },
});
Object.assign(fake.data.sync, { screenshotSaveMode: 'auto', screenshotPrefix: 'cap' });
await send('CANCEL_FULL_SCREENSHOT', { type: 'CANCEL_FULL_SCREENSHOT' });
await send('unrelated message', { type: 'GET_EXTENSION_STATUS' });

// window capture
await send('OPEN_WINDOW_CAPTURE', { type: 'OPEN_WINDOW_CAPTURE', crop: false });
await send('OPEN_WINDOW_CAPTURE again: focus it', { type: 'OPEN_WINDOW_CAPTURE', crop: true });
await send('WINDOW_CAPTURE_RESULT', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: png(1280, 720, 'window'), crop: false }, {
  sender: { tab: { id: 90, windowId: 9 } },
  setup: () => {
    const base = chrome.windows.remove;
    chrome.windows.remove = (id, cb) => base(id, () => { cb?.(); for (const fn of [...fake.events['windows.onRemoved']]) fn(id); });
    saved.restore = () => { chrome.windows.remove = base; };
  },
});
saved.restore?.(); saved.restore = null;
await send('OPEN_WINDOW_CAPTURE with remembered bounds', { type: 'OPEN_WINDOW_CAPTURE', crop: true }, {
  setup: () => { fake.data.local.windowCaptureBounds = { width: 1000, height: 800, left: 10, top: 20 }; },
});
await send('WINDOW_CAPTURE_RESULT, crop, window lingers', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: png(1280, 720, 'window'), crop: true }, {
  sender: { tab: { id: 90, windowId: 9 } },
  setup: WM({ watermarkFormat: '{url}  {datetime}' }),
});
fake.data.local.watermarkEnabled = false;
await send('WINDOW_CAPTURE_RESULT, ask, cancelled, no type tag', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: png(10, 10, 'w') }, {
  sender: {},
  setup: () => {
    Object.assign(fake.data.sync, { screenshotSaveMode: 'ask', screenshotTypeInName: false });
    download = () => ({ __lastError: 'Download canceled by the user' });
  },
});
await send('WINDOW_CAPTURE_RESULT, download fails', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: png(10, 10, 'w') }, {
  sender: {},
  setup: () => { download = () => ({ __lastError: 'Invalid filename' }); },
});
Object.assign(fake.data.sync, { screenshotSaveMode: 'auto' });
delete fake.data.sync.screenshotTypeInName;
await send('OPEN_WINDOW_CAPTURE, stale window id', { type: 'OPEN_WINDOW_CAPTURE' }, {
  setup: () => {
    const base = chrome.windows.update;
    chrome.windows.update = (id, props, cb) => base(id, props, () => {
      fake.setLastError({ message: `No window with id: ${id}.` });
      try { cb?.(); } finally { fake.setLastError(undefined); }
    });
    saved.restore = () => { chrome.windows.update = base; };
  },
});
saved.restore?.(); saved.restore = null;
await send('RESTORE_BADGE while recording', { type: 'RESTORE_BADGE' }, { setup: () => { state.recording = true; } });
state.recording = false;

// the update lock
await send('locked: TAKE_SCREENSHOT_FULL', { type: 'TAKE_SCREENSHOT_FULL' }, {
  setup: () => {
    fake.data.local.remoteConfig = { hardLock: true, minVersion: '9.0.0', fetchedAt: fake.now, message: 'Update now' };
    fake.data.local.updateAvailableSince = fake.now - 60 * 86400000;
    fake.data.local.lastUpdateAt = fake.now - 60 * 86400000;
    for (const fn of fake.events['storage.onChanged']) fn({ remoteConfig: { newValue: fake.data.local.remoteConfig }, lastUpdateAt: { newValue: 1 } }, 'local');
  },
});
await send('locked: OPEN_WINDOW_CAPTURE', { type: 'OPEN_WINDOW_CAPTURE' });
await send('locked: WINDOW_CAPTURE_RESULT still saves', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: png(10, 10, 'w') }, { sender: {} });

// A web page's content script names another tab: its own is captured.
await send('TAKE_SCREENSHOT from a web page naming another tab', { type: 'TAKE_SCREENSHOT', tabId: 3 }, {
  sender: { ...SENDER, url: 'https://example.com/start' },
  setup: () => {
    delete fake.data.local.remoteConfig;
    fake.data.local.lastUpdateAt = fake.now;
    delete fake.data.local.updateAvailableSince;
    for (const fn of fake.events['storage.onChanged']) fn({ remoteConfig: { newValue: undefined }, lastUpdateAt: { newValue: fake.now } }, 'local');
  },
});
test("a web page's capture request takes its own tab, whatever tab it names", () => {
  const calls = transcript.find((e) => e.step === 'TAKE_SCREENSHOT from a web page naming another tab')?.calls || [];
  assert.ok(calls.includes('tabs.get [1]') && !calls.some((c) => c.startsWith('tabs.get [3]')), JSON.stringify(calls.slice(0, 5)));
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
  process.stdout.write(`wrote tests/golden/capture.json (${transcript.length} steps)\n`);
} else {
  const expected = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : [];
  test('capture transcript: same steps', () => {
    assert.deepStrictEqual(transcript.map((e) => e.step), expected.map((e) => e.step));
  });
  test('capture transcript', async (t) => {
    for (let i = 0; i < Math.max(transcript.length, expected.length); i++) {
      await t.test(`${i} ${transcript[i]?.step ?? expected[i]?.step}`, () => assert.deepStrictEqual(transcript[i], expected[i]));
    }
  });
}
