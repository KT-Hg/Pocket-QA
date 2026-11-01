// Postman Collection v2.1 (apicases/postman-export.js): what a folder becomes,
// secrets left out, and test scripts that pass and fail as the page's checks
// do — each script is run here with a fake `pm`.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const X = await import('../apicases/postman-export.js');
const { checkLabel, runChecks, extractValues } = await import('../shared/api-response.js');
const { normalizeState } = await import('../apicases/model.js');

/** The test script `lines` run against `res` as Postman would: { results: [{ name, ok, message }], env }. */
function runScript(lines, res, vars = {}) {
  const results = [];
  const env = {};
  const find = (n) => (res.headers || []).find(([k]) => k.toLowerCase() === n.toLowerCase());
  const pm = {
    test(name, fn) {
      try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, message: e.message }); }
    },
    expect: (v, message) => ({ to: { be: { get true() { if (v !== true) throw new Error(message); return true; } } } }),
    response: {
      code: res.status,
      responseTime: res.ms,
      text: () => res.text,
      json: () => JSON.parse(res.text),
      headers: { get: (n) => find(n)?.[1] },
    },
    environment: { set: (k, v) => { env[k] = v; } },
    variables: { replaceIn: (s) => s.replace(/\{\{([^}]+)\}\}/g, (m, k) => vars[k] ?? m) },
  };
  new Function('pm', lines.join('\n'))(pm);
  return { results, env };
}

const response = (status, body, { headers = [], ms = 40 } = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let json; let isJson = false;
  try { json = JSON.parse(text); isJson = true; } catch { /* not JSON */ }
  return { status, text, json, isJson, isBinary: false, ms, headers: [['content-type', isJson ? 'application/json' : 'text/html'], ...headers] };
};

const ORDER = { data: { status: 'PAID', total: 12.5, items: [{ id: 1 }, { id: 7, tags: ['a', 'b'] }], 'x.y': true, none: null } };

const CHECKS = [
  { on: 'json', path: 'data.status', op: 'equals', expected: 'PAID' },
  { on: 'json', path: 'data.status', op: 'equals', expected: 'PENDING' },
  { on: 'json', path: 'data.items[-1].id', op: 'equals', expected: '7' },
  { on: 'json', path: 'data.items[-1].id', op: 'equals', expected: '${want}' },
  { on: 'json', path: 'data.items', op: 'contains', expected: '{"id":1}' },
  { on: 'json', path: 'data.items[1].tags', op: 'contains', expected: 'c' },
  { on: 'json', path: 'data["x.y"]', op: 'exists' },
  { on: 'json', path: 'data.none', op: 'exists' },
  { on: 'json', path: 'data.gone', op: 'notExists' },
  { on: 'json', path: 'data.gone.deeper', op: 'equals', expected: '1' },
  { on: 'json', path: 'data.items.length', op: 'gt', expected: '1' },
  { on: 'json', path: 'data.total', op: 'lt', expected: '10' },
  { on: 'json', path: 'data.total', op: 'gt', expected: 'ten' },
  { on: 'json', path: 'data..x', op: 'exists' },
  { on: 'header', path: 'X-Trace', op: 'exists' },
  { on: 'header', path: 'content-type', op: 'contains', expected: 'JSON' },
  { on: 'header', path: 'Content-Type', op: 'equals', expected: 'text/html' },
  { on: 'body', op: 'contains', expected: '"PAID"' },
  { on: 'body', op: 'notContains', expected: 'PAID' },
  { on: 'time', op: 'lt', expected: '1000' },
  { on: 'time', op: 'lt', expected: '10' },
];

test('test script: every check passes and fails as the page\'s does, with its message', () => {
  const vars = { want: '7' };
  for (const res of [response(200, ORDER), response(500, ORDER), response(200, '<p>not json</p>')]) {
    const page = runChecks(res, CHECKS, vars);
    const { results } = runScript(X.testScript({ checks: CHECKS, extracts: [] }), res, vars);
    assert.equal(results.length, page.length);
    page.forEach((p, i) => {
      assert.equal(results[i].ok, p.ok, `${p.label} on ${res.status} ${res.isJson ? 'JSON' : 'HTML'}`);
      assert.equal(results[i].name, checkLabel({ ...p.check, expected: X.toPm(p.check.expected) }));
    });
  }
  const page = runChecks(response(500, ORDER), CHECKS.slice(0, 3));
  const { results } = runScript(X.testScript({ checks: CHECKS.slice(0, 3) }), response(500, ORDER));
  assert.deepEqual(results.map((r) => r.message || ''), page.map((p) => p.message || ''), 'the same failure messages');
});

test('test script: the status checks, the default 2xx one when there is none', () => {
  const run = (checks, status) => runScript(X.testScript({ checks }), response(status, {})).results.map((r) => r.ok);
  assert.deepEqual(run([], 201), [true]);
  assert.deepEqual(run([], 404), [false]);
  for (const [expected, status, ok] of [['201', 201, true], ['200,201', 204, false], ['not5xx', 404, true], ['4xx', 404, true]]) {
    assert.deepEqual(run([{ on: 'status', op: 'is', expected }], status), [ok], `${expected} on ${status}`);
  }
  assert.deepEqual(runScript(X.testScript({ checks: [{ on: 'status', op: 'is', expected: 'ok' }] }), response(200, {})).results[0].message,
    'Status check "ok": write 200, 2xx, 200,201 or not5xx');
});

test('test script: saved values go to pm.environment, as the page saves them', () => {
  const extracts = [
    { varName: 'token', from: 'json', path: 'token' },
    { varName: 'user', from: 'json', path: 'user' },
    { varName: 'trace', from: 'header', path: 'x-trace' },
    { varName: 'code', from: 'status' },
    { from: 'body', path: 'abc${a} ${b}' },
    { varName: 'gone', from: 'json', path: 'nope' },
  ];
  const res = response(200, { token: 't-1', user: { id: 3 }, note: 'abc154 155' }, { headers: [['X-Trace', 'tr-9']] });
  const { results, env } = runScript(X.testScript({ checks: [], extracts }), res);
  const page = extractValues(res, extracts);
  assert.deepEqual(env, page.values);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, true, true, false]);
  assert.equal(results.at(-1).message, page.problems[0].reason);
});

test('test script: its first line keeps the checks and saved values as the page has them', () => {
  const lineSep = String.fromCharCode(0x2028);
  const c = { checks: [{ on: 'json', path: 'a', op: 'equals', expected: `\${x}${lineSep}` }], extracts: [{ varName: 't', from: 'status' }], timeoutMs: 300 };
  const [first] = X.testScript(c);
  assert.ok(first.startsWith(X.MARKER) && !first.includes(lineSep));
  assert.deepEqual(JSON.parse(first.slice(X.MARKER.length)), c);
  assert.deepEqual(JSON.parse(X.testScript({ checks: [], extracts: [], timeoutMs: 30_000 })[0].slice(X.MARKER.length)), { checks: [], extracts: [] },
    'the default timeout is not written');
});

test('jsAccess: a JSON path as script code', () => {
  assert.equal(X.jsAccess('data.items[-1].id'), 'pm.response.json()?.data?.items?.at(-1)?.id');
  assert.equal(X.jsAccess('$.a["x.y"][0]'), 'pm.response.json()?.a?.["x.y"]?.[0]');
  assert.equal(X.jsAccess(''), 'pm.response.json()');
  assert.equal(X.jsAccess('a..b'), null);
});

/** Two folders: Shop (Bearer ${token}) with a login, an order and a form post; Other with a literal API key. */
function shopState() {
  return normalizeState({
    folders: [
      { id: 'shop', name: 'Shop', auth: { type: 'bearer', token: '${token}' } },
      { id: 'other', name: 'Other', auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-123', in: 'header' } },
    ],
    cases: [
      { id: 'login', folderId: 'shop', name: 'Login', method: 'POST', url: '${baseUrl}/login', bodyType: 'json', body: '{"user": "${user}"}',
        auth: { type: 'none' }, extracts: [{ varName: 'token', from: 'json', path: 'token' }], cookies: false, timeoutMs: 5000 },
      { id: 'order', folderId: 'shop', name: 'Order', method: 'GET', url: '${baseUrl}/orders/42', bodyType: 'json', body: '{"ignored": 1}',
        headers: 'Accept: application/json\n# X-Debug: 1\nAuthorization: Bearer abc.def\nX-Session-Token: ${session}',
        checks: [{ on: 'json', path: 'status', op: 'equals', expected: 'PAID' }] },
      { id: 'form', folderId: 'shop', name: 'Form', method: 'PUT', url: 'https://a.test/f', bodyType: 'form', body: 'a=1+2&b=%C3%A9&c=${x}',
        auth: { type: 'basic', username: 'an', password: 'secret!' } },
      { id: 'key', folderId: 'other', name: 'Key', method: 'DELETE', url: 'https://b.test/k', bodyType: 'text', body: 'bye ${name}' },
    ],
  });
}

test('toPostman: folders, requests, headers, bodies, auth, in v2.1', () => {
  const { collection } = X.toPostman(shopState(), { includeSecrets: true });
  assert.equal(collection.info.schema, X.SCHEMA);
  assert.equal(collection.info.name, 'API Tests');
  assert.deepEqual(collection.item.map((f) => [f.name, f.item.map((r) => r.name)]), [['Shop', ['Login', 'Order', 'Form']], ['Other', ['Key']]]);
  const [shop, other] = collection.item;
  assert.deepEqual(shop.auth, { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
  const [login, order, form] = shop.item;
  assert.deepEqual(login.request, {
    method: 'POST', header: [], url: '{{baseUrl}}/login', auth: { type: 'noauth' },
    body: { mode: 'raw', raw: '{"user": "{{user}}"}', options: { raw: { language: 'json' } } },
  });
  assert.deepEqual(login.protocolProfileBehavior, { disableCookies: true });
  assert.equal(login.event[0].listen, 'test');
  assert.deepEqual(order.request.header, [
    { key: 'Accept', value: 'application/json' },
    { key: 'X-Debug', value: '1', disabled: true },
    { key: 'Authorization', value: 'Bearer abc.def' },
    { key: 'X-Session-Token', value: '{{session}}' },
  ]);
  assert.ok(!('body' in order.request), 'a GET goes without a body, as the page sends it');
  assert.ok(!('auth' in order.request), 'inherits the folder\'s');
  assert.deepEqual(form.request.body, { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1 2' }, { key: 'b', value: 'é' }, { key: 'c', value: '{{x}}' }] });
  assert.deepEqual(form.request.auth.basic.map((p) => p.value), ['an', 'secret!']);
  assert.deepEqual(other.auth.apikey.map((p) => [p.key, p.value]), [['key', 'X-Api-Key'], ['value', 'k-123'], ['in', 'header']]);
  assert.deepEqual(other.item[0].request.body, { mode: 'raw', raw: 'bye {{name}}', options: { raw: { language: 'text' } } });
});

test('toPostman: secrets written out are left blank and listed unless asked for', () => {
  const { collection, removedSecrets } = X.toPostman(shopState());
  assert.deepEqual(removedSecrets, ['Order: Authorization header', 'Form: Basic password', 'Other (folder): API key value']);
  const text = JSON.stringify(collection);
  for (const s of ['abc.def', 'secret!', 'k-123']) assert.ok(!text.includes(s), `${s} is not in the file`);
  assert.ok(text.includes('{{token}}') && text.includes('{{session}}'), 'variables are kept');
  assert.ok(!JSON.stringify(collection.item.map((f) => [f.auth, f.item.map((r) => r.request)])).includes('${'), 'no ${…} is left in a request');
});

test('toPostman: one folder; a folder with None has no auth', () => {
  const s = shopState();
  const { collection } = X.toPostman({ ...s, folders: s.folders.map((f) => (f.id === 'other' ? { ...f, auth: { type: 'none' } } : f)) }, { folderId: 'other' });
  assert.equal(collection.info.name, 'Other');
  assert.deepEqual(collection.item.map((f) => f.name), ['Other']);
  assert.ok(!('auth' in collection.item[0]));
  assert.equal(X.collectionFileName({ info: { name: 'Shop: v2 / beta' } }), 'Shop_ v2 _ beta.postman_collection.json');
});
