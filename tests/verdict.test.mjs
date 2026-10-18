// A run's verdict from its failures: the first failure decides, a run that did
// not finish is never Passed.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { runVerdict, verdictLabel } = await import('../shared/verdict.js');

const assertFail = { index: 3, type: 'assert', kind: 'assert', reason: 'expected "Saved"' };
const broken     = { index: 2, type: 'click', kind: 'broken', reason: 'element not found' };

test('no failures: passed when the run finished, stopped when it did not', () => {
  assert.deepEqual(runVerdict([], { completed: true }), { status: 'passed', asserts: 0, broken: 0 });
  assert.deepEqual(runVerdict([], { completed: false }), { status: 'stopped', asserts: 0, broken: 0 });
  assert.equal(runVerdict(null, { completed: true }).status, 'passed');
  assert.equal(runVerdict(undefined).status, 'stopped', 'no completed flag: not known to have finished');
});

test('the first failure decides', () => {
  assert.equal(runVerdict([broken, assertFail], { completed: true }).status, 'broken');
  assert.equal(runVerdict([assertFail, broken], { completed: true }).status, 'failed');
  // Stopped with failures: the failure says more than the stop.
  assert.equal(runVerdict([assertFail], { completed: false }).status, 'failed');
  assert.equal(runVerdict([broken], { completed: false }).status, 'broken');
});

test('both kinds are counted', () => {
  assert.deepEqual(
    runVerdict([assertFail, broken, assertFail, broken, broken], { completed: true }),
    { status: 'failed', asserts: 2, broken: 3 },
  );
});

test('a failure without a kind (recorded before Assert existed) is broken', () => {
  const old = { index: 1, type: 'click', label: '', reason: 'element not found' };
  assert.deepEqual(runVerdict([old], { completed: true }), { status: 'broken', asserts: 0, broken: 1 });
  assert.equal(runVerdict([old, assertFail], { completed: true }).status, 'broken');
});

test('verdictLabel', () => {
  assert.equal(verdictLabel('passed'), '✓ Passed');
  assert.equal(verdictLabel('failed'), '✗ Failed');
  assert.equal(verdictLabel('broken'), '⚠ Test broken');
  assert.equal(verdictLabel('stopped'), '⏹ Stopped');
});

const { tallyVerdicts, tallyText } = await import('../shared/verdict.js');

test('tallyVerdicts: CSV rows by verdict; a row recorded before `completed` ran to its end', () => {
  assert.deepEqual(tallyVerdicts([
    { failures: [] },
    { failures: [assertFail] },
    { failures: [broken, assertFail] },
    { failures: [], completed: false },
    { failures: null },
  ]), { passed: 2, failed: 1, broken: 1, stopped: 1 });
  assert.deepEqual(tallyVerdicts([]), { passed: 0, failed: 0, broken: 0, stopped: 0 });
});

test('tallyText: passed always, the others when there are some', () => {
  assert.equal(tallyText({ passed: 12, failed: 2, broken: 1, stopped: 0 }), '12 passed · 2 failed · 1 broken');
  assert.equal(tallyText({ passed: 3, failed: 0, broken: 0, stopped: 1 }), '3 passed · 1 stopped');
  assert.equal(tallyText({ passed: 0, failed: 0, broken: 0, stopped: 0 }), '0 passed');
});
