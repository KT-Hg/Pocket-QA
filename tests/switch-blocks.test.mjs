// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSwitchLayout, validateSwitch, conditionSkipTarget, resumeSegments,
  remapAfterRemove, remapAfterReorder, planDrop, continueIndex, blockEnd, isAlwaysSwitch,
  addIndex, remapAfterInsert,
} from '../shared/switch-blocks.js';

const act = (label) => ({ type: 'click', selector: `#${label}`, label });
const sw = (cases, extra = {}) => ({ type: 'switch', switchVar: '${a}', cases, ...extra });
const blk = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });

// #1 Switch  "1" → #2..#3 | "2" → #4..#5,  #6 after
const sample = () => [
  sw([blk('1', 2, 3), blk('2', 4, 5)]),
  act('A'), act('B'), act('C'), act('D'), act('E'),
];
// `pre` actions in front of the sample, with the case ranges shifted to match.
const withPrefix = (...pre) => [
  ...pre,
  sw([blk('1', 2 + pre.length, 3 + pre.length), blk('2', 4 + pre.length, 5 + pre.length)]),
  act('A'), act('B'), act('C'), act('D'), act('E'),
];
// Where each action sits: '-' at the top, else '<Switch #>.<case #>' of every
// enclosing case, outermost first ('?': in the block, in no case).
const places = (actions) => getSwitchLayout(actions).map((e) =>
  e.chain.map((c) => `${c.switchIdx + 1}.${c.caseIdx == null ? '?' : c.caseIdx + 1}`).join(' ') || '-');
const nos = (actions) => getSwitchLayout(actions).map((e) => e.displayNo);

test('layout: sample — numbered by position, placed in its cases', () => {
  assert.deepEqual(nos(sample()), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(places(sample()), ['-', '1.1', '1.1', '1.2', '1.2', '-']);
  const lay = getSwitchLayout(sample());
  assert.equal(lay[0].role, 'switch');
  assert.equal(lay[1].role, 'member');
  assert.deepEqual(lay[1].parent, { switchIdx: 0, caseIdx: 0 });
  assert.deepEqual(lay[3].caseStart, { switchIdx: 0, caseIdx: 1 });
  assert.equal(lay[3].color, 1);
  assert.deepEqual(lay[4].blockLast, [0]);
  assert.deepEqual(lay[5].continueOf, [0]);
  assert.equal(lay[0].block.continueIdx, 5);
});

test('layout: no blocks — every action at the top', () => {
  const acts = [act('a'), sw([{ value: 'x', scenarioId: '__self__', startAt: 3 }]), act('b')];
  assert.deepEqual(places(acts), ['-', '-', '-']);
});

test('layout: a case without block actions keeps its case number; an orphan is in no case', () => {
  const acts = [
    sw([{ value: 'x', scenarioId: 'other' }, blk('1', 3, 3)]),
    act('orphan'), act('A'), act('after'),
  ];
  assert.deepEqual(places(acts), ['-', '1.?', '1.2', '-']);
  assert.equal(getSwitchLayout(acts)[1].role, 'orphan');
});

test('layout: nested switch', () => {
  const acts = [
    act('x'),
    sw([blk('1', 3, 6)]),
    act('A'),                                  // case "1" of #2
    sw([blk('p', 5, 5), blk('q', 6, 6)]),      // case "1" of #2
    act('P'),                                  // case "p" of #4, in case "1" of #2
    act('Q'),                                  // case "q" of #4, in case "1" of #2
    act('end'),
  ];
  assert.deepEqual(places(acts), ['-', '-', '2.1', '2.1', '2.1 4.1', '2.1 4.2', '-']);
  // Numbered by position all the same: the number a failure or the run report gives.
  assert.deepEqual(nos(acts), ['1', '2', '3', '4', '5', '6', '7']);
});

test('layout: a disabled action keeps its place', () => {
  const acts = sample();
  acts[2].disabled = true;
  assert.deepEqual(places(acts), ['-', '1.1', '1.1', '1.2', '1.2', '-']);
});

test('continueAt: auto and explicit', () => {
  const acts = sample();
  assert.equal(blockEnd(acts, 0), 4);
  assert.equal(continueIndex(acts, 0), 5);
  acts[0].continueAt = 6;
  assert.equal(continueIndex(acts, 0), 5);
});

test('validate: clean sample', () => {
  assert.deepEqual(validateSwitch(sample(), 0), { errors: [], warnings: [] });
});

test('validate: errors', () => {
  const bad = (cases, extra) => validateSwitch([act('0'), sw(cases, extra), act('a'), act('b'), act('c')], 1).errors;
  assert.ok(bad([blk('1', 1, 3)]).some((e) => /after the Switch/.test(e)));
  assert.ok(bad([blk('1', 2, 3)]).some((e) => /after the Switch/.test(e)));   // contains the switch
  assert.ok(bad([blk('1', 4, 3)]).some((e) => /before it starts/.test(e)));
  assert.ok(bad([blk('1', 3, 9)]).some((e) => /past the last/.test(e)));
  assert.ok(bad([blk('1', 3, 4), blk('2', 4, 5)]).some((e) => /overlap/.test(e)));
  assert.ok(bad([blk('1', 3, 4)], { continueAt: 4 }).some((e) => /inside the block/.test(e)));
});

test('validate: nested block past parent case', () => {
  const acts = [sw([blk('1', 2, 3)]), sw([blk('x', 3, 4)]), act('a'), act('b')];
  assert.ok(validateSwitch(acts, 1).errors.some((e) => /parent case/.test(e)));
});

test('validate: old-style case jumping into a block', () => {
  const acts = [...sample(), sw([{ value: 'j', scenarioId: '__self__', startAt: 4 }])];
  assert.ok(validateSwitch(acts, 6).errors.some((e) => /middle of a Switch block/.test(e)));
  // Old scenarios (no blocks anywhere) never produce errors, even out of range.
  const old = [sw([{ value: 'j', scenarioId: '__self__', startAt: 99 }]), act('a')];
  assert.deepEqual(validateSwitch(old, 0).errors, []);
});

test('validate: mixed old/new cases only warn', () => {
  const acts = [sw([blk('1', 2, 2), { value: '2', scenarioId: '__self__', startAt: 3 }]), act('a'), act('b')];
  const v = validateSwitch(acts, 0);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /old style/.test(w)));
});

test('conditionSkipTarget: no blocks = i+1+skip', () => {
  const acts = [{ type: 'condition' }, act('a'), act('b'), act('c')];
  assert.equal(conditionSkipTarget(acts, 0, 2), 3);
});

test('conditionSkipTarget: switch + block counts as one action', () => {
  const acts = withPrefix({ type: 'condition' });
  // skip 1 → skips switch + whole block, lands on E (#7, idx 6)
  assert.equal(conditionSkipTarget(acts, 0, 1), 6);
});

test('conditionSkipTarget: landing inside a block goes to continueAt', () => {
  // A condition before an old-style action and the switch: skip 2 = the action + the whole block.
  const acts = withPrefix({ type: 'condition' }, act('x'));
  assert.equal(conditionSkipTarget(acts, 0, 2), 7);
  // a condition inside case 1 skipping past the case end
  const inner = [sw([blk('1', 2, 3), blk('2', 4, 5)]), { type: 'condition' }, act('B'), act('C'), act('D'), act('E')];
  assert.equal(conditionSkipTarget(inner, 1, 2), 5);
});

test('resumeSegments', () => {
  assert.deepEqual(resumeSegments(sample(), 2), [{ start: 2, end: 2 }, { start: 5, end: null }]);
  assert.deepEqual(resumeSegments(sample(), 5), [{ start: 5, end: null }]);
  const noBlocks = [act('a'), act('b')];
  assert.deepEqual(resumeSegments(noBlocks, 1), [{ start: 1, end: null }]);
});

test('remapAfterRemove: before, inside, emptied, the switch itself', () => {
  const before = remapAfterRemove(withPrefix(act('x')), 0);
  assert.deepEqual(before[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 3], [4, 5]]);

  const withX = [act('x'), sw([blk('1', 3, 4), blk('2', 5, 6)]), act('A'), act('B'), act('C'), act('D'), act('E')];
  const inside = remapAfterRemove(withX, 2);
  assert.deepEqual(inside[1].cases.map((c) => [c.startAt, c.endAt]), [[3, 3], [4, 5]]);

  const emptied = remapAfterRemove(inside, 2);
  assert.equal(emptied[1].cases[0].empty, true);
  assert.equal(emptied[1].cases[0].startAt, undefined);
  assert.deepEqual([emptied[1].cases[1].startAt, emptied[1].cases[1].endAt], [3, 4]);

  const noSwitch = remapAfterRemove(sample(), 0);
  assert.deepEqual(places(noSwitch), ['-', '-', '-', '-', '-']);
});

test('remapAfterRemove: old-style startAt follows (R2) and retargets', () => {
  const acts = [sw([{ value: 'j', scenarioId: '__self__', startAt: 3 }, { value: 'o', scenarioId: 'other', startAt: 3 }]), act('a'), act('b'), act('c')];
  const r1 = remapAfterRemove(acts, 1);
  assert.equal(r1[0].cases[0].startAt, 2);
  assert.equal(r1[0].cases[0].retargeted, undefined);
  assert.equal(r1[0].cases[1].startAt, 3); // other scenario: untouched
  const r2 = remapAfterRemove(acts, 2);
  assert.equal(r2[0].cases[0].startAt, 3);
  assert.equal(r2[0].cases[0].retargeted, true);
});

test('addIndex: last, or in front of the first action a new Switch runs', () => {
  const list = [act('a'), act('b'), act('c')];
  assert.equal(addIndex(list, act('x')), 3);
  assert.equal(addIndex(list, sw([blk('1', 3, 3), blk('2', 2, 2)])), 1);
  // Actions still to be added, an empty case, an old-style jump: last.
  assert.equal(addIndex(list, sw([blk('1', 4, 5)])), 3);
  assert.equal(addIndex(list, sw([{ value: 'x', scenarioId: '__self__', empty: true },
    { value: 'j', scenarioId: '__self__', startAt: 1 }])), 3);
});

test('remapAfterInsert: a new Switch in front of the action it runs', () => {
  // #1 Switch: default → #2..#3; then #4 and #5, which the new Switch runs.
  const acts = [sw([blk('__default__', 2, 3)]), act('upload'), act('wait3'), act('wait4'), act('wait5')];
  const added = sw([blk('__default__', 5, 5)], { switchVar: '${mode}' });
  const at = addIndex(acts, added);
  const next = remapAfterInsert(acts, at, added);
  assert.equal(at, 4);
  assert.deepEqual(next.map((a) => a.label || a.switchVar), ['${a}', 'upload', 'wait3', 'wait4', '${mode}', 'wait5']);
  assert.deepEqual(next[4].cases.map((c) => [c.startAt, c.endAt]), [[6, 6]]);
  assert.equal(next[0], acts[0]);
  assert.deepEqual(places(next), ['-', '1.1', '1.1', '-', '-', '5.1']);
  assert.deepEqual(validateSwitch(next, 4).errors, []);
});

test('remapAfterInsert: in a case, or at its start, the new Switch joins that case', () => {
  // #1 Switch "1" → #2..#4, "2" → #5..#6
  const acts = [sw([blk('1', 2, 4), blk('2', 5, 6)]), act('A'), act('B'), act('C'), act('D'), act('E')];
  const inner = remapAfterInsert(acts, 2, sw([blk('x', 3, 4)]));
  assert.deepEqual(inner[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 5], [6, 7]]);
  assert.deepEqual(inner[2].cases.map((c) => [c.startAt, c.endAt]), [[4, 5]]);
  assert.deepEqual(places(inner), ['-', '1.1', '1.1', '1.1 3.1', '1.1 3.1', '1.2', '1.2']);
  const atStart = remapAfterInsert(acts, 4, sw([blk('y', 5, 5)]));
  assert.deepEqual(atStart[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 4], [5, 7]]);
  assert.deepEqual(places(atStart), ['-', '1.1', '1.1', '1.1', '1.2', '1.2 5.1', '1.2']);
});

test('remapAfterInsert: a jump or continueAt to that place goes to the new Switch, not into its block', () => {
  const acts = [
    sw([blk('1', 2, 2)], { continueAt: 4 }),
    act('A'), act('B'), act('C'),
    sw([{ value: 'j', scenarioId: '__self__', startAt: 4 }, { value: 'k', scenarioId: '__self__', startAt: 6 }]),
    act('D'),
  ];
  const next = remapAfterInsert(acts, 3, sw([blk('x', 4, 4)]));
  assert.equal(next[0].continueAt, 4);
  assert.deepEqual(next[5].cases.map((c) => c.startAt), [4, 7]);
});

test('remapAfterInsert: a Condition guarding that place guards the new Switch, block and all', () => {
  const acts = [{ type: 'condition', skipCount: 2 }, act('A'), act('B'), act('C')];
  const next = remapAfterInsert(acts, 1, sw([blk('x', 2, 3)]));
  assert.equal(next[0].skipCount, 1);
  assert.deepEqual(places(next), ['-', '-', '2.1', '2.1', '-']);
});

test('remapAfterReorder: plain permutation keeps old-style targets on their action', () => {
  const acts = [sw([{ value: 'j', scenarioId: '__self__', startAt: 3 }]), act('a'), act('b')];
  const next = remapAfterReorder(acts, [0, 2, 1]);
  assert.equal(next[0].cases[0].startAt, 2);
  assert.equal(next[1].label, 'b');
});

test('planDrop: drag an action into a case', () => {
  // E (#6) dropped after B (#3, last of case "1") → joins case "1"
  const r = planDrop(sample(), 5, { kind: 'after', index: 2 });
  assert.deepEqual(r.newOrder, [0, 1, 2, 5, 3, 4]);
  assert.deepEqual(r.actions[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 4], [5, 6]]);
  assert.deepEqual(places(r.actions), ['-', '1.1', '1.1', '1.1', '1.2', '1.2']);
});

test('planDrop: gap between cases joins the case above; header joins its start', () => {
  const r = planDrop(sample(), 5, { kind: 'caseHead', switchIdx: 0, caseIdx: 1 });
  assert.deepEqual(r.newOrder, [0, 1, 2, 5, 3, 4]);
  assert.deepEqual(r.actions[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 3], [4, 6]]);
});

test('planDrop: outside zone and dragging out of a block', () => {
  const out = planDrop(sample(), 1, { kind: 'outside', switchIdx: 0 });
  assert.deepEqual(out.newOrder, [0, 2, 3, 4, 1, 5]);
  assert.deepEqual(out.actions[0].cases.map((c) => [c.startAt, c.endAt]), [[2, 2], [3, 4]]);
  assert.deepEqual(places(out.actions), ['-', '1.1', '1.2', '1.2', '-', '-']);

  const toTop = planDrop(sample(), 3, { kind: 'top' });
  assert.deepEqual(toTop.newOrder, [3, 0, 1, 2, 4, 5]);
  assert.deepEqual(toTop.actions[1].cases.map((c) => [c.startAt, c.endAt]), [[3, 4], [5, 5]]);
});

test('planDrop: dragging the switch moves the whole block', () => {
  const acts = withPrefix(act('x'));
  const r = planDrop(acts, 1, { kind: 'after', index: 6 });
  assert.deepEqual(r.newOrder, [0, 6, 1, 2, 3, 4, 5]);
  assert.deepEqual(r.actions[2].cases.map((c) => [c.startAt, c.endAt]), [[4, 5], [6, 7]]);
  assert.deepEqual(places(r.actions), ['-', '-', '-', '3.1', '3.1', '3.2', '3.2']);
});

test('planDrop: dropping into own block is a no-op; no blocks = plain move', () => {
  assert.equal(planDrop(sample(), 0, { kind: 'after', index: 2 }), null);
  const plain = [act('a'), act('b'), act('c')];
  assert.deepEqual(planDrop(plain, 0, { kind: 'after', index: 2 }).newOrder, [1, 2, 0]);
  assert.deepEqual(planDrop(plain, 2, { kind: 'top' }).newOrder, [2, 0, 1]);
});

test('planDrop: drop into an empty case', () => {
  const acts = [sw([blk('1', 2, 2), { value: '2', scenarioId: '__self__', empty: true }]), act('A'), act('E')];
  const r = planDrop(acts, 2, { kind: 'caseHead', switchIdx: 0, caseIdx: 1 });
  assert.deepEqual(r.actions[0].cases[1], { value: '2', scenarioId: '__self__', startAt: 3, endAt: 3 });
});

test('isAlwaysSwitch: no variable, one default case playing another scenario', () => {
  const always = (extra = {}) => ({ type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'B', scenarioName: 'B' }], ...extra });
  assert.equal(isAlwaysSwitch(always()), true);
  assert.equal(isAlwaysSwitch(always({ switchVar: '  ' })), true);
  assert.equal(isAlwaysSwitch({ type: 'switch', cases: [{ value: '__default__', scenarioId: 'B', startAt: 2, endAt: 3 }] }), true, 'no switchVar at all, with a range');
  assert.equal(isAlwaysSwitch(always({ switchVar: '${role}' })), false, 'a variable: the cases decide');
  assert.equal(isAlwaysSwitch(always({ cases: [{ value: 'a', scenarioId: 'B' }] })), false, 'not the default case');
  assert.equal(isAlwaysSwitch(always({ cases: [{ value: '__default__', scenarioId: 'B' }, { value: 'x', scenarioId: 'C' }] })), false, 'more than one case');
  assert.equal(isAlwaysSwitch(always({ cases: [{ value: '__default__', scenarioId: '__self__', startAt: 3 }] })), false, 'a jump in this scenario');
  assert.equal(isAlwaysSwitch(always({ cases: [] })), false);
  assert.equal(isAlwaysSwitch({ type: 'click' }), false);
  assert.equal(isAlwaysSwitch(null), false);
});
