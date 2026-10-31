// Reading an API response (shared/api-response.js): JSON paths both ways, each
// kind of check passing and failing, what cannot be checked (broken), and the
// values a case saves into variables.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { jsonPath, parsePath, pathOf, runChecks, extractValues, statusMatches, checkLabel, headerValue } =
  await import('../shared/api-response.js');

const BODY = {
  data: { id: 42, status: 'PAID', items: [{ id: 'a1', price: 9.5 }, { id: 'a2', price: 0 }], tags: ['admin', 'beta'], note: null, ok: true },
  'x.y': { '[odd]': 'yes' },
  '': 'empty key',
  0: 'zero key',
};
/** A response as sendRequest resolves it. */
const res = (fields = {}) => ({
  status: 200, headers: [['content-type', 'application/json; charset=utf-8'], ['x-request-id', 'r-1']],
  text: JSON.stringify(BODY), json: BODY, isJson: true, isBinary: false, ms: 120, ...fields,
});

test('jsonPath: keys, indexes, negative indexes, length, quoted keys', () => {
  assert.deepEqual(jsonPath(BODY, 'data.id'), { found: true, value: 42 });
  assert.deepEqual(jsonPath(BODY, 'data.items[1].id'), { found: true, value: 'a2' });
  assert.deepEqual(jsonPath(BODY, 'data.items[-1].price'), { found: true, value: 0 });
  assert.deepEqual(jsonPath(BODY, 'data.items.length'), { found: true, value: 2 });
  assert.deepEqual(jsonPath(BODY, 'data.status.length'), { found: true, value: 4 });
  assert.deepEqual(jsonPath(BODY, '["x.y"]["[odd]"]'), { found: true, value: 'yes' });
  assert.deepEqual(jsonPath(BODY, 'data.note'), { found: true, value: null }, 'null is there, not missing');
  assert.deepEqual(jsonPath(BODY, '$.data.ok'), { found: true, value: true }, 'a JSONPath-style $ is allowed');
  assert.deepEqual(jsonPath(BODY, '').value, BODY, 'an empty path is the whole body');
  assert.deepEqual(jsonPath([1, 2, 3], '[0]'), { found: true, value: 1 });
});

test('jsonPath: missing, inherited, malformed', () => {
  assert.deepEqual(jsonPath(BODY, 'data.missing'), { found: false });
  assert.deepEqual(jsonPath(BODY, 'data.items[5]'), { found: false });
  assert.deepEqual(jsonPath(BODY, 'data.id.x'), { found: false });
  assert.deepEqual(jsonPath(BODY, 'data.constructor'), { found: false }, 'never an inherited property');
  assert.deepEqual(jsonPath(BODY, '__proto__'), { found: false });
  for (const bad of ['data..id', '.data', 'data.', 'data[x]', 'data[0', '["open]', 'data[0]id']) {
    assert.ok(jsonPath(BODY, bad).error, `${bad} is malformed`);
  }
});

test('pathOf writes what jsonPath reads back', () => {
  assert.equal(pathOf(['data', 'items', 0, 'id']), 'data.items[0].id');
  assert.equal(pathOf(['x.y', '[odd]']), '["x.y"]["[odd]"]');
  for (const segs of [['data', 'items', -1, 'price'], ['x.y', '[odd]'], [''], ['0'], ['data', 'tags', 1], ['a b"c'], ['$x']]) {
    const obj = { data: BODY.data, 'x.y': BODY['x.y'], '': 'e', 0: 'z', 'a b"c': 'q', $x: 'd' };
    const viaPath = jsonPath(obj, pathOf(segs));
    const direct = segs.reduce((o, s) => (typeof s === 'number' && Array.isArray(o) ? o.at(s) : o[s]), obj);
    assert.deepEqual(viaPath, { found: true, value: direct }, `${JSON.stringify(segs)} → ${pathOf(segs)}`);
  }
  assert.deepEqual(parsePath('["a\\"b"]').segs, ['a"b'], 'an escaped quote inside a quoted key');
});

test('statusMatches: exact, class, list, not-class', () => {
  assert.equal(statusMatches(201, '201'), true);
  assert.equal(statusMatches(204, '2xx'), true);
  assert.equal(statusMatches(404, '200, 201'), false);
  assert.equal(statusMatches(201, '200,201'), true);
  assert.equal(statusMatches(404, 'not5xx'), true);
  assert.equal(statusMatches(503, 'not 5xx'), false);
  assert.equal(statusMatches(200, 'ok'), null, 'not a status pattern');
});

const one = (r, check, vars) => runChecks(r, [check], vars).at(-1);

test('runChecks: no status check of its own → 2xx is checked first', () => {
  const [def, own] = runChecks(res({ status: 500 }), [{ on: 'json', path: 'data.id', op: 'exists' }]);
  assert.equal(def.label, 'status is 2xx (default)');
  assert.equal(def.ok, false);
  assert.equal(def.message, 'Expected status 2xx, got 500');
  assert.equal(own.ok, true);
  assert.equal(runChecks(res(), []).length, 1, 'no checks at all: the default alone');
  const withStatus = runChecks(res({ status: 404 }), [{ on: 'status', op: 'is', expected: '404' }]);
  assert.equal(withStatus.length, 1, 'a status check of its own replaces the default');
  assert.equal(withStatus[0].ok, true);
});

test('runChecks: json checks pass and fail with readable messages', () => {
  const r = res();
  assert.equal(one(r, { on: 'json', path: 'data.status', op: 'equals', expected: 'PAID' }).ok, true);
  const f = one(r, { on: 'json', path: 'data.status', op: 'equals', expected: 'PENDING' });
  assert.equal(f.kind, 'assert');
  assert.equal(f.message, 'Expected data.status = "PENDING", got "PAID"');
  assert.equal(one(r, { on: 'json', path: 'data.id', op: 'equals', expected: '42' }).ok, true, 'a number equals its text');
  assert.equal(one(r, { on: 'json', path: 'data.ok', op: 'equals', expected: 'true' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.note', op: 'equals', expected: 'null' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.items[0]', op: 'equals', expected: '{ "price": 9.5, "id": "a1" }' }).ok, false, 'key order counts in JSON text');
  assert.equal(one(r, { on: 'json', path: 'data.items[0]', op: 'equals', expected: '{"id":"a1","price":9.5}' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.tags', op: 'contains', expected: 'admin' }).ok, true, 'an array contains an element');
  assert.equal(one(r, { on: 'json', path: 'data.tags', op: 'contains', expected: 'adm' }).ok, false, 'an element, not part of one');
  assert.equal(one(r, { on: 'json', path: 'data.status', op: 'contains', expected: 'AI' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.items.length', op: 'gt', expected: '0' }).ok, true);
  const lt = one(r, { on: 'json', path: 'data.items[0].price', op: 'lt', expected: '5' });
  assert.equal(lt.message, 'Expected data.items[0].price < 5, got 9.5');
  assert.equal(one(r, { on: 'json', path: 'data.status', op: 'gt', expected: '1' }).kind, 'assert', 'text is not greater than a number');
  assert.equal(one(r, { on: 'json', path: 'data.id', op: 'exists' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.error', op: 'notExists' }).ok, true);
  assert.equal(one(r, { on: 'json', path: 'data.id', op: 'notExists' }).message, 'Expected data.id not to exist, got 42');
  assert.equal(one(r, { on: 'json', path: 'data.gone', op: 'equals', expected: 'x' }).message, 'Expected data.gone = "x", but data.gone is not there');
});

test('runChecks: what cannot be checked is broken, not failed', () => {
  const html = res({ text: '<html>', json: undefined, isJson: false });
  assert.equal(one(html, { on: 'json', path: 'data.id', op: 'exists' }).kind, 'broken');
  assert.equal(one(html, { on: 'json', path: 'data.id', op: 'exists' }).message, 'The response is not JSON');
  assert.equal(one(res(), { on: 'json', path: 'data..id', op: 'exists' }).kind, 'broken');
  assert.equal(one(res(), { on: 'json', path: 'data.id', op: 'gt', expected: 'abc' }).kind, 'broken');
  assert.equal(one(res(), { on: 'status', op: 'is', expected: 'ok' }).kind, 'broken');
  assert.equal(one(res(), { on: 'time', op: 'lt', expected: 'fast' }).kind, 'broken');
  assert.equal(one(res(), { on: 'nope', op: 'x' }).kind, 'broken');
  const bin = res({ isBinary: true, isJson: false, json: undefined, text: '' });
  assert.equal(one(bin, { on: 'body', op: 'contains', expected: 'x' }).kind, 'broken');
  assert.equal(one(bin, { on: 'status', op: 'is', expected: '200' }).ok, true, 'status still checks a binary response');
});

test('runChecks: header, body, time; ${variables} in expected', () => {
  const r = res();
  assert.equal(one(r, { on: 'header', path: 'Content-Type', op: 'contains', expected: 'JSON' }).ok, true, 'any case, name and value');
  assert.equal(one(r, { on: 'header', path: 'x-request-id', op: 'equals', expected: 'r-1' }).ok, true);
  assert.equal(one(r, { on: 'header', path: 'x-missing', op: 'exists' }).message, 'Expected a x-missing header');
  assert.equal(one(r, { on: 'body', op: 'contains', expected: '"PAID"' }).ok, true);
  assert.equal(one(r, { on: 'body', op: 'notContains', expected: 'error' }).ok, true);
  assert.equal(one(r, { on: 'time', op: 'lt', expected: '100' }).message, 'Expected under 100 ms, took 120 ms');
  const v = one(r, { on: 'json', path: 'data.status', op: 'equals', expected: '${want}' }, { want: 'PAID' });
  assert.equal(v.ok, true);
  assert.equal(v.label, 'data.status = PAID', 'the label shows the value used');
  assert.equal(one(r, { on: 'json', path: 'data.status', op: 'equals', expected: '${nope}' }).message, 'No value for ${nope}');
  assert.equal(headerValue(r, 'X-REQUEST-ID'), 'r-1');
});

test('checkLabel', () => {
  assert.equal(checkLabel({ on: 'status', op: 'is', expected: '201' }), 'status is 201');
  assert.equal(checkLabel({ on: 'json', path: 'a.b', op: 'notExists' }), 'a.b does not exist');
  assert.equal(checkLabel({ on: 'json', path: 'n', op: 'gt', expected: '0' }), 'n > 0');
  assert.equal(checkLabel({ on: 'header', path: 'etag', op: 'exists' }), 'header etag exists');
  assert.equal(checkLabel({ on: 'time', op: 'lt', expected: '500' }), 'time < 500 ms');
});

test('extractValues: JSON, header, status, body pattern, and what is missing', () => {
  const r = res({ text: 'token=abc123; expires=60' });
  const { values, problems } = extractValues({ ...r, json: BODY, isJson: true }, [
    { varName: 'orderId', from: 'json', path: 'data.id' },
    { varName: '${firstItem}', from: 'json', path: 'data.items[0]' },
    { varName: 'reqId', from: 'header', path: 'X-Request-Id' },
    { varName: 'code', from: 'status' },
    { varName: '', from: 'body', path: 'token=${token}; expires=${ttl}' },
    { varName: 'gone', from: 'json', path: 'data.nothing' },
    { varName: '', from: 'status' },
  ]);
  assert.deepEqual(values, { orderId: '42', firstItem: '{"id":"a1","price":9.5}', reqId: 'r-1', code: '200', token: 'abc123', ttl: '60' });
  assert.deepEqual(problems, [{ varName: 'gone', reason: 'data.nothing not found' }, { varName: '', reason: 'No variable name' }]);

  const whole = extractValues(res({ text: 'plain body', isJson: false, json: undefined }), [{ varName: 'b', from: 'body', path: '' }]);
  assert.deepEqual(whole.values, { b: 'plain body' });
  const nomatch = extractValues(res({ text: 'nothing here' }), [{ from: 'body', path: 'id=${id}' }]);
  assert.equal(nomatch.problems[0].reason, 'The body does not match id=${id}');
  assert.equal(extractValues(res({ isJson: false, json: undefined }), [{ varName: 'x', from: 'json', path: 'a' }]).problems[0].reason, 'The response is not JSON');
});
