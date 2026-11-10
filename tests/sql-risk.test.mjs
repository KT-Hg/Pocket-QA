// The SQL page asks before a statement that changes a whole table runs. Nothing
// may send it before the person answers: not the 8 s watchdog while the rows of a
// big statement are still being read, not a capture that fails.
//
// Run:    node --test "tests/*.test.mjs"

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// chrome.storage answers once `gate` resolves — a capture as slow as the test wants.
let gate = Promise.resolve();
const local = {
  get: (keys, cb) => { gate.then(() => cb({})); },
  set: (obj, cb) => cb(),
};
globalThis.chrome = { storage: { local }, runtime: {} };
globalThis.fetch = async () => { throw new Error('offline'); };   // key discovery fails: "no key"

const { state } = await import('../dbtools/page-state.js');
const { wireSqlPage } = await import('../dbtools/capture-sql.js');

const flush = () => new Promise((r) => setImmediate(r));

/** An Adminer SQL page holding `sql`; `sent` counts submits that reached Adminer. */
function sqlPage(sql) {
  const form = {
    dataset: {},
    sent: 0,
    addEventListener(type, fn) { this.onsubmit = fn; },
    querySelector: () => ({ innerText: sql }),
    submit() { this.sent += 1; },
  };
  const textarea = { value: '', closest: () => form };
  globalThis.document = { querySelector: () => textarea };
  wireSqlPage();
  return form;
}

/** Record a session; the question resolves with whatever `answer(…)` is given. */
function recording() {
  const asked = [];
  state.on = true;
  state.session = { id: 's1' };
  state.settings = { captureSqlPage: true, prefetchLimit: 200 };
  state.ctx = { base: 'http://127.0.0.1/index.php', conn: 'sqlite=&db=t.db', engine: 'sqlite', key: 'k' };
  state.panel = {
    log() {}, notice() {},
    preview: (opts) => new Promise((resolve) => asked.push({ ...opts, answer: resolve })),
  };
  return asked;
}

test('the watchdog does not run a no-WHERE statement while a slow capture is still going', async () => {
  const asked = recording();
  let open;
  gate = new Promise((r) => { open = r; });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const form = sqlPage('UPDATE a SET x = 1 WHERE id > 0; DELETE FROM b');
    form.onsubmit({ submitter: null, preventDefault() {} });
    await flush();
    mock.timers.tick(9000);                 // past the watchdog, rows of `a` not read yet
    assert.equal(form.sent, 0, 'sent before the question was answered');

    open();                                 // the capture ends — now the question
    await flush();
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].summary.map((l) => `${l.op} ${l.table}`), ['delete b']);

    asked[0].answer(false);
    await flush();
    assert.equal(form.sent, 0, 'cancelled, yet it ran');
  } finally {
    mock.timers.reset();
  }
});

test('Run anyway sends it, once', async () => {
  const asked = recording();
  gate = Promise.resolve();
  const form = sqlPage('DELETE FROM b');
  form.onsubmit({ submitter: null, preventDefault() {} });
  await flush();
  asked[0].answer(true);
  await flush();
  assert.equal(form.sent, 1);
});

test('a capture that fails still asks', async () => {
  const asked = recording();
  const get = local.get;
  local.get = () => { throw new Error('Extension context invalidated.'); };
  try {
    const form = sqlPage('UPDATE a SET x = 1 WHERE id > 0; DELETE FROM b');
    form.onsubmit({ submitter: null, preventDefault() {} });
    await flush();
    assert.equal(asked.length, 1, 'ran without asking');
    asked[0].answer(false);
    await flush();
    assert.equal(form.sent, 0);
  } finally {
    local.get = get;
  }
});

test('nothing recording: a no-WHERE statement is still asked about', async () => {
  const asked = recording();
  state.session = null;
  const form = sqlPage('UPDATE b SET x = 1');
  form.onsubmit({ submitter: null, preventDefault() {} });
  await flush();
  assert.equal(asked.length, 1);
  asked[0].answer(false);
  await flush();
  assert.equal(form.sent, 0);
});
