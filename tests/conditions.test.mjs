// Condition ranges: what a Condition guards, how the preview lays it out, and
// how remove / reorder keep `skipCount` guarding the same actions.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  conditionRange, conditionChoices, getConditionLayout, conditionSkipTarget,
  remapAfterRemove, remapAfterReorder, planDrop,
} = await import('../shared/switch-blocks.js');

const act  = (label) => ({ type: 'click', selector: `#${label}`, label });
const cond = (skipCount, label = 'if') => ({ type: 'condition', conditionType: 'elementExists', selector: '#x', skipCount, label });
const blk  = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
const labels = (list) => list.map((a) => a.label);
const skips  = (list) => list.filter((a) => a.type === 'condition').map((a) => a.skipCount);

test('range: the next skipCount actions', () => {
  const list = [cond(2), act('A'), act('B'), act('C')];
  assert.deepEqual(
    (({ start, end, units, short, cut }) => ({ start, end, units, short, cut }))(conditionRange(list, 0)),
    { start: 1, end: 2, units: 2, short: false, cut: false });
});

test('range: a block Switch with its block counts as one', () => {
  const list = [cond(1), { type: 'switch', switchVar: '${a}', label: 'S', cases: [blk('1', 3, 3)] }, act('A'), act('B')];
  const r = conditionRange(list, 0);
  assert.equal(r.end, 2);                                   // Switch + its block
  assert.equal(conditionSkipTarget(list, 0, 1), r.end + 1); // same as playback
});

test('range: short when the skip runs off the end, cut at the end of its case', () => {
  assert.equal(conditionRange([cond(5), act('A')], 0).short, true);
  const list = [
    { type: 'switch', switchVar: '${a}', label: 'S', cases: [blk('1', 2, 3), blk('2', 4, 4)] },
    cond(3), act('A'), act('B'), act('C'),
  ];
  const r = conditionRange(list, 1);
  assert.equal(r.end, 2);    // only A: the rest of case 1
  assert.equal(r.cut, true);
});

test('choices stop at the end of the Condition\'s case', () => {
  const list = [
    { type: 'switch', switchVar: '${a}', label: 'S', cases: [blk('1', 2, 4)] },
    cond(1), act('A'), act('B'), act('C'),
  ];
  assert.deepEqual(conditionChoices(list, 1), [2, 3]);
});

test('layout: nested Conditions, outermost first; an inner one running past is flagged', () => {
  const list = [cond(3, 'outer'), act('A'), cond(3, 'inner'), act('B'), act('C'), act('D')];
  const cl = getConditionLayout(list);
  assert.deepEqual(cl[1].conds, [0]);
  assert.deepEqual(cl[3].conds, [0, 2]);
  assert.deepEqual(cl[4].conds, [2]);
  assert.equal(cl[2].range.past, 0);
});

test('remove inside the range: the Condition guards one less', () => {
  const list = [cond(3), act('A'), act('B'), act('C'), act('D')];
  const next = remapAfterRemove(list, 2);
  assert.deepEqual(labels(next), ['if', 'A', 'C', 'D']);
  assert.deepEqual(skips(next), [2]);                // A, C — D stays outside
});

test('remove outside the range: skipCount is left alone', () => {
  const list = [act('Z'), cond(2), act('A'), act('B'), act('C')];
  assert.deepEqual(skips(remapAfterRemove(list, 0)), [2]);
  assert.deepEqual(skips(remapAfterRemove(list, 4)), [2]);
});

test('drag out of the range, and back in', () => {
  const list = [cond(2), act('A'), act('B'), act('C')];
  // B dropped on the "out of the If" zone → after the range, not guarded
  const out = planDrop(list, 2, { kind: 'outsideCond', condIdx: 0 });
  assert.deepEqual(labels(out.actions), ['if', 'A', 'B', 'C']);
  assert.deepEqual(skips(out.actions), [1]);
  // C dropped after A → joins the If
  const into = planDrop(list, 3, { kind: 'after', index: 1 });
  assert.deepEqual(labels(into.actions), ['if', 'A', 'C', 'B']);
  assert.deepEqual(skips(into.actions), [3]);
  // Z dropped right after the Condition row → its first guarded action
  const first = planDrop([...list, act('Z')], 4, { kind: 'after', index: 0 });
  assert.deepEqual(labels(first.actions), ['if', 'Z', 'A', 'B', 'C']);
  assert.deepEqual(skips(first.actions), [3]);
});

test('dragging a Condition takes what it guards along', () => {
  const list = [act('Z'), cond(2), act('A'), act('B'), act('C')];
  const r = planDrop(list, 1, { kind: 'after', index: 4 });
  assert.deepEqual(labels(r.actions), ['Z', 'C', 'if', 'A', 'B']);
  assert.deepEqual(skips(r.actions), [2]);
});

test('a reorder without move info keeps skipCount', () => {
  const list = [cond(1), act('A'), act('B')];
  assert.deepEqual(skips(remapAfterReorder(list, [0, 2, 1])), [1]);
});

// ── The last guarded action leaves: the Condition is emptied, not stuck ─────
const { conditionSkip } = await import('../shared/switch-blocks.js');

test('dragging out the only guarded action empties the Condition', () => {
  const list = [cond(1), act('A'), act('C')];
  const r = planDrop(list, 1, { kind: 'outsideCond', condIdx: 0 });
  assert.deepEqual(labels(r.actions), ['if', 'A', 'C']);
  assert.equal(r.actions[0].empty, true);
  assert.equal(conditionSkip(r.actions[0]), 0);
  const range = conditionRange(r.actions, 0);
  assert.ok(range.end < range.start);                  // guards nothing
  assert.equal(conditionSkipTarget(r.actions, 0, 0), 1); // a false result skips nothing
});

test('nested: the inner Condition\'s only action leaves both', () => {
  const list = [cond(3, 'outer'), act('A'), cond(1, 'inner'), act('B'), act('C')];
  const r = planDrop(list, 3, { kind: 'outsideCond', condIdx: 0 });
  const [outer, , inner] = r.actions;
  assert.equal(outer.skipCount, 2);                    // A, inner
  assert.equal(inner.empty, true);
  assert.equal(getConditionLayout(r.actions)[3].conds.length, 0); // B is free
});

test('deleting the only guarded action empties the Condition', () => {
  const next = remapAfterRemove([cond(1), act('A'), act('B')], 1);
  assert.deepEqual(labels(next), ['if', 'B']);
  assert.equal(next[0].empty, true);
});

test('an action dropped right below an emptied Condition is guarded again', () => {
  const list = [{ ...cond(1), empty: true }, act('A'), act('B')];
  const r = planDrop(list, 2, { kind: 'after', index: 0 });
  assert.deepEqual(labels(r.actions), ['if', 'B', 'A']);
  assert.equal(r.actions[0].empty, undefined);
  assert.equal(r.actions[0].skipCount, 1);
});
