/**
 * verdict.js — what a run (or a CSV row) came to, from its failures.
 *
 * Each failure has a `kind`: `assert` (an Assert found the page wrong) or
 * `broken` (the test itself could not do a step — element not found, a script
 * error). The first failure decides, being most often the cause of the rest: a
 * click that broke makes the Assert after it fail too, and that is a broken test,
 * not a failing app. A failure recorded before Assert existed has no kind and is
 * `broken`. With no failure, a run that did not reach its end (Stop, tab closed)
 * is `stopped`, never `passed`.
 *
 * Pure — no chrome.*.
 */

const LABELS = {
  passed:  '✓ Passed',
  failed:  '✗ Failed',
  broken:  '⚠ Test broken',
  stopped: '⏹ Stopped',
};

export function runVerdict(failures, { completed = false } = {}) {
  const list = failures || [];
  const asserts = list.filter((f) => f?.kind === 'assert').length;
  const broken = list.length - asserts;
  let status;
  if (list.length) status = list[0]?.kind === 'assert' ? 'failed' : 'broken';
  else status = completed ? 'passed' : 'stopped';
  return { status, asserts, broken };
}

export function verdictLabel(status) {
  return LABELS[status] || '';
}

/** A CSV run's row record — one written before rows kept `completed` ran to its end. */
export function rowVerdict(row) {
  return runVerdict(row.failures, { completed: row.completed !== false }).status;
}

/** CSV rows counted by verdict. */
export function tallyVerdicts(rows) {
  const tally = { passed: 0, failed: 0, broken: 0, stopped: 0 };
  for (const row of rows) tally[rowVerdict(row)]++;
  return tally;
}

/** "12 passed · 2 failed · 1 broken": passed always, the others when there are some. */
export function tallyText({ passed, failed, broken, stopped }) {
  return [`${passed} passed`, failed && `${failed} failed`, broken && `${broken} broken`, stopped && `${stopped} stopped`]
    .filter(Boolean).join(' · ');
}
