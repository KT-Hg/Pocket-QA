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

const { runAll, writePlan, lastOf, runTally, BODY_HEAD } = await import('../apicases/run.js');

test('runAll: in order, each case sent with the variables as they are just before it', async () => {
  const vars = { base: 'https://a.test' };
  const sent = [];
  const seen = [];
  const cases = [
    { id: 'login', checks: [], extracts: [{ varName: 'token', from: 'json', path: 'token' }] },
    { id: 'me', checks: [] },
  ];
  const n = await runAll(cases, {
    getVars: async () => ({ ...vars }),
    send: async (c, v) => { sent.push([c.id, v.token]); return ok({ token: 'tok-1' })(); },
    onResult: async (c, r) => { await new Promise((res) => setTimeout(res, 5)); Object.assign(vars, r.saved); seen.push(c.id); },
  });
  assert.equal(n, 2);
  assert.deepEqual(sent, [['login', undefined], ['me', 'tok-1']], 'the token login saved reaches the request after it');
  assert.deepEqual(seen, ['login', 'me']);
});

test('runAll: stop lets the request on its way finish and sends no other; a delay between requests', async () => {
  let stop = false;
  const sent = [];
  const waits = [];
  const n = await runAll([{ id: 1, checks: [] }, { id: 2, checks: [] }, { id: 3, checks: [] }], {
    getVars: () => ({}),
    send: async (c) => { sent.push(c.id); if (c.id === 2) stop = true; return ok({})(); },
    onResult: () => {},
    shouldStop: () => stop,
    delayMs: 200,
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(n, 2);
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(waits, [200, 200], 'between requests, not before the first');
});

test('writePlan: requests that write, counted by method, with their host', () => {
  const get = { method: 'GET', url: 'https://a.test/x' };
  assert.equal(writePlan([get, { method: 'HEAD', url: 'https://a.test' }]), '', 'reads only: nothing to ask');
  const cases = [get, { method: 'DELETE', url: '${base}/u/1' }, { method: 'POST', url: '${base}/u' }, { method: 'POST', url: 'https://b.test/u' }];
  assert.equal(writePlan(cases, { base: 'https://a.test' }), 'Send 2 POST, 1 DELETE to a.test, b.test?');
  assert.equal(writePlan([{ method: 'PUT', url: '${later}/x' }]), 'Send 1 PUT?', 'a URL not filled in yet: no host');
});

test('lastOf: a summary to keep — body cut, secret values masked, no header', () => {
  const res = {
    status: 200, ms: 12, isJson: true, isBinary: false, json: { token: 'tok-9', user: { id: 7, password: 'pw' }, list: ['x'.repeat(3000)] },
    headers: [['set-cookie', 'sid=1']], sent: { method: 'GET', url: 'https://a.test/x?id=1&api_key=k1&token=t' },
  };
  const last = lastOf({ res, verdict: 'passed', failures: [] }, 5);
  assert.equal(last.at, 5);
  assert.equal(last.bodyHead.length, BODY_HEAD);
  assert.ok(last.bodyHead.startsWith('{\n  "token": "••••",\n  "user": {\n    "id": 7,\n    "password": "••••"'), last.bodyHead.slice(0, 80));
  assert.deepEqual(last.sent, { method: 'GET', url: 'https://a.test/x?id=1&api_key=••••&token=••••' });
  assert.ok(!JSON.stringify(last).includes('sid=1') && !JSON.stringify(last).includes('tok-9'));

  const down = lastOf({ res: { error: 'No response within 0.3 s', kind: 'timeout', ms: 300, sent: { method: 'GET', url: 'https://a.test' } },
    verdict: 'broken', failures: [{ kind: 'broken', reason: 'No response within 0.3 s' }] }, 6);
  assert.deepEqual(down, { at: 6, verdict: 'broken', status: null, ms: 300, failures: [{ kind: 'broken', reason: 'No response within 0.3 s' }],
    bodyHead: '', sent: { method: 'GET', url: 'https://a.test' } });
  assert.equal(lastOf({ res: { status: 200, isBinary: true, bytes: 9 }, verdict: 'passed', failures: [] }).bodyHead, '', 'bytes are not kept');
});

test('runTally: last results counted, with the latest time', () => {
  const t = runTally([{ last: { verdict: 'passed', at: 3 } }, { last: { verdict: 'failed', at: 9 } }, { last: { verdict: 'passed', at: 1 } }, {}]);
  assert.deepEqual(t, { passed: 2, failed: 1, broken: 0, notRun: 1, at: 9 });
});
