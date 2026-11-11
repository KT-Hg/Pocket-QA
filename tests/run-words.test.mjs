// The run in words and as a fraction (bg/run-panel.js): what the page's run panel
// and the popup's run line both show, for each kind of run.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFraction, runWords } from '../bg/run-panel.js';

const scenario = (o = {}) => ({ kind: 'scenario', scenario: 'Checkout', from: '', step: 3, steps: 8, loop: 1, loops: 1, paused: false, waiting: false, ...o });

test('one scenario: its name and the step; the bar is how far through it', () => {
  assert.deepEqual(runWords(scenario()), { head: 'Checkout', counter: 'step 3/8' });
  assert.equal(runFraction(scenario()), 3 / 8);
});

test('loops, a Switch, a pause', () => {
  assert.deepEqual(runWords(scenario({ loop: 2, loops: 3 })), { head: 'Checkout · loop 2/3', counter: 'step 3/8' });
  assert.equal(runFraction(scenario({ loop: 2, loops: 3 })), (1 + 3 / 8) / 3);
  assert.equal(runWords(scenario({ from: 'Checkout', scenario: 'Login (admin)' })).head, 'Checkout → Login (admin)');
  assert.equal(runWords(scenario({ paused: true })).counter, 'step 3 failed');
});

test('a sequence and a CSV run count their items; between two, "next…" and the item done', () => {
  const seq = scenario({ kind: 'sequence', scenario: 'Search', item: 3, items: 4, step: 5, steps: 5 });
  assert.deepEqual(runWords(seq), { head: 'Sequence 3/4 · Search', counter: 'step 5/5' });
  assert.equal(runFraction(seq), 3 / 4);
  const csv = scenario({ kind: 'csv', item: 4, items: 20, waiting: true });
  assert.deepEqual(runWords(csv), { head: 'CSV row 4/20 · Checkout', counter: 'next…' });
  assert.equal(runFraction(csv), 4 / 20);
});

test('no name: "Scenario"', () => {
  assert.equal(runWords(scenario({ scenario: '' })).head, 'Scenario');
});
