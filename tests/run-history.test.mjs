// The last runs of each scenario (shared/run-history.js): what is kept, and what
// the runs say together — flaky, broke, or nothing.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_MAX, actionsPrint, historyEntry, historyVerdict, pushHistory } from '../shared/run-history.js';

const A = [{ type: 'click', selector: '#go' }];
const B = [{ type: 'click', selector: '#go2' }];
let clock = 0;
/** A run: P passed, F failed (at #4), X broken (at #2), S stopped; `actions` its steps. */
const run = (c, actions = A, extra = {}) => {
  clock += 1000;
  const status = { P: 'passed', F: 'failed', X: 'broken', S: 'stopped' }[c];
  const failures = c === 'F' ? [{ index: 4, type: 'assert', label: 'Toast', reason: 'Expected text "Saved", got "Loading…"', kind: 'assert' }]
    : c === 'X' ? [{ index: 2, type: 'click', reason: 'Element not found', kind: 'broken' }] : [];
  return historyEntry({ how: 'play', startedAt: clock - 500, endedAt: clock, verdict: { status, asserts: c === 'F' ? 1 : 0, broken: c === 'X' ? 1 : 0 }, failures, actions, ...extra });
};
const runs = (s, actions) => [...s].map((c) => run(c, actions));

test('an entry keeps the verdict, the first failure in short, and the fingerprint of the steps', () => {
  const e = historyEntry({
    how: 'schedule', startedAt: 1, endedAt: 9, verdict: { status: 'failed', asserts: 2, broken: 0, checks: 3 },
    failures: [{ index: 4, type: 'assert', label: 'x'.repeat(100), reason: 'r'.repeat(500), kind: 'assert', trace: [0, 1, 2], url: 'https://a' }, { index: 6 }],
    actions: A,
  });
  assert.deepEqual(Object.keys(e), ['how', 'startedAt', 'endedAt', 'status', 'asserts', 'checks', 'first', 'fp']);
  assert.equal(e.first.label.length, 60);
  assert.equal(e.first.reason.length, 200);
  assert.equal(e.first.trace, undefined, 'the trace and the URL stay with the last run only');
  assert.equal(e.fp, actionsPrint(A));
  assert.notEqual(actionsPrint(A), actionsPrint(B));
  assert.ok(JSON.stringify(e).length < 500, 'a few hundred bytes at most');
});

test('a CSV run keeps its rows and the row of its first failure', () => {
  const e = historyEntry({ how: 'csv', startedAt: 1, endedAt: 2, verdict: { status: 'failed', asserts: 1 },
    failures: [{ index: 3, type: 'assert', kind: 'assert', reason: 'x', row: 7 }], actions: A, rows: { passed: 9, failed: 1, broken: 0, stopped: 0 } });
  assert.deepEqual(e.rows, { passed: 9, failed: 1, broken: 0, stopped: 0 });
  assert.equal(e.first.row, 7);
});

test('pushHistory keeps the last 20 of a scenario and drops deleted scenarios', () => {
  let all = { gone: [run('P')], keep: [run('P')] };
  for (let i = 0; i < 25; i++) all = pushHistory(all, 'keep', run('P'), new Set(['keep']));
  assert.deepEqual(Object.keys(all), ['keep']);
  assert.equal(all.keep.length, HISTORY_MAX);
  assert.ok(all.keep.at(-1).endedAt > all.keep[0].endedAt, 'oldest first');
  assert.deepEqual(Object.keys(pushHistory(undefined, 'new', run('P'))), ['new']);
});

test('failing after a pass and passing again with the same steps: flaky, at the step it fails on most', () => {
  const v = historyVerdict(runs('PPFPPFPFPF'));
  assert.equal(v.kind, 'flaky');
  assert.deepEqual([v.runs, v.failed], [10, 4]);
  assert.deepEqual({ ...v.step }, { index: 4, label: 'Toast', count: 4 });
});

test('passing, then failing every time: broke, since the first failing run', () => {
  const list = runs('PPPPPPPFFF');
  const v = historyVerdict(list);
  assert.equal(v.kind, 'broke');
  assert.deepEqual([v.inRow, v.passedBefore, v.since], [3, 7, list[7].endedAt]);
});

test('a pass after an edit is not flaky: the steps changed in between', () => {
  const list = [...runs('PPPFF', A), ...runs('P', B), ...runs('F', B)];
  assert.notEqual(historyVerdict(list).kind, 'flaky');
});

test('nothing to say: too few runs, no failure, or a failure never followed by a pass', () => {
  assert.equal(historyVerdict(runs('FF')).kind, null);
  assert.equal(historyVerdict(runs('PPPPP')).kind, null);
  assert.equal(historyVerdict(runs('PPPPF')).kind, null);
  assert.equal(historyVerdict(runs('PFP')).kind, 'flaky', 'one failure between two passes, no edit: flaky');
  assert.equal(historyVerdict([]).kind, null);
});

test('stopped runs and CSV runs are not read together with the rest', () => {
  assert.equal(historyVerdict(runs('PSPSFF')).kind, 'broke', 'a Stop between passes changes nothing');
  const csv = run('F', A, { rows: { passed: 1, failed: 1, broken: 0, stopped: 0 } });
  const v = historyVerdict([...runs('PP'), csv, ...runs('PP')]);
  assert.deepEqual([v.kind, v.runs, v.failed], [null, 4, 0]);
});

test('only the last 10 runs are read', () => {
  assert.equal(historyVerdict([...runs('FPFPFPFP'), ...runs('PPPPPPPPPP')]).kind, null);
});
