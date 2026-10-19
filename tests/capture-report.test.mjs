// reportCaptureResult notifies when no popup is open to toast the result —
// asked of the browser, not guessed from `fromHotkey`. The popup's countdown and
// segment buttons close the popup and send fromHotkey: false, so trusting the
// flag left those captures with no feedback at all.
//
// Run: node --test "tests/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

let popups = [];
let titles = [];
globalThis.chrome = {
  runtime: {
    getURL: (p) => p,
    sendMessage: async () => {},
    getContexts: async ({ contextTypes }) => (contextTypes.includes('POPUP') ? popups : []),
  },
  storage: { sync: { get: (keys, cb) => cb({}) } },
  notifications: { create: (id, opt, cb) => { titles.push(opt.title); cb?.(); } },
};

const { reportCaptureResult } = await import('../bg/screenshot/report.js');
const flush = () => new Promise((r) => setImmediate(r));

async function report(result, opts, openPopups) {
  popups = openPopups;
  titles = [];
  await reportCaptureResult(result, opts);
  await flush();
  return titles;
}

test('popup closed: a popup-started capture (fromHotkey false) still notifies', async () => {
  assert.deepEqual(await report({ success: true, filename: 'a.png' }, { fromHotkey: false }, []), ['Screenshot saved']);
});

test('popup open: the toast is the feedback, no notification', async () => {
  assert.deepEqual(await report({ success: true, filename: 'a.png' }, { fromHotkey: true }, [{}]), []);
});

test('popup closed: errors, partials; never a cancelled Save As or the editor opening', async () => {
  assert.deepEqual(await report({ error: 'boom' }, { label: 'Segment screenshot' }, []), ['Segment screenshot failed']);
  assert.deepEqual(await report({ success: true, partial: true, filename: 'p.png' }, {}, []), ['Screenshot saved (partial)']);
  assert.deepEqual(await report({ cancelled: true }, {}, []), []);
  assert.deepEqual(await report({ success: true, cropping: true }, {}, []), []);
});

test('without runtime.getContexts (Chrome < 116) fromHotkey is the guess again', async () => {
  const { getContexts } = chrome.runtime;
  delete chrome.runtime.getContexts;
  try {
    assert.deepEqual(await report({ success: true }, { fromHotkey: false }, []), []);
    assert.deepEqual(await report({ success: true }, { fromHotkey: true }, []), ['Screenshot saved']);
  } finally {
    chrome.runtime.getContexts = getContexts;
  }
});
