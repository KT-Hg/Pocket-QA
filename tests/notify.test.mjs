// Notification categories: every one on until the user switches it off in Settings.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const sync = {};
const shown = [];
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}`, lastError: undefined },
  storage: { sync: { get: (keys, cb) => cb(Object.fromEntries(keys.filter((k) => k in sync).map((k) => [k, sync[k]]))) } },
  notifications: { create: (id, opts, cb) => { shown.push(opts.title); cb?.(); } },
};
const { sendCompletionNotification } = await import('../bg/notify.js');

test('a run that ended is told by default; switched off in Settings, it is not', async () => {
  await sendCompletionNotification('never touched');
  sync.notifyOnComplete = false;
  await sendCompletionNotification('switched off');
  sync.notifyOnComplete = true;
  await sendCompletionNotification('switched on');
  assert.deepEqual(shown, ['never touched', 'switched on']);
});
