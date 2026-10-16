// Characterization test of the service worker's message router and alarms.
//
// background.js is loaded against tests/helpers/chrome-fake.mjs and driven
// through a fixed script: worker start-up, every message type the router knows
// (each sent to every onMessage listener, in registration order, as Chrome
// does), the update-lock guard, the alarms and onInstalled. For each step the
// transcript keeps what every listener returned, every sendResponse payload,
// every chrome.* call, console errors/warnings, and the storage areas and
// worker state when they changed. tests/golden/router.json holds the expected
// transcript; a refactor of the router must reproduce it exactly.
//
// Run:    node --test "tests/*.test.mjs"
// Update: node tests/router.test.mjs --update   (only for an intended change)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { installChromeFake } from './helpers/chrome-fake.mjs';

const GOLDEN = new URL('./golden/router.json', import.meta.url);
const UPDATE = process.argv.includes('--update');

const fake = installChromeFake();
const T0 = fake.now;

// ── stored data the worker starts with ─────────────────────────────────────
Object.assign(fake.data.local, {
  scenarios: {
    s1: { name: 'Login', actions: [{ type: 'hover', selector: '#a' }, { type: 'input', selector: '#b', value: '${user}' }], folderId: 'f1', createdAt: 1, updatedAt: 2 },
    s2: { name: 'Empty', actions: [], folderId: null, createdAt: 3 },
    s3: { name: 'Blocks', actions: [
      { type: 'switch', switchVar: '${role}', cases: [{ value: 'a', scenarioId: '__self__', startAt: 2, endAt: 2 }] },
      { type: 'hover', selector: '#x' }, { type: 'condition', conditionType: 'elementExists', selector: '#y', skipCount: 1 },
      { type: 'hover', selector: '#z' }], folderId: 'f1', createdAt: 4 },
  },
  folders: { f1: { name: 'Folder 1', createdAt: 1 } },
  variables: { user: 'alice', role: { activeType: 'p', p: ['a', 'b'] } },
  schedules: [
    { id: 'sc1', scenarioId: 's2', time: '10:30', enabled: true, repeat: true, label: 'Daily' },
    { id: 'sc2', scenarioId: 's2', time: '25:99', enabled: true },
    { id: 'sc3', scenarioId: 's1', time: '08:00', enabled: false },
    { id: 'sc4', scenarioId: 's2', time: '09:15', enabled: true, repeat: false },
  ],
  activatedTabs: [1],
  lastSelectedScenario: 's2',
  csvSessionData: { headers: ['user'], rows: [{ user: 'a' }, { user: 'b' }] },
  playbackCheckpoint: { scenarioId: 's1', actionIndex: 0, tabId: 1, timestamp: T0 - 1000 },
});
Object.assign(fake.data.sync, { screenshotSaveMode: 'auto', screenshotPrefix: 'shot' });
Object.assign(fake.data.session, {
  csv_pending: { scenarioId: 's2', currentRow: 1, delayBetween: 500, exportFormat: 'csv', timestamp: T0 - 1000 },
});

const transcript = [];
let logMark = 0, consoleMark = 0;
let lastStorage = '', lastState = '';
const { state } = await import('../bg/state.js');

function snapshot(entry) {
  entry.calls = fake.log.slice(logMark);
  entry.console = fake.consoleLog.slice(consoleMark);
  logMark = fake.log.length;
  consoleMark = fake.consoleLog.length;
  const storage = JSON.stringify(fake.data);
  if (storage !== lastStorage) { entry.storage = JSON.parse(storage); lastStorage = storage; }
  const st = JSON.stringify(state);
  if (st !== lastState) { entry.state = JSON.parse(st); lastState = st; }
  transcript.push(entry);
}

// ── start-up ────────────────────────────────────────────────────────────────
await import('../background.js');
await fake.settle(5_000);
snapshot({ step: 'startup', onMessageListeners: fake.events['runtime.onMessage'].length });

// The popup's messages and the content script's share this sender (tab 1), so the
// handlers that fall back on sender.tab see a tab; its url is an extension page,
// which the router does not hold to the content-script messages.
const SENDER = { tab: { id: 1, url: 'https://example.com/page' }, url: 'chrome-extension://testextensionid/popup.html', frameId: 0 };

async function send(label, request, { sender = SENDER, setup } = {}) {
  if (setup) setup();
  const responses = [];
  const returned = [];
  for (const fn of [...fake.events['runtime.onMessage']]) {
    let r;
    try {
      r = fn(request, sender, (payload) => responses.push(JSON.parse(JSON.stringify(payload ?? null))));
    } catch (e) {
      r = `threw: ${e.message}`;
    }
    returned.push(r === undefined ? '‹undefined›' : r);
  }
  await fake.settle();
  snapshot({ step: label, type: request?.type, returned, responses });
}

async function alarm(name) {
  for (const fn of [...fake.events['alarms.onAlarm']]) fn({ name, scheduledTime: fake.now });
  await fake.settle();
  snapshot({ step: `alarm ${name}` });
}

// ── messages ────────────────────────────────────────────────────────────────
await send('status', { type: 'GET_EXTENSION_STATUS' });
await send('register frame', { type: 'REGISTER_FRAME' }, { sender: { tab: { id: 1 }, frameId: 3 } });
await send('content ready (offer resume)', { type: 'CONTENT_READY' });
await send('content ready (other tab)', { type: 'CONTENT_READY' }, { sender: { tab: { id: 2 } } });
await send('dismiss resume', { type: 'DISMISS_RESUME' });
await send('unknown type', { type: 'NO_SUCH_MESSAGE' });
await send('prototype key', { type: 'toString' });
await send('dbtools manager (new tab)', { type: 'dbtools-open-manager', sessionId: 'abc', changeId: 'c1' });
await send('screenshot passthrough', { type: 'RESTORE_BADGE' });

// recording + editing the current buffer
await send('start record', { type: 'START_RECORD', scenarioId: 's1', tabId: 1 });
await send('recorded action', { type: 'RECORDED_ACTION', action: { type: 'hover', selector: '#r1' } });
await send('recorded action 2', { type: 'RECORDED_ACTION', action: { type: 'input', selector: '#r2', value: 'v', delay: 0 } });
await send('playback refused while recording', { type: 'START_PLAYBACK_SCENARIO', scenarioId: 's1' });
await send('preview current', { type: 'GET_PREVIEW_ACTIONS' });
await send('undo state', { type: 'GET_UNDO_REDO_STATE' });
await send('undo current', { type: 'UNDO_ACTION' });
await send('redo current', { type: 'REDO_ACTION' });
await send('add manual (bad)', { type: 'ADD_MANUAL_ACTION', action: null });
await send('add manual', { type: 'ADD_MANUAL_ACTION', action: { type: 'wait', value: '100' } });
await send('update action', { type: 'UPDATE_ACTION', index: 0, action: { type: 'hover', selector: '#r1b' } });
await send('update action (bad index)', { type: 'UPDATE_ACTION', index: 9, action: {} });
await send('toggle disabled', { type: 'TOGGLE_ACTION_DISABLED', index: 1 });
await send('toggle disabled (bad)', { type: 'TOGGLE_ACTION_DISABLED', index: -1 });
await send('reorder', { type: 'REORDER_ACTIONS', newOrder: [2, 0, 1] });
await send('reorder (bad)', { type: 'REORDER_ACTIONS', newOrder: [0, 0, 1] });
await send('remove action', { type: 'REMOVE_ACTION', index: 2 });
await send('remove action (bad)', { type: 'REMOVE_ACTION', index: 5 });
await send('pick mode on', { type: 'START_PICK_MODE', tabId: 1 });
await send('recorded during pick', { type: 'RECORDED_ACTION', action: { type: 'hover' } });
await send('pick mode off', { type: 'STOP_PICK_MODE' });
await send('stop record (into s1)', { type: 'STOP_RECORD' });
await send('recorded after stop', { type: 'RECORDED_ACTION', action: { type: 'hover' } });
await send('start record (hotkey)', { type: 'START_RECORD' });
await send('stop record (s2)', { type: 'STOP_RECORD' });
await send('start record (no scenario)', { type: 'START_RECORD', tabId: 1, scenarioId: null }, {
  setup: () => { delete fake.data.local.lastSelectedScenario; },
});
await send('recorded (no scenario)', { type: 'RECORDED_ACTION', action: { type: 'hover', selector: '#n' } });
await send('stop record (no scenario)', { type: 'STOP_RECORD' });

// stored scenario editing
await send('preview s1', { type: 'GET_PREVIEW_ACTIONS', scenarioId: 's1' });
await send('undo s1', { type: 'UNDO_ACTION', scenarioId: 's1' });
await send('redo s1', { type: 'REDO_ACTION', scenarioId: 's1' });
await send('undo s3 (empty stack)', { type: 'UNDO_ACTION', scenarioId: 's3' });
await send('add manual s1', { type: 'ADD_MANUAL_ACTION', scenarioId: 's1', action: { type: 'wait', value: '5' } });
await send('update s1', { type: 'UPDATE_ACTION', scenarioId: 's1', index: 0, action: { type: 'hover', selector: '#u' } });
await send('update s1 (bad)', { type: 'UPDATE_ACTION', scenarioId: 's1', index: 99, action: {} });
await send('remove s3 (in block)', { type: 'REMOVE_ACTION', scenarioId: 's3', index: 1 });
await send('toggle s3 switch', { type: 'TOGGLE_ACTION_DISABLED', scenarioId: 's3', index: 0 });
await send('toggle s3 (bad)', { type: 'TOGGLE_ACTION_DISABLED', scenarioId: 's3', index: 50 });
await send('reorder s3 with move', { type: 'REORDER_ACTIONS', scenarioId: 's3', newOrder: [0, 2, 1], move: { items: [2], target: null } });
await send('reorder s3 (bad)', { type: 'REORDER_ACTIONS', scenarioId: 's3', newOrder: [0] });

// scenario CRUD
await send('get scenarios', { type: 'GET_SCENARIOS' });
await send('save scenario', { type: 'SAVE_SCENARIO', name: 'Saved', folderId: 'f1' });
await send('create scenario (no name)', { type: 'CREATE_SCENARIO', name: '  ' });
await send('create scenario', { type: 'CREATE_SCENARIO', name: ' New one ', folderId: null });
await send('start new scenario', { type: 'START_NEW_SCENARIO' });
await send('rename', { type: 'RENAME_SCENARIO', scenarioId: 's2', newName: 'Renamed' });
await send('rename missing', { type: 'RENAME_SCENARIO', scenarioId: 'zz', newName: 'x' });
await send('duplicate', { type: 'DUPLICATE_SCENARIO', scenarioId: 's1' });
await send('duplicate missing', { type: 'DUPLICATE_SCENARIO', scenarioId: 'zz' });
await send('move to folder', { type: 'MOVE_TO_FOLDER', scenarioId: 's2', folderId: 'f1' });
await send('export scenario', { type: 'EXPORT_SCENARIO', scenarioId: 's1' });
await send('import scenario (bad)', { type: 'IMPORT_SCENARIO', scenario: { name: 'x' } });
await send('import scenario', { type: 'IMPORT_SCENARIO', scenario: { name: 'Imp', folderId: 'other', actions: [{ type: 'script', code: '1' }] } });
await send('import folder (bad)', { type: 'IMPORT_FOLDER', folder: { name: 'F', scenarios: { a: {} } } });
await send('import folder', { type: 'IMPORT_FOLDER', folder: { name: 'Imported', scenarios: {
  old1: { name: 'A', actions: [{ type: 'switch', cases: [{ value: 'x', scenarioId: 'old2' }, { value: 'y', scenarioId: 'elsewhere' }] }] },
  old2: { name: 'B', folderId: 'old', actions: [] },
  bad: { name: 'C' },
} } });
await send('save sequence as scenario', { type: 'SAVE_SEQUENCE_AS_SCENARIO', name: 'Seq', runList: [{ id: 's1', delay: 200 }, { id: 'zz', delay: 0 }, { id: 's3', delay: 300 }] });
await send('delete scenario', { type: 'DELETE_SCENARIO', scenarioId: 's2' });

// folders
await send('get folders', { type: 'GET_FOLDERS' });
await send('create folder', { type: 'CREATE_FOLDER', name: 'F2' });
await send('rename folder', { type: 'RENAME_FOLDER', folderId: 'f1', name: 'Folder One' });
await send('export folder', { type: 'EXPORT_FOLDER', folderId: 'f1' });
await send('export folder missing', { type: 'EXPORT_FOLDER', folderId: 'zz' });
await send('delete folder', { type: 'DELETE_FOLDER', folderId: 'f1' });

// variables, schedules, activation, data
await send('get variables', { type: 'GET_VARIABLES' });
await send('save variables', { type: 'SAVE_VARIABLES', variables: { user: 'bob', n: '1' }, order: ['n', 'user'] });
await send('get schedules', { type: 'GET_SCHEDULES' });
await send('save schedule (new)', { type: 'SAVE_SCHEDULE', schedule: { id: 'sc9', scenarioId: 's1', time: '23:59', enabled: true, repeat: false } });
await send('save schedule (bad time)', { type: 'SAVE_SCHEDULE', schedule: { id: 'sc1', scenarioId: 's1', time: '7', enabled: true } });
await send('save schedule (disabled)', { type: 'SAVE_SCHEDULE', schedule: { id: 'sc3', scenarioId: 's1', time: '08:00', enabled: false } });
await send('delete schedule', { type: 'DELETE_SCHEDULE', id: 'sc9' });
await send('tab activated', { type: 'IS_TAB_ACTIVATED' });
await send('tab not activated', { type: 'IS_TAB_ACTIVATED' }, { sender: { tab: { id: 2 } } });
await send('get all data', { type: 'GET_ALL_DATA' });
await send('restore (bad)', { type: 'RESTORE_ALL_DATA', data: [] });
await send('restore (bad scenarios)', { type: 'RESTORE_ALL_DATA', data: { scenarios: [] } });
await send('restore (bad folders)', { type: 'RESTORE_ALL_DATA', data: { folders: 'x' } });
await send('restore (bad schedules)', { type: 'RESTORE_ALL_DATA', data: { schedules: {} } });
await send('restore', { type: 'RESTORE_ALL_DATA', data: {
  scenarios: { r1: { name: 'Restored', actions: [] } }, activatedTabs: [5], hl_v1: { a: 1 }, __sync: { screenshotPrefix: 'rest' },
} });

// playback
await send('play s1', { type: 'START_PLAYBACK_SCENARIO', scenarioId: 's1', loopCount: 2, loopDelay: 10 });
await send('stop playback', { type: 'STOP_PLAYBACK' });
await send('play sequence', { type: 'START_SEQUENCE_PLAYBACK', runList: [{ id: 'r1', delay: 0 }] });
await send('stop sequence', { type: 'STOP_SEQUENCE_PLAYBACK' });
await send('resume playback', { type: 'RESUME_PLAYBACK', scenarioId: 'r1', actionIndex: 0, tabId: 1 });
await send('csv status', { type: 'GET_CSV_STATUS' });
await send('csv start', { type: 'START_CSV_PLAYBACK', scenarioId: 'r1', rows: [{ user: 'a' }], delayBetween: 0 });
await send('csv stop after row (idle)', { type: 'STOP_CSV_AFTER_ROW' });
await send('csv stop', { type: 'STOP_CSV_PLAYBACK' });
await send('csv resume (none)', { type: 'RESUME_CSV_PLAYBACK' });
await send('csv resume', { type: 'RESUME_CSV_PLAYBACK' }, {
  setup: () => {
    fake.data.session.csv_pending = { scenarioId: 'r1', currentRow: 0, delayBetween: 0, exportFormat: 'csv', timestamp: fake.now };
    fake.data.local.csvSessionData = { headers: ['user'], rows: [{ user: 'z' }] };
  },
});
await send('csv dismiss resume', { type: 'DISMISS_CSV_RESUME' });
await send('csv results', { type: 'GET_CSV_RUN_RESULTS' });
await send('csv screenshots', { type: 'GET_CSV_SCREENSHOTS' });
await send('csv clear screenshots', { type: 'CLEAR_CSV_SCREENSHOTS' });
await send('csv clear results', { type: 'CLEAR_CSV_RESULTS' });

// capture-related messages
await send('open image editor (file)', { type: 'OPEN_IMAGE_EDITOR', dataUrl: 'data:image/png;base64,AA==', sourceFileName: 'pic.jpg' });
await send('open image editor (paste)', { type: 'OPEN_IMAGE_EDITOR', dataUrl: 'data:image/png;base64,AA==' });
await send('pending crop', { type: 'GET_PENDING_CROP', token: 'nope' });
await send('save cropped', { type: 'SAVE_CROPPED', dataUrl: 'data:image/png;base64,AA==', downloadPath: 'x.png', saveAs: false });
await send('element picked (popup)', { type: 'ELEMENT_PICKED', selector: '#p' });
await send('element picked (no selector)', { type: 'ELEMENT_PICKED' }, {
  setup: () => { fake.data.local.elemShotPickPending = true; },
});
await send('compare screenshots', { type: 'COMPARE_SCREENSHOTS', dataUrlA: 'data:,', dataUrlB: 'data:,' });
await send('element picked (screenshot)', { type: 'ELEMENT_PICKED', selector: '#shot', selectors: { css: '#shot' } }, {
  setup: () => { fake.data.local.elemShotPickPending = true; fake.data.local.elemShotPickCrop = false; },
});
await send('element screenshot message', { type: 'TAKE_SCREENSHOT_ELEMENT', selector: '#el', crop: false });
await send('segment start for capture', { type: 'START_SEGMENT_CAPTURE', tabId: 1, dir: 'v', crop: false });
await send('capture segment', { type: 'CAPTURE_SEGMENT', yStart: 0, yEnd: 500, xStart: 0, xEnd: 300 });
await send('hotkey element shot', { type: 'HOTKEY_SCREENSHOT_ELEMENT' });
await send('hotkey element shot (no tab)', { type: 'HOTKEY_SCREENSHOT_ELEMENT' }, { sender: {} });
await send('hotkey segment start', { type: 'HOTKEY_SEG_START', dir: 'v' });
await send('hotkey segment start (no tab)', { type: 'HOTKEY_SEG_START', dir: 'v' }, { sender: {} });
await send('cancel segment', { type: 'CANCEL_SEGMENT_CAPTURE' });
await send('segment start (popup, 100%)', { type: 'START_SEGMENT_CAPTURE', tabId: 2, dir: 'h', crop: 1 });
await send('cancel segment again', { type: 'CANCEL_SEGMENT_CAPTURE' });

// update
await send('check for update', { type: 'CHECK_FOR_UPDATE' });
await send('apply update', { type: 'APPLY_UPDATE' });

// the update lock refuses starts but not reads
await send('locked: start record', { type: 'START_RECORD', scenarioId: 's1' }, {
  setup: () => {
    fake.data.local.remoteConfig = { hardLock: true, minVersion: '9.0.0', fetchedAt: fake.now, message: 'Update now' };
    fake.data.local.updateAvailableSince = fake.now - 60 * 86400000;
    fake.data.local.lastUpdateAt = fake.now - 60 * 86400000;
    for (const fn of fake.events['storage.onChanged']) fn({ remoteConfig: { newValue: fake.data.local.remoteConfig }, lastUpdateAt: { newValue: 1 } }, 'local');
  },
});
await send('locked: status still answers', { type: 'GET_EXTENSION_STATUS' });
await send('locked: compare screenshots', { type: 'COMPARE_SCREENSHOTS', dataUrlA: 'a', dataUrlB: 'b' });
await send('unlocked: segment start', { type: 'START_SEGMENT_CAPTURE', tabId: 1, dir: 'v', crop: false }, {
  setup: () => {
    delete fake.data.local.remoteConfig;
    delete fake.data.local.updateAvailableSince;
    delete fake.data.local.lastUpdateAt;
    for (const fn of fake.events['storage.onChanged']) fn({ remoteConfig: { oldValue: {} } }, 'local');
  },
});
await send('cancel segment (restore zoom)', { type: 'CANCEL_SEGMENT_CAPTURE' });

// alarms and install
await alarm('playback-keepalive');
await alarm('updateCheckDaily');
await alarm('updateAutoApply');
await alarm('sched_sc1');
await alarm('sched_sc4');
await alarm('sched_sc3');
await alarm('sched_missing');
await alarm('unrelated');
for (const reason of ['install', 'update', 'chrome_update']) {
  for (const fn of [...fake.events['runtime.onInstalled']]) fn({ reason });
  await fake.settle();
  snapshot({ step: `onInstalled ${reason}` });
}

/** Send every request before any of them settles, as the popup does for a file of several scenarios. */
async function sendAtOnce(label, requests) {
  const responses = [];
  for (const request of requests) {
    for (const fn of [...fake.events['runtime.onMessage']]) {
      fn(request, SENDER, (payload) => responses.push(JSON.parse(JSON.stringify(payload ?? null))));
    }
  }
  await fake.settle();
  snapshot({ step: label, types: requests.map((r) => r.type), responses });
}

// Last, so the scenarios it adds do not show up in the storage of every step above.
const ARRAY_IMPORT = ['Array A', 'Array B', 'Array C'];
await sendAtOnce('import 3 scenarios at once', ARRAY_IMPORT.map((name) => ({ type: 'IMPORT_SCENARIO', scenario: { name, actions: [] } })));
const savedNames = Object.values(fake.data.local.scenarios || {}).map((s) => s.name);
// Two handlers editing one scenario at once (scenarios.js and mutateScenarioActions).
const arrayAId = Object.keys(fake.data.local.scenarios).find((id) => fake.data.local.scenarios[id].name === 'Array A');
await sendAtOnce('rename and add an action at once', [
  { type: 'RENAME_SCENARIO', scenarioId: arrayAId, newName: 'Array A renamed' },
  { type: 'ADD_MANUAL_ACTION', scenarioId: arrayAId, action: { type: 'click', selector: '#both' } },
]);
const arrayA = fake.data.local.scenarios[arrayAId];

// A web page's content script may only send what content.js and dbtools send.
const PAGE_SENDER = { tab: { id: 1, url: 'https://example.com/page' }, url: 'https://example.com/page', frameId: 0 };
const storageBefore = JSON.stringify(fake.data);
await send('from a web page: GET_ALL_DATA refused', { type: 'GET_ALL_DATA' }, { sender: PAGE_SENDER });
await send('from a web page: IMPORT_SCENARIO refused', { type: 'IMPORT_SCENARIO', scenario: { name: 'Page', actions: [{ type: 'script', code: '1' }] } }, { sender: PAGE_SENDER });
await send('from a web page: RESTORE_ALL_DATA refused', { type: 'RESTORE_ALL_DATA', data: { scenarios: {} } }, { sender: PAGE_SENDER });
const storageAfterRefused = JSON.stringify(fake.data);
await send('from a web page: REGISTER_FRAME answered', { type: 'REGISTER_FRAME' }, { sender: PAGE_SENDER });
const _stepOf = (step) => transcript.find((e) => e.step === step);

// Two pages save their highlights at once (one from a web page's content
// script), and a second tab on the first page makes one at the same moment:
// all three are kept. Whole lists were sent before, and one of the two tabs on
// the same page lost its highlight.
const PAGE_SENDER_TAB2 = { ...PAGE_SENDER, tab: { ...PAGE_SENDER.tab, id: 2 } };
{
  const responses = [];
  const saves = [
    [{ type: 'HL_EDIT', url: 'https://example.com/page', ops: [{ op: 'add', item: { id: 'h1', text: 'alpha' } }] }, PAGE_SENDER],
    [{ type: 'HL_EDIT', url: 'example.com/b', ops: [{ op: 'add', item: { id: 'h2', text: 'beta' } }] }, SENDER],
    [{ type: 'HL_EDIT', url: 'https://example.com/page', ops: [{ op: 'add', item: { id: 'h1b', text: 'gamma' } }] }, PAGE_SENDER_TAB2],
  ];
  for (const [request, sender] of saves) {
    for (const fn of [...fake.events['runtime.onMessage']]) fn(request, sender, (p) => responses.push(p));
  }
  await fake.settle();
  snapshot({ step: 'two pages save highlights at once', responses });
}
const savedHighlights = fake.data.local.hl_v1 || {};

// A schedule with a start URL runs in a new tab on it, not on the active tab.
fake.data.local.schedules = [...fake.data.local.schedules, { id: 'scUrl', scenarioId: 's2', time: '08:00', enabled: true, repeat: true, url: 'https://example.com/start' }];
await alarm('sched_scUrl');

// The highlight engine is injected into the frame that asks for it (content.js
// does while highlighting is on); with no tab there is nothing to inject into.
await send('highlight engine: HL_LOAD from a frame', { type: 'HL_LOAD' }, { sender: { ...PAGE_SENDER, frameId: 4 } });
await send('highlight engine: HL_LOAD with no tab', { type: 'HL_LOAD' }, { sender: {} });

// A recording takes actions from the tab it was started on only: another tab's
// frames are told not to record, and what they send anyway is dropped.
const OTHER_TAB_SENDER = { tab: { id: 2, url: 'https://example.com/other' }, url: 'https://example.com/other', frameId: 0 };
await send('record on tab 1', { type: 'START_RECORD', scenarioId: 's2', tabId: 1 }, {
  setup: () => { state.pickMode = false; }, // left on by an earlier step; it drops every action too
});
await send('other tab: register frame while recording', { type: 'REGISTER_FRAME' }, { sender: OTHER_TAB_SENDER });
await send('other tab: recorded action dropped', { type: 'RECORDED_ACTION', action: { type: 'input', selector: '#pw', value: 'secret' } }, { sender: OTHER_TAB_SENDER });
await send('recording tab: recorded action kept', { type: 'RECORDED_ACTION', action: { type: 'click', selector: '#go' } }, { sender: PAGE_SENDER });
await send('stop record (tab 1 only)', { type: 'STOP_RECORD' });

// From a web page, a recorded action is a click or an input with the fields
// content.js records; anything else could be run by the next Play.
await send('record on tab 1 (page actions)', { type: 'START_RECORD', scenarioId: 's2', tabId: 1 });
await send('from a web page: recorded uploadFile dropped', { type: 'RECORDED_ACTION', action: { type: 'uploadFile', selector: '#f', folderPath: 'C:\\Users\\me\\.ssh', fileNames: ['id_rsa'] } }, { sender: PAGE_SENDER });
await send('from a web page: recorded script dropped', { type: 'RECORDED_ACTION', action: { type: 'script', code: 'alert(1)' } }, { sender: PAGE_SENDER });
await send('from a web page: recorded click keeps its known fields', { type: 'RECORDED_ACTION', action: {
  type: 'click', selector: '#ok', selectors: { css: '#ok', text: 'OK', textTag: 'button', onclick: 'x' }, code: 'alert(1)', frameId: 9,
} }, { sender: { ...PAGE_SENDER, frameId: 3 } });
await send('stop record (page actions)', { type: 'STOP_RECORD' });

// An import says what it holds that reaches beyond the page: Run JS, and the
// local folders Upload File actions hand files from (each named once).
await send('import scenario with uploadFile', { type: 'IMPORT_SCENARIO', scenario: { name: 'Up', actions: [
  { type: 'uploadFile', selector: '#f', folderPath: 'C:\\Users\\me\\.ssh', fileNames: ['id_rsa'] },
  { type: 'uploadFile', selector: '#g', folderPath: 'C:\\Users\\me\\.ssh', fileName: 'known_hosts' },
  { type: 'script', code: '1' },
] } });
await send('import folder with uploadFile', { type: 'IMPORT_FOLDER', folder: { name: 'Uploads', scenarios: {
  a: { name: 'A', actions: [{ type: 'uploadFile', selector: '#f', folderPath: 'D:\\data', fileNames: ['a.csv'] }] },
  b: { name: 'B', actions: [{ type: 'uploadFile', selector: '#f', folderPath: ' E:\\x ', fileNames: ['b'] }, { type: 'click', selector: '#c' }] },
} } });

// A scenario's own "Click through": only the scenario is written, never its
// actions; a web page cannot change it; Duplicate keeps it.
const CT_ACTIONS = [{ type: 'click', selector: '#a', clickThrough: false }, { type: 'click', selector: '#b' }];
await send('click through: scenario off', { type: 'SET_SCENARIO_CLICK_THROUGH', scenarioId: 'sCt', allowed: false }, {
  setup: () => { fake.data.local.scenarios.sCt = { name: 'Ct', actions: JSON.parse(JSON.stringify(CT_ACTIONS)) }; },
});
const ctOff = JSON.parse(JSON.stringify(fake.data.local.scenarios.sCt));
await send('click through: duplicate keeps it', { type: 'DUPLICATE_SCENARIO', scenarioId: 'sCt' });
const ctCopyId = _stepOf('click through: duplicate keeps it')?.responses?.[0]?.id;
await send('click through: from a web page refused', { type: 'SET_SCENARIO_CLICK_THROUGH', scenarioId: 'sCt', allowed: true }, { sender: PAGE_SENDER });
await send('click through: scenario back on', { type: 'SET_SCENARIO_CLICK_THROUGH', scenarioId: 'sCt', allowed: true });
const ctOn = JSON.parse(JSON.stringify(fake.data.local.scenarios.sCt));
await send('click through: unknown scenario', { type: 'SET_SCENARIO_CLICK_THROUGH', scenarioId: 'zz', allowed: false });

// Schedules are read, changed and written back too: saved at once they all
// stay, a one-shot alarm that fires while another is saved keeps both changes,
// and a restore arms the schedules it brings back.
await sendAtOnce('schedules: three saved at once', ['scA', 'scB', 'scC'].map((id) => (
  { type: 'SAVE_SCHEDULE', schedule: { id, scenarioId: 's1', time: '06:00', enabled: true, repeat: true } })));
const schedulesSavedAtOnce = (fake.data.local.schedules || []).map((s) => s.id);
{
  fake.data.local.schedules = [...(fake.data.local.schedules || []), { id: 'scOnce', scenarioId: 's1', time: '07:00', enabled: true, repeat: false }];
  const responses = [];
  for (const fn of [...fake.events['alarms.onAlarm']]) fn({ name: 'sched_scOnce', scheduledTime: fake.now });
  for (const fn of [...fake.events['runtime.onMessage']]) {
    fn({ type: 'SAVE_SCHEDULE', schedule: { id: 'scNew', scenarioId: 's1', time: '09:00', enabled: true } }, SENDER, (p) => responses.push(p));
  }
  await fake.settle();
  snapshot({ step: 'schedules: a one-shot alarm and a save at once', responses });
}
const schedulesAfterAlarm = JSON.parse(JSON.stringify(fake.data.local.schedules));
await send('schedules: a restore arms them', { type: 'RESTORE_ALL_DATA', data: {
  schedules: [{ id: 'scRestored', scenarioId: 's1', time: '05:30', enabled: true, repeat: true }],
} });

// From a web page, HL_EDIT changes the page's own highlights only: its own
// URL (fragment dropped unless it is a route), or a pattern the user grouped
// pages under — not another page's.
fake.data.local.hl_v1 = { ...fake.data.local.hl_v1, 'https://bank.example/': [{ id: 'b1', text: 'balance' }] };
await send('highlights: a web page edits another page', { type: 'HL_EDIT', url: 'https://bank.example/', ops: [{ op: 'clear' }] }, { sender: PAGE_SENDER });
const bankAfterPageEdit = JSON.parse(JSON.stringify(fake.data.local.hl_v1['https://bank.example/']));
await send('highlights: a web page saves its own, fragment dropped', { type: 'HL_EDIT', url: 'https://example.com/page', ops: [{ op: 'add', item: { id: 'h3', text: 'own' } }] }, {
  sender: { ...PAGE_SENDER, url: 'https://example.com/page#section-2' },
});
await send('highlights: a web page saves under a pattern', { type: 'HL_EDIT', url: 'example.com/*', ops: [{ op: 'add', item: { id: 'h4', text: 'grouped' } }] }, {
  sender: PAGE_SENDER, setup: () => { fake.data.local.hl_patterns_v1 = ['example.com/*']; },
});
// An edit HL_EDIT does not know, or a field a `set` may not change, is refused
// whole: nothing of the message is written.
const hlBeforeBadEdits = JSON.stringify(fake.data.local.hl_v1);
await send('highlights: an unknown edit', { type: 'HL_EDIT', url: 'https://example.com/page', ops: [{ op: 'add', item: { id: 'h5', text: 'x' } }, { op: 'replace', list: [] }] }, { sender: PAGE_SENDER });
await send('highlights: a set of the text', { type: 'HL_EDIT', url: 'https://example.com/page', ops: [{ op: 'set', id: 'h3', fields: { text: 'changed' } }] }, { sender: PAGE_SENDER });
await send('highlights: no edits', { type: 'HL_EDIT', url: 'https://example.com/page', ops: [] }, { sender: PAGE_SENDER });
const hlAfterBadEdits = JSON.stringify(fake.data.local.hl_v1);
// Removing a page's last highlight drops the page from the store.
await send('highlights: add one', { type: 'HL_EDIT', url: 'https://example.com/gone', ops: [{ op: 'add', item: { id: 'g1', text: 'gone' } }] });
await send('highlights: remove the last one', { type: 'HL_EDIT', url: 'https://example.com/gone', ops: [{ op: 'remove', id: 'g1' }] });
const goneAfterRemove = 'https://example.com/gone' in fake.data.local.hl_v1;
// The popup changes a highlight's colour while the page makes another one: both
// stay. The popup used to write back the whole store it had loaded.
fake.data.local.hl_patterns_v1 = [];
fake.data.local.hl_v1 = { 'https://example.com/pop': [{ id: 'p1', text: 'one', color: 'yellow', srcUrl: 'https://example.com/pop' }] };
{
  const POP_PAGE = { ...PAGE_SENDER, tab: { ...PAGE_SENDER.tab, url: 'https://example.com/pop' }, url: 'https://example.com/pop' };
  const responses = [];
  for (const [request, sender] of [
    [{ type: 'HL_EDIT', url: 'https://example.com/pop', ops: [{ op: 'set', id: 'p1', fields: { color: 'green' } }] }, SENDER],
    [{ type: 'HL_EDIT', url: 'https://example.com/pop', ops: [{ op: 'add', item: { id: 'p2', text: 'two', srcUrl: 'https://example.com/pop' } }] }, POP_PAGE],
  ]) {
    for (const fn of [...fake.events['runtime.onMessage']]) fn(request, sender, (p) => responses.push(p));
  }
  await fake.settle();
  snapshot({ step: 'highlights: the popup edits while the page saves', responses });
}
const hlAfterPopupEdit = JSON.parse(JSON.stringify(fake.data.local.hl_v1));
// New patterns re-group the store in the same write; a web page may not ask.
await send('highlights: a web page re-groups', { type: 'HL_REGROUP', patterns: ['example.com/*'] }, { sender: PAGE_SENDER });
const hlAfterPageRegroup = JSON.stringify(fake.data.local);
await send('highlights: the popup re-groups', { type: 'HL_REGROUP', patterns: ['example.com/*'] });
const hlAfterRegroup = JSON.parse(JSON.stringify({ hl: fake.data.local.hl_v1, patterns: fake.data.local.hl_patterns_v1 }));

// With the document Chrome says sent it, the engine goes into that document.
await send('highlight engine: HL_LOAD from a document', { type: 'HL_LOAD' }, { sender: { ...PAGE_SENDER, frameId: 4, documentId: 'doc-4' } });

// A web page drives neither another tab's recording nor the scenario it writes to,
// and Stop from a page returns no actions. The page is on tab 1; it names tab 2
// (where a password is typed) and a scenario to append to. The recording stays on
// tab 1, tab 2's input is dropped, and Stop comes back with a bare ack. Last, so
// its recording state does not show up in the steps above.
await send('page: start record names another tab', { type: 'START_RECORD', tabId: 2, scenarioId: 's1' }, {
  sender: PAGE_SENDER,
  setup: () => { state.pickMode = false; fake.data.local.lastSelectedScenario = null; },
});
await send('page: another tab types a password', { type: 'RECORDED_ACTION', action: { type: 'input', selector: '#pw', value: 'hunter2' } }, { sender: OTHER_TAB_SENDER });
await send('page: its own tab is recorded', { type: 'RECORDED_ACTION', action: { type: 'input', selector: '#q', value: 'typed' } }, { sender: PAGE_SENDER });
await send('page: stop record returns no actions', { type: 'STOP_RECORD' }, { sender: PAGE_SENDER });
await send('page: stop pick mode names another tab', { type: 'STOP_PICK_MODE', tabId: 2 }, { sender: PAGE_SENDER });

// The window-capture listener closes a browser window and writes a data: URL to
// disk; only the capture page (an extension page) drives it. A web page naming a
// window id is refused: no window closed, nothing downloaded, no response.
await send('page: window capture result refused', { type: 'WINDOW_CAPTURE_RESULT', dataUrl: 'data:image/png;base64,AA==', crop: false }, {
  sender: { ...PAGE_SENDER, tab: { ...PAGE_SENDER.tab, windowId: 7 } },
});

// ── compare ─────────────────────────────────────────────────────────────────
const actual = JSON.parse(JSON.stringify(transcript));

function stringify(v, depth = 3, pad = '') {
  if (depth === 0 || v === null || typeof v !== 'object' || !Object.keys(v).length) return JSON.stringify(v);
  const inner = pad + ' ';
  if (Array.isArray(v)) return '[\n' + v.map((x) => inner + stringify(x, depth - 1, inner)).join(',\n') + '\n' + pad + ']';
  return '{\n' + Object.keys(v).map((k) => inner + JSON.stringify(k) + ': ' + stringify(v[k], depth - 1, inner)).join(',\n') + '\n' + pad + '}';
}


test('a recording takes actions from its own tab only', () => {
  assert.deepEqual(_stepOf('other tab: register frame while recording')?.responses?.[0]?.recording, false);
  assert.deepEqual(_stepOf('other tab: recorded action dropped')?.responses, [{ received: false }]);
  assert.deepEqual(_stepOf('recording tab: recorded action kept')?.responses, [{ received: true }]);
  const started = _stepOf('record on tab 1')?.calls.filter((c) => c.startsWith('tabs.sendMessage'));
  assert.deepEqual(started, [
    'tabs.sendMessage [1,{"type":"RECORDING_STATE","recording":true}]',
    'tabs.sendMessage [2,{"type":"RECORDING_STATE","recording":false}]',
  ]);
  const recorded = _stepOf('stop record (tab 1 only)')?.responses?.[0]?.actions;
  assert.deepEqual(recorded?.map((a) => a.selector), ['#go']);
});
test('a web page cannot record another tab or read what was recorded', () => {
  // The recording is on the page's own tab: the named tab 2 is told not to record.
  const broadcast = _stepOf('page: start record names another tab')?.calls.filter((c) => c.startsWith('tabs.sendMessage'));
  assert.deepEqual(broadcast, [
    'tabs.sendMessage [1,{"type":"RECORDING_STATE","recording":true}]',
    'tabs.sendMessage [2,{"type":"RECORDING_STATE","recording":false}]',
  ]);
  assert.deepEqual(_stepOf('page: another tab types a password')?.responses, [{ received: false }]);
  assert.deepEqual(_stepOf('page: its own tab is recorded')?.responses, [{ received: true }]);
  // Stop from a web page returns a bare ack — never the recorded actions.
  assert.deepEqual(_stepOf('page: stop record returns no actions')?.responses, [{ received: true }]);
  // The password typed on the other tab is nowhere in the transcript.
  assert.ok(!JSON.stringify(transcript).includes('hunter2'), 'the other tab input must not leak');
  // Stop Pick Mode from a web page goes to its own tab, not the one it named.
  const pick = _stepOf('page: stop pick mode names another tab')?.calls.filter((c) => c.startsWith('tabs.sendMessage'));
  assert.deepEqual(pick, ['tabs.sendMessage [1,{"type":"STOP_PICK_MODE","tabId":2}]']);
});
test('a web page cannot drive the window capture', () => {
  const step = _stepOf('page: window capture result refused');
  assert.deepEqual(step?.responses, [], 'the listener stays silent for a web page');
  const calls = step?.calls || [];
  assert.ok(!calls.some((c) => c.startsWith('windows.remove')), 'no window closed');
  assert.ok(!calls.some((c) => c.startsWith('downloads.download')), 'nothing downloaded');
});
test('from a web page, a recorded action is a click or an input with known fields only', () => {
  assert.deepEqual(_stepOf('from a web page: recorded uploadFile dropped')?.responses, [{ received: false }]);
  assert.deepEqual(_stepOf('from a web page: recorded script dropped')?.responses, [{ received: false }]);
  assert.deepEqual(_stepOf('stop record (page actions)')?.responses?.[0]?.actions, [{
    type: 'click', selector: '#ok', selectors: { css: '#ok', text: 'OK', textTag: 'button' }, frameId: 3, delay: 500,
  }]);
});
test('an import names its Run JS actions and the folders its Upload File actions read', () => {
  const one = _stepOf('import scenario with uploadFile')?.responses?.[0];
  assert.equal(one?.hasScriptActions, true);
  assert.deepEqual(one?.uploadFolders, ['C:\\Users\\me\\.ssh']);
  const folder = _stepOf('import folder with uploadFile')?.responses?.[0];
  assert.equal(folder?.hasScriptActions, false);
  assert.deepEqual(folder?.uploadFolders, ['D:\\data', 'E:\\x']);
});
test("a scenario's Click through changes the scenario only, and Duplicate keeps it", () => {
  assert.equal(ctOff.clickThrough, false);
  assert.deepEqual(ctOff.actions, CT_ACTIONS, 'off: the actions are untouched');
  assert.ok(!('clickThrough' in ctOn), 'back on: no key left');
  assert.deepEqual(ctOn.actions, CT_ACTIONS, 'back on: an action turned off on its own stays off');
  assert.equal(fake.data.local.scenarios[ctCopyId]?.clickThrough, false);
  assert.deepEqual(_stepOf('click through: from a web page refused')?.responses, []);
  assert.deepEqual(_stepOf('click through: unknown scenario')?.responses, [{ success: false }]);
});
test('schedules saved at once, or while a one-shot alarm fires, all stay', () => {
  assert.ok(['scA', 'scB', 'scC'].every((id) => schedulesSavedAtOnce.includes(id)), JSON.stringify(schedulesSavedAtOnce));
  assert.ok(schedulesAfterAlarm.some((s) => s.id === 'scNew'), 'the schedule saved meanwhile is kept');
  assert.equal(schedulesAfterAlarm.find((s) => s.id === 'scOnce')?.enabled, false, 'the one-shot is spent');
});
test('a restore arms the schedules it brings back', () => {
  assert.ok(_stepOf('schedules: a restore arms them')?.calls.some((c) => c.startsWith('alarms.create ["sched_scRestored"')));
});
test('a web page saves its own highlights only', () => {
  assert.deepEqual(_stepOf('highlights: a web page edits another page')?.responses, [{ ok: false }]);
  assert.deepEqual(_stepOf('highlights: a web page saves its own, fragment dropped')?.responses, [{ ok: true }]);
  assert.deepEqual(_stepOf('highlights: a web page saves under a pattern')?.responses, [{ ok: true }]);
  assert.deepEqual(bankAfterPageEdit, [{ id: 'b1', text: 'balance' }]);
});
test('the highlight engine goes into the document that asked for it', () => {
  const calls = _stepOf('highlight engine: HL_LOAD from a document')?.calls || [];
  assert.ok(calls.some((c) => c.startsWith('scripting.executeScript') && c.includes('"documentIds":["doc-4"]') && !c.includes('frameIds')), JSON.stringify(calls));
});
test('a web page is refused what its content script never sends', () => {
  for (const step of ['GET_ALL_DATA', 'IMPORT_SCENARIO', 'RESTORE_ALL_DATA']) {
    assert.deepEqual(_stepOf(`from a web page: ${step} refused`)?.responses, [], step);
  }
  assert.equal(storageAfterRefused, storageBefore);
});
test('a schedule with a start URL opens it in a new tab, and plays nothing on the active one', () => {
  const calls = _stepOf('alarm sched_scUrl')?.calls || [];
  assert.ok(calls.some((c) => c.startsWith('tabs.create') && c.includes('"url":"https://example.com/start"')), 'tabs.create with the URL');
  assert.ok(!calls.some((c) => c.startsWith('tabs.sendMessage [1,')), 'nothing sent to tab 1');
});
test('two pages saving highlights at once both keep them', () => {
  assert.deepEqual(Object.keys(savedHighlights).filter((k) => k.includes('example.com/')).sort(), ['example.com/b', 'https://example.com/page']);
});
test('two tabs on one page making highlights at once both keep them', () => {
  assert.deepEqual(savedHighlights['https://example.com/page'].map((h) => h.id).sort(), ['h1', 'h1b']);
});
test('a malformed highlight edit is refused whole', () => {
  for (const step of ['an unknown edit', 'a set of the text', 'no edits']) {
    assert.deepEqual(_stepOf(`highlights: ${step}`)?.responses, [{ ok: false }], step);
  }
  assert.equal(hlAfterBadEdits, hlBeforeBadEdits);
});
test('the popup editing a highlight while the page saves another keeps both', () => {
  assert.deepEqual(hlAfterPopupEdit['https://example.com/pop'].map((h) => [h.id, h.color || null]), [['p1', 'green'], ['p2', null]]);
});
test('the popup re-groups the store with its patterns; a web page may not', () => {
  assert.deepEqual(_stepOf('highlights: a web page re-groups')?.responses, []);
  assert.ok(!hlAfterPageRegroup.includes('"hl_patterns_v1":["example.com/*"]'));
  assert.deepEqual(_stepOf('highlights: the popup re-groups')?.responses, [{ ok: true }]);
  assert.deepEqual(hlAfterRegroup.patterns, ['example.com/*']);
  assert.deepEqual(Object.keys(hlAfterRegroup.hl), ['example.com/*']);
  assert.deepEqual(hlAfterRegroup.hl['example.com/*'].map((h) => h.id).sort(), ['p1', 'p2']);
});
test('removing the last highlight of a page drops the page', () => {
  assert.deepEqual(_stepOf('highlights: remove the last one')?.responses, [{ ok: true }]);
  assert.equal(goneAfterRemove, false);
});
test('a web page still gets what its content script sends answered', () => {
  assert.equal(_stepOf('from a web page: REGISTER_FRAME answered')?.responses.length, 1);
});

test('three IMPORT_SCENARIO at once save all three', () => {
  assert.deepEqual(ARRAY_IMPORT.filter((n) => !savedNames.includes(n)), []);
});
test('a rename and an added action on one scenario at once both stay', () => {
  assert.equal(arrayA?.name, 'Array A renamed');
  assert.deepEqual(arrayA?.actions, [{ type: 'click', selector: '#both' }]);
});

if (UPDATE) {
  writeFileSync(GOLDEN, stringify(actual) + '\n');
  console.log(`wrote tests/golden/router.json (${actual.length} steps)`);
} else {
  const expected = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : [];
  test('router transcript: same steps', () => {
    assert.deepStrictEqual(actual.map((e) => e.step), expected.map((e) => e.step));
  });
  test('router transcript', async (t) => {
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      await t.test(`${i} ${actual[i]?.step ?? expected[i]?.step}`, () => assert.deepStrictEqual(actual[i], expected[i]));
    }
  });
}
