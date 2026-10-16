// The highlight store's edits (HL_EDIT) and re-grouping, shared/highlight-store.js.
//
// Run: node --test tests/highlight-store.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHighlightOps, validHighlightOps, hlNormalizeUrl, hlRegroup } from '../shared/highlight-store.js';

const URL_A = 'https://example.com/a';
const ids = (list) => (list || []).map((h) => h.id);

test('edits apply to the store as it is, not to a copy read earlier', () => {
  // Two tabs on one page both read [h1], then each adds its own.
  let store = { [URL_A]: [{ id: 'h1', text: 'one' }] };
  store = applyHighlightOps(store, URL_A, [{ op: 'add', item: { id: 'h2', text: 'two' } }]);
  store = applyHighlightOps(store, URL_A, [{ op: 'add', item: { id: 'h3', text: 'three' } }]);
  assert.deepEqual(ids(store[URL_A]), ['h1', 'h2', 'h3']);
});

test('add keeps one highlight per id; set changes the named fields only; remove and clear', () => {
  let store = applyHighlightOps({}, URL_A, [
    { op: 'add', item: { id: 'h1', text: 'one', color: 'yellow' } },
    { op: 'add', item: { id: 'h1', text: 'dupe' } },
    { op: 'add', item: { id: 'h2', text: 'two' } },
    { op: 'set', id: 'h1', fields: { color: 'green', note: 'n' } },
    { op: 'set', id: 'missing', fields: { color: 'pink' } },
  ]);
  assert.deepEqual(store[URL_A], [{ id: 'h1', text: 'one', color: 'green', note: 'n' }, { id: 'h2', text: 'two' }]);
  store = applyHighlightOps(store, URL_A, [{ op: 'remove', id: 'h1' }]);
  assert.deepEqual(ids(store[URL_A]), ['h2']);
  store = applyHighlightOps({ ...store, other: [{ id: 'o' }] }, URL_A, [{ op: 'clear' }]);
  assert.deepEqual(store, { other: [{ id: 'o' }] });
});

test('a page left empty is dropped; the store passed in is not changed', () => {
  const before = { [URL_A]: [{ id: 'h1' }] };
  const after = applyHighlightOps(before, URL_A, [{ op: 'remove', id: 'h1' }]);
  assert.ok(!(URL_A in after));
  assert.deepEqual(before, { [URL_A]: [{ id: 'h1' }] });
});

test('validHighlightOps takes the four edits and nothing else', () => {
  assert.ok(validHighlightOps([{ op: 'add', item: { id: 'a' } }, { op: 'set', id: 'a', fields: { color: 'x', note: '', disabled: true, srcUrl: URL_A } }, { op: 'remove', id: 'a' }, { op: 'clear' }]));
  for (const bad of [
    undefined, [], {}, [null], [{ op: 'replace' }],
    [{ op: 'add' }], [{ op: 'add', item: { text: 'no id' } }], [{ op: 'add', item: { id: '' } }],
    [{ op: 'set', id: 'a', fields: { text: 'x' } }], [{ op: 'set', id: 'a', fields: JSON.parse('{"__proto__":{"x":1},"color":"y"}') }],
    [{ op: 'set', id: 'a', fields: [] }], [{ op: 'remove' }], [{ op: 'remove', id: 3 }],
  ]) {
    assert.equal(validHighlightOps(bad), false, JSON.stringify(bad));
  }
});

test('regroup moves highlights under the pattern their page matches, and back', () => {
  const store = { [URL_A]: [{ id: 'h1', createdAt: 2 }], 'https://example.com/b': [{ id: 'h2', createdAt: 1 }] };
  const grouped = hlRegroup(store, ['example.com/*']);
  assert.deepEqual(Object.keys(grouped), ['example.com/*']);
  assert.deepEqual(ids(grouped['example.com/*']), ['h2', 'h1']);
  const back = hlRegroup(grouped, []);
  assert.deepEqual(Object.keys(back).sort(), [URL_A, 'https://example.com/b']);
  assert.equal(hlNormalizeUrl('https://example.com/a#top', []), URL_A);
});
