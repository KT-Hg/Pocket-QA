// e2e --changed (tools/e2e/changed.mjs): which suites a set of edited files runs.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { suitesFor } = await import('../tools/e2e/changed.mjs');

const SUITES = ['locate', 'run', 'editor', 'vars', 'record', 'export', 'export-run', 'csv', 'api', 'pages'];
const run = (...paths) => suitesFor(paths, SUITES).suites;

test('a file of one area runs its suites, in suite order', () => {
  assert.deepEqual(run('popup/csv/csv-state.js'), ['run', 'csv']);
  assert.deepEqual(run('apicases/model.js'), ['api']);
  assert.deepEqual(run('sqlcases/i18n/vi.js', 'apicases/model.js'), ['api', 'pages']);
  assert.deepEqual(run('popup/export-selenium.js'), ['export', 'export-run']);
  assert.deepEqual(run('popup/record/recorder.js'), ['record']);
  assert.deepEqual(run('popup/record/insert-point.js'), ['editor', 'vars']);
  assert.deepEqual(run('popup/run/run-history.js', 'shared/run-history.js'), ['run', 'record']);
});

test('a suite file runs itself; the runner and harness run everything', () => {
  assert.deepEqual(run('tools/e2e/api.mjs'), ['api']);
  assert.deepEqual(run('tools/e2e/export-run.mjs'), ['export-run']);
  assert.deepEqual(run('tools/e2e/harness.mjs'), SUITES);
  assert.deepEqual(run('tools/e2e.mjs'), SUITES);
});

test('playback, the manifest and a file no rule knows run everything', () => {
  assert.deepEqual(run('manifest.json'), SUITES);
  assert.deepEqual(run('bg/playback.js'), SUITES);
  assert.deepEqual(run('content.js'), SUITES);
  assert.deepEqual(run('bg/run-panel.js'), SUITES);
  assert.deepEqual(run('somewhere/new.js'), SUITES);
  assert.deepEqual(run('apicases/model.js', 'shared/storage-keys.js'), SUITES);
});

test('docs, tests and the other tools run nothing', () => {
  assert.deepEqual(run('README.md', 'docs/ideas/x.md', 'tests/playback.test.mjs', 'tasks/plan-18.md'), []);
  assert.deepEqual(run('tools/pack.mjs', 'tools/verify.mjs', 'tools/e2e/changed.mjs'), []);
  assert.deepEqual(run(), []);
});

test('why names each file with what it runs', () => {
  const { why } = suitesFor(['README.md', 'popup/csv/csv-state.js', 'manifest.json'], SUITES);
  assert.deepEqual(why, [['README.md', []], ['popup/csv/csv-state.js', ['csv', 'run']], ['manifest.json', 'all']]);
});
