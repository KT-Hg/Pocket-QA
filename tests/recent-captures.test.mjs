// Which captures Recent drops to stay under its limits, shared/recent-captures.js.
//
// Run: node --test tests/recent-captures.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEvictions, addRecent, listRecent } from '../shared/recent-captures.js';

const shot = (id, at, size = 1) => ({ id, at, size });

test('over the count, the oldest go', () => {
  const entries = [shot(1, 10), shot(2, 30), shot(3, 20), shot(4, 40)];
  assert.deepEqual(pickEvictions(entries, { maxShots: 2, maxBytes: 100 }).sort(), [1, 3]);
});

test('over the bytes, everything older than the first that does not fit goes', () => {
  const entries = [shot(1, 10, 5), shot(2, 20, 40), shot(3, 30, 30), shot(4, 40, 20)];
  // newest first: 4 (20) + 3 (30) = 50 fits; 2 (40) would make 90 > 60, so 2 and 1 go
  assert.deepEqual(pickEvictions(entries, { maxShots: 10, maxBytes: 60 }), [2, 1]);
});

test('the newest stays however big it is', () => {
  assert.deepEqual(pickEvictions([shot(1, 10, 1), shot(2, 20, 999)], { maxShots: 10, maxBytes: 100 }), [1]);
});

test('without indexedDB nothing is kept and nothing fails', async () => {
  assert.equal(typeof indexedDB, 'undefined');
  assert.equal(await addRecent({ blob: null, kind: 'Page' }), null);
  assert.deepEqual(await listRecent(), []);
});
