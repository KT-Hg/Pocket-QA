// One turn of an API test case (apicases/run.js): send, check, verdict.
// Sending is a fake, so no network is needed.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { runCase } = await import('../apicases/run.js');

const ok = (json, fields = {}) => async () => ({
  status: 200, headers: [['content-type', 'application/json']], text: JSON.stringify(json), json, isJson: true, isBinary: false, ms: 5, ...fields,
});

test('all checks hold: passed', async () => {
  const r = await runCase({ checks: [{ on: 'json', path: 'id', op: 'equals', expected: '${want}' }] }, { want: '7' }, ok({ id: 7 }));
  assert.equal(r.verdict, 'passed');
  assert.deepEqual(r.failures, []);
  assert.equal(r.checks.length, 2, 'the default 2xx check and the case\'s own');
});

test('a false check: failed, with its message', async () => {
  const r = await runCase({ checks: [{ on: 'json', path: 'id', op: 'equals', expected: '8' }] }, {}, ok({ id: 7 }));
  assert.equal(r.verdict, 'failed');
  assert.deepEqual(r.failures, [{ kind: 'assert', reason: 'Expected id = "8", got 7' }]);
});

test('no response: broken; a check that cannot run: broken', async () => {
  const down = await runCase({ checks: [] }, {}, async () => ({ error: 'Could not connect', kind: 'network' }));
  assert.equal(down.verdict, 'broken');
  assert.deepEqual(down.failures, [{ kind: 'broken', reason: 'Could not connect' }]);
  const html = await runCase({ checks: [{ on: 'json', path: 'id', op: 'exists' }] }, {}, ok(undefined, { isJson: false, text: '<p>' }));
  assert.equal(html.verdict, 'broken');
});

test('the first failure decides: a 500 that also is not JSON is failed', async () => {
  const r = await runCase({ checks: [{ on: 'json', path: 'id', op: 'exists' }] }, {}, ok(undefined, { status: 500, isJson: false, text: 'oops' }));
  assert.equal(r.verdict, 'failed', 'the status check comes first and is false');
  assert.equal(r.failures.length, 2);
});

test('the case and variables reach send', async () => {
  let seen;
  const c = { url: '${base}/x', checks: [] };
  await runCase(c, { base: 'https://a.test' }, async (req, vars) => { seen = [req, vars]; return ok({})(); });
  assert.equal(seen[0], c);
  assert.deepEqual(seen[1], { base: 'https://a.test' });
});

test('values to save come back, and one not found makes the turn broken', async () => {
  const c = { checks: [], extracts: [{ varName: 'token', from: 'json', path: 'access_token' }, { varName: 'uid', from: 'json', path: 'user.id' }] };
  const good = await runCase(c, {}, ok({ access_token: 'tok-1', user: { id: 7 } }));
  assert.deepEqual(good.saved, { token: 'tok-1', uid: '7' });
  assert.equal(good.verdict, 'passed');
  const half = await runCase(c, {}, ok({ access_token: 'tok-1' }));
  assert.deepEqual(half.saved, { token: 'tok-1' }, 'what was found is still saved');
  assert.equal(half.verdict, 'broken');
  assert.deepEqual(half.failures, [{ kind: 'broken', reason: 'Could not save uid: user.id not found' }]);
  const down = await runCase(c, {}, async () => ({ error: 'x', kind: 'network' }));
  assert.deepEqual(down.saved, {}, 'no response: nothing saved');
});
