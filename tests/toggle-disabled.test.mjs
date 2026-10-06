// Disabling / enabling a Switch or Condition takes the actions under it along
// (childRange / toggleDisabled in shared/switch-blocks.js).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { childRange, toggleDisabled } = await import('../shared/switch-blocks.js');

const blk = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
const off = (list) => list.map((a, i) => (a.disabled ? i : null)).filter((i) => i !== null);

// 0 navigate · 1 If (guards 2 units) · 2 click · 3 Switch [4 | 5] · 6 click
const list = [
  { type: 'navigate', url: 'https://example.com' },
  { type: 'condition', conditionType: 'elementExists', selector: '#x', skipCount: 2 },
  { type: 'click', selector: '#a' },
  { type: 'switch', switchVar: '${role}', cases: [blk('a', 5, 5), blk('b', 6, 6)] },
  { type: 'input', selector: '#b', value: '1' },
  { type: 'input', selector: '#c', value: '2' },
  { type: 'click', selector: '#d' },
];

test('childRange: a Switch block, a Condition range with a Switch inside, nothing for others', () => {
  assert.deepEqual(childRange(list, 3), { start: 4, end: 5 });
  assert.deepEqual(childRange(list, 1), { start: 2, end: 5 });
  assert.equal(childRange(list, 2), null);
  assert.equal(childRange(list, 6), null);
  assert.equal(childRange([{ type: 'condition', empty: true, skipCount: 1 }, { type: 'click' }], 0), null);
  assert.equal(childRange([{ type: 'condition', skipCount: 1 }], 0), null, 'nothing follows');
});

test('disabling a Condition disables everything it guards, nested Switch block included', () => {
  const r = toggleDisabled(list, 1);
  assert.equal(r.disabled, true);
  assert.equal(r.children, 4);
  assert.deepEqual(off(r.actions), [1, 2, 3, 4, 5]);
  assert.deepEqual(off(list), [], 'input list untouched');
});

test('disabling a Switch disables its block only', () => {
  const r = toggleDisabled(list, 3);
  assert.deepEqual(off(r.actions), [3, 4, 5]);
  assert.equal(r.children, 2);
});

test('a child can be switched back on its own, and enabling the parent enables all again', () => {
  let a = toggleDisabled(list, 1).actions;          // If + 2..5 off
  a = toggleDisabled(a, 4).actions;                 // re-enable one block action by hand
  assert.deepEqual(off(a), [1, 2, 3, 5]);
  a = toggleDisabled(a, 2).actions;                 // a plain action only toggles itself
  assert.deepEqual(off(a), [1, 3, 5]);
  const r = toggleDisabled(a, 1);                   // If back on → everything under it on
  assert.equal(r.disabled, false);
  assert.deepEqual(off(r.actions), []);
});

test('out-of-range index leaves the list as it is', () => {
  const r = toggleDisabled(list, 99);
  assert.equal(r.actions, list);
  assert.equal(r.children, 0);
});
