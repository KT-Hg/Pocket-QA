// A recording saved before the worker stopped is restored at start-up. The
// message that woke the worker — the first click, the popup's Stop — reaches the
// handlers before session storage has been read back, and must still be handled
// against the restored recording.
//
// Run: node --test "tests/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeFake } from './helpers/chrome-fake.mjs';

const fake = installChromeFake();
Object.assign(fake.data.local, { scenarios: { s1: { name: 'Saved', actions: [] } } });
Object.assign(fake.data.session, {
  rec_recording: true, rec_scenarioId: 's1', rec_tabId: 1, rec_timestamp: fake.now,
  rec_actions: [{ type: 'click', selector: '#a', frameId: 0, delay: 500 }],
});

const PAGE = { tab: { id: 1, url: 'https://example.com/' }, url: 'https://example.com/', frameId: 0 };
const POPUP = { url: 'chrome-extension://testextensionid/popup.html' };

/** Every onMessage listener, as Chrome dispatches; the answers fill in as they come. */
function send(request, sender) {
  const responses = [];
  for (const fn of [...fake.events['runtime.onMessage']]) fn(request, sender, (r) => responses.push(r));
  return responses;
}

await import('../background.js');
const { state } = await import('../bg/state.js');
// Sent before anything has settled: the restore has not read session storage yet.
const clicked = send({ type: 'RECORDED_ACTION', action: { type: 'click', selector: '#b' } }, PAGE);
const stopped = send({ type: 'STOP_RECORD' }, POPUP);
await fake.settle(5_000);

test('the click that wakes the worker is recorded', () => {
  assert.deepEqual(clicked, [{ received: true }]);
});

test('Stop sent first saves the restored recording, and it stays stopped', () => {
  assert.deepEqual(stopped[0]?.actions?.map((a) => a.selector), ['#a', '#b']);
  assert.deepEqual(fake.data.local.scenarios.s1.actions.map((a) => a.selector), ['#a', '#b']);
  assert.equal(state.recording, false);
});
