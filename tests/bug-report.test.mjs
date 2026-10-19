// The bug report of a run (shared/bug-report.js): Markdown from lastRun — the
// failure, the page, the steps that led to it, the environment — with typed
// values hidden unless asked for.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.TZ = 'UTC';
const { stepText, buildBugReport } = await import('../shared/bug-report.js');

const sel = (css, extra) => ({ selector: css, selectors: { css, ...extra } });
const AT = Date.UTC(2026, 9, 18, 14, 3, 5);
const ENV = { browser: 'Chrome 141', os: 'Windows', version: '1.0.24' };

test('every action type the form offers has a sentence of its own', () => {
  const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
  const select = html.slice(html.indexOf('<select id="manualActionType">'), html.indexOf('</select>', html.indexOf('<select id="manualActionType">')));
  const types = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(types.length >= 17, types.join());
  for (const type of types) assert.doesNotMatch(stepText({ type, ...sel('#x') }), /^Unknown step/, type);
  assert.match(stepText({ type: 'zzz' }), /^Unknown step "zzz"/);
});

test('step sentences name the element by its text, else its selector', () => {
  assert.equal(stepText({ type: 'click', ...sel('#login', { text: 'Sign in' }) }), 'Click "Sign in" (`#login`)');
  assert.equal(stepText({ type: 'click', ...sel('#go'), label: 'Go on' }), 'Click `#go` — Go on');
  assert.equal(stepText({ type: 'input', ...sel('#email'), value: 'ann@x.io' }, { showValues: true }), 'Type "ann@x.io" into `#email`');
  assert.equal(stepText({ type: 'navigate', url: 'https://example.com/login' }), 'Go to https://example.com/login');
  assert.equal(stepText({ type: 'wait', delay: 700 }), 'Wait 700 ms');
  assert.equal(stepText({ type: 'assert', conditionType: 'textEquals', ...sel('#toast'), expectedValue: 'Saved' }),
    'Check that the text of `#toast` is "Saved"');
  assert.equal(stepText({ type: 'condition', conditionType: 'urlContains', expectedValue: '/done', skipCount: 2 }),
    'If the URL contains "/done" (otherwise skip the next 2)');
  assert.equal(stepText({ type: 'readdom', ...sel('#total'), varName: 'total' }), 'Read `#total` into `${total}`');
  assert.equal(stepText({ type: 'dropdown', ...sel('#size'), pick: { by: 'index', index: '2' } }), 'Open the dropdown `#size` and choose item #2');
});

test('with values hidden, nothing typed, uploaded or scripted shows; variable names do', () => {
  const S = 'S3CRET';
  const steps = [
    { type: 'input', ...sel('#pw'), value: `${S}` },
    { type: 'input', ...sel('#who'), value: `Hi ${S} \${user}` },
    { type: 'uploadFile', ...sel('#file'), folderPath: `C:\\${S}`, fileNames: [`${S}.pdf`, '${doc}'] },
    { type: 'script', code: `localStorage.token = "${S}"` },
    { type: 'assert', conditionType: 'valueEquals', ...sel('#pw'), expectedValue: S },
  ];
  const hidden = steps.map((a) => stepText(a));
  assert.ok(hidden.every((t) => !t.includes(S)), hidden.join('\n'));
  assert.ok(hidden[1].includes('${user}') && hidden[2].includes('${doc}'), 'variable names stay');
  const shown = steps.map((a) => stepText(a, { showValues: true }));
  assert.ok(shown.every((t) => t.includes(S)), shown.join('\n'));
});

// A run like the e2e test's: a click, a false Assert, a click that breaks.
const lastRun = {
  scenarioId: 's1', scenarioName: 'Checkout', startedAt: AT - 9_000, endedAt: AT, loops: 3, completed: true,
  verdict: { status: 'failed', asserts: 1, broken: 1 },
  actions: [
    { type: 'click', ...sel('#login', { text: 'Sign in' }) },
    { type: 'condition', conditionType: 'elementExists', ...sel('#promo'), skipCount: 1 },
    { type: 'click', ...sel('#closePromo') },
    { type: 'input', ...sel('#coupon'), value: 'SAVE10 ${code}' },
    { type: 'assert', conditionType: 'textEquals', ...sel('#toast'), expectedValue: 'Saved', label: 'Toast' },
    { type: 'click', ...sel('#pay') },
  ],
  failures: [
    { index: 5, type: 'assert', label: 'Toast', reason: 'Expected text "Saved", got "Error *500*"', kind: 'assert',
      expected: 'Saved', actual: 'Error *500*', url: 'https://shop.test/cart?id=7', at: AT - 2_000, loop: 2, trace: [0, 1, 3, 4] },
    { index: 6, type: 'click', label: '', reason: 'Element not found' },
  ],
};
const report = buildBugReport(lastRun, { env: ENV, shotName: 'pocketqa-bug-Checkout.jpg', vars: { code: 'X1' } });

test('the report: title, failure, page, when, run, environment', () => {
  const head = report.split('\n').slice(0, 8).join('\n');
  assert.equal(head, [
    '## ✗ Failed — Checkout, step #5',
    '',
    '- **Failure:** ✗ #5 Toast — Expected text "Saved", got "Error \\*500\\*"',
    '- **Page:** https://shop.test/cart?id=7',
    '- **When:** 2026-10-18 14:03:03 · loop 2 of 3',
    '- **Result:** ✗ Failed — 1 check failed · 1 step broken',
    '- **Environment:** Chrome 141 · Windows · Pocket QA 1.0.24',
    '',
  ].join('\n'));
});

test('the steps are those run, in order, up to the failed one', () => {
  const steps = report.slice(report.indexOf('### Steps to reproduce'), report.indexOf('### Other failures'));
  assert.equal(steps.trim(), [
    '### Steps to reproduce',
    '',
    '1. Click "Sign in" (`#login`)',
    '2. If `#promo` exists (otherwise skip the next 1)',
    '3. Type •••`${code}` into `#coupon`',
    '4. ✗ Check that the text of `#toast` is "Saved" — Toast',
  ].join('\n'));
  assert.ok(!report.includes('closePromo'), 'the step the Condition skipped is not listed');
});

test('page text keeps its # — it only makes a heading at a line\'s start', () => {
  const r = buildBugReport({ ...lastRun, failures: [{ ...lastRun.failures[0], reason: 'Expected text "Saved", got "Order #1042"' }] }, { env: ENV });
  assert.ok(r.includes('got "Order #1042"'), r.split('\n')[2]);
});

test('other failures, the variables the steps use, the screenshot', () => {
  assert.ok(report.includes('### Other failures in this run\n\n- ⚠ #6 click — Element not found'));
  assert.ok(report.includes('### Variables\n\n- `code` = •••'));
  assert.ok(report.includes('### Screenshot\n\nAttached: `pocketqa-bug-Checkout.jpg` — the page when step #5 failed.'));
  const shown = buildBugReport(lastRun, { env: ENV, showValues: true, vars: { code: 'X1' } });
  assert.ok(shown.includes('3. Type "SAVE10 ${code}" into `#coupon`') && shown.includes('- `code` = `X1`'));
  assert.ok(shown.includes('### Screenshot\n\n_No screenshot'));
});

test('without a trace (an older run), the steps as defined, up to the failed one, said so', () => {
  const { trace, ...first } = lastRun.failures[0];
  const old = buildBugReport({ ...lastRun, failures: [first] }, { env: ENV });
  const steps = old.slice(old.indexOf('### Steps to reproduce'));
  assert.ok(steps.includes('_Steps as defined in the scenario, not as run._'));
  assert.ok(steps.includes('3. Click `#closePromo`') && steps.includes('5. ✗ Check that'));
  assert.ok(!steps.includes('#pay'));
});

test('a failure inside another scenario is told by the Switch that ran it', () => {
  const nested = {
    ...lastRun,
    actions: [{ type: 'click', ...sel('#a') }, { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: 'other', scenarioName: 'Pay' }] }],
    failures: [{ index: 3, type: 'click', label: '', reason: 'Element not found', url: 'https://shop.test/', at: AT, loop: 1, trace: [0, 1] }],
  };
  const r = buildBugReport(nested, { env: ENV });
  assert.ok(r.includes('2. ⚠ Run the scenario "Pay" — it failed at its step #3'), r);
  // Its step #2, under a Switch that is step #2 too: the run's `nested` flag tells.
  const same = { ...nested, failures: [{ ...nested.failures[0], index: 2, nested: true }] };
  assert.ok(buildBugReport(same, { env: ENV }).includes('2. ⚠ Run the scenario "Pay" — it failed at its step #2'));
});
