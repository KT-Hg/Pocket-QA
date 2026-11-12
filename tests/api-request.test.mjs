// One API request (shared/api-request.js): variables filled in per part of the
// request, headers read from their lines, and what sendRequest resolves to for
// a response, a timeout and a connection that fails. fetch is a fake.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildRequest, maskHeaders, maskUrl, parseHeaders, sendRequest, MASK } = await import('../shared/api-request.js');

const req = (fields) => ({ method: 'GET', url: 'https://api.test/x', headers: '', bodyType: 'none', body: '', timeoutMs: 30_000, cookies: true, ...fields });

test('parseHeaders: Name: value lines, # lines and blanks left out', () => {
  assert.deepEqual(parseHeaders('Accept: application/json\n\n# X-Off: 1\n  Authorization:  Bearer a:b  ').headers,
    [['Accept', 'application/json'], ['Authorization', 'Bearer a:b']]);
  assert.match(parseHeaders('Accept application/json').error, /^Header line 1 is not "Name: value"/);
  assert.equal(parseHeaders('A: 1\n: nameless').error, 'A header has a value but no name (line 2: : nameless)');
});

test('maskUrl: secret query values hidden, the URL otherwise as written', () => {
  assert.equal(maskUrl('https://a.test/x?id=1&token=t%201&API_KEY=k&key=z&q=a%20b#top'), `https://a.test/x?id=1&token=${MASK}&API_KEY=${MASK}&key=${MASK}&q=a%20b#top`);
  assert.equal(maskUrl('https://a.test/x'), 'https://a.test/x');
  assert.equal(maskUrl('https://a.test/x?token=&secret'), 'https://a.test/x?token=&secret', 'nothing to hide');
  assert.equal(maskUrl('https://a.test/x?bad%=1&access_token=t'), `https://a.test/x?bad%=1&access_token=${MASK}`, 'a name that does not decode is kept');
});

test('maskHeaders: secret values hidden, the rest kept', () => {
  assert.deepEqual(maskHeaders([['Authorization', 'Bearer t'], ['X-Auth-Token', 't'], ['Cookie', 'a=1'], ['Accept', '*/*']]),
    [['Authorization', MASK], ['X-Auth-Token', MASK], ['Cookie', MASK], ['Accept', '*/*']]);
});

test('variables: URL as is, JSON escaped, form encoded, headers on one line', () => {
  const vars = { base: 'https://api.test', name: 'An "Bo"\\', q: 'a&b=c', tok: 't\r\nX-Evil: 1' };
  const json = buildRequest(req({ method: 'POST', url: '${base}/users', bodyType: 'json', body: '{"name": "${name}"}', headers: 'Authorization: Bearer ${tok}' }), vars);
  assert.equal(json.url, 'https://api.test/users');
  assert.deepEqual(JSON.parse(json.init.body), { name: 'An "Bo"\\' }, 'a quote in a value keeps the JSON valid');
  assert.deepEqual(json.init.headers, [['Authorization', 'Bearer t X-Evil: 1'], ['Content-Type', 'application/json']]);

  const form = buildRequest(req({ method: 'POST', bodyType: 'form', body: 'q=${q}&n=1' }), vars);
  assert.equal(form.init.body, 'q=a%26b%3Dc&n=1');
  assert.deepEqual(form.init.headers, [['Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8']]);

  const text = buildRequest(req({ method: 'PUT', bodyType: 'text', body: 'hi ${q}', headers: 'content-type: text/csv' }), vars);
  assert.equal(text.init.body, 'hi a&b=c');
  assert.deepEqual(text.init.headers, [['content-type', 'text/csv']], 'a Content-Type given is kept, none added');
});

test('a variable with no value stops the request and names it', () => {
  const r = buildRequest(req({ url: '${base}/u/${id}', headers: 'X: ${id}' }), { base: 'https://a.test' });
  assert.equal(r.kind, 'vars');
  assert.equal(r.error, 'No value for ${id} — add it to the environment or the Tools tab');
  assert.match(buildRequest(req({ url: '${a}/${b}' })).error, /\$\{a\}, \$\{b\} — add them/);
  assert.equal(buildRequest(req({ url: 'https://a.test/${toString}' })).kind, 'vars', 'inherited names are not values');
});

test('GET and HEAD go without a body; settings carried over', () => {
  const r = buildRequest(req({ bodyType: 'json', body: '{"a":1}' }));
  assert.equal(r.init.body, undefined);
  assert.deepEqual(r.init.headers, [], 'no Content-Type for a request without a body');
  assert.equal(r.init.credentials, 'include');
  assert.equal(buildRequest(req({ cookies: false })).init.credentials, 'omit');
  assert.equal(buildRequest(req({ timeoutMs: 5000 })).timeoutMs, 5000);
});

test('URL and header problems', () => {
  assert.equal(buildRequest(req({ url: '' })).error, 'Enter a URL');
  assert.match(buildRequest(req({ url: 'api.test/x' })).error, /^Not a valid URL/);
  assert.match(buildRequest(req({ url: 'file:///c:/x' })).error, /^Only http/);
  assert.equal(buildRequest(req({ headers: 'bad' })).kind, 'headers');
  assert.equal(buildRequest(req({ headers: 'Bad Name: 1' })).kind, 'headers', 'a space in a header name');
});

/** Replace fetch for one test. */
function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = real; });
}

test('sendRequest: the response read back, JSON parsed', () => withFetch(async (url, init) => {
  assert.equal(url, 'https://api.test/users');
  assert.equal(init.method, 'POST');
  assert.ok(init.signal instanceof AbortSignal);
  return new Response('{"id":42}', { status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/json', 'X-Req': 'r1' } });
}, async () => {
  const r = await sendRequest(req({ method: 'POST', url: 'https://api.test/users', bodyType: 'json', body: '{}' }));
  assert.equal(r.status, 201);
  assert.equal(r.statusText, 'Created');
  assert.deepEqual(r.json, { id: 42 });
  assert.equal(r.isJson, true);
  assert.ok(r.headers.some(([n, v]) => n === 'x-req' && v === 'r1'));
  assert.deepEqual(r.sent, { method: 'POST', url: 'https://api.test/users' });
  assert.equal(typeof r.ms, 'number');
}));

test('sendRequest: a body that is not JSON stays text', () => withFetch(async () => new Response('<html>oops</html>', { status: 500 }), async () => {
  const r = await sendRequest(req());
  assert.equal(r.status, 500);
  assert.equal(r.isJson, false);
  assert.equal(r.text, '<html>oops</html>');
}));

test('sendRequest: no response within the timeout', () => withFetch((url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
}), async () => {
  const r = await sendRequest(req({ timeoutMs: 50 }));
  assert.equal(r.kind, 'timeout');
  assert.equal(r.error, 'No response within 0.1 s');
}));

test('sendRequest: a connection that fails, and a request that cannot be built', () => withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
  const r = await sendRequest(req({ url: 'https://down.test/x' }));
  assert.equal(r.kind, 'network');
  assert.match(r.error, /^Could not connect to down\.test \(Failed to fetch\)/);
  assert.equal((await sendRequest(req({ url: '${nope}' }))).kind, 'vars', 'not sent at all');
}));

test('sendRequest: an image or a PDF comes back as bytes, not text', () => withFetch(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), { status: 200, headers: { 'Content-Type': 'image/png' } }), async () => {
  const r = await sendRequest(req());
  assert.equal(r.isBinary, true);
  assert.equal(r.bytes, 7);
  assert.equal(r.text, '');
  assert.equal(r.contentType, 'image/png');
  assert.deepEqual([...new Uint8Array(await r.blob.arrayBuffer())].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
}));

test('sendRequest: text types, and a typed response with nothing in it', () => withFetch(async (url) => {
  if (url.endsWith('/svg')) return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
  if (url.endsWith('/problem')) return new Response('{"title":"x"}', { status: 400, headers: { 'Content-Type': 'application/problem+json' } });
  if (url.endsWith('/none')) return new Response('plain', { headers: {} });
  return new Response(null, { status: 204, headers: { 'Content-Type': 'application/octet-stream' } });
}, async () => {
  assert.equal((await sendRequest(req({ url: 'https://api.test/svg' }))).text, '<svg/>', 'XML types are text');
  assert.deepEqual((await sendRequest(req({ url: 'https://api.test/problem' }))).json, { title: 'x' });
  assert.equal((await sendRequest(req({ url: 'https://api.test/none' }))).text, 'plain', 'no Content-Type: read as text');
  const empty = await sendRequest(req({ url: 'https://api.test/empty' }));
  assert.equal(empty.isBinary, false, 'a binary type with no bytes is shown as no body');
  assert.equal(empty.text, '');
}));

test('base64Utf8: UTF-8 bytes, as Basic auth needs', async () => {
  const { base64Utf8 } = await import('../shared/api-request.js');
  assert.equal(base64Utf8('an:pá'), 'YW46cMOh');
});

test('auth: Bearer, Basic (UTF-8), an API key in a header or the query, variables filled in', () => {
  const vars = { token: 'T1', user: 'an' };
  const sent = (auth, fields) => buildRequest(req({ auth, ...fields }), vars);
  const header = (r, n) => r.init.headers.find(([k]) => k === n)?.[1];
  assert.equal(header(sent({ type: 'bearer', token: '${token}' }), 'Authorization'), 'Bearer T1');
  assert.equal(header(sent({ type: 'basic', username: '${user}', password: 'pá' }), 'Authorization'), 'Basic YW46cMOh');
  assert.equal(header(sent({ type: 'apikey', key: 'X-Key', value: '${token}', in: 'header' }), 'X-Key'), 'T1');
  assert.equal(sent({ type: 'apikey', key: 'api_key', value: 'k 1&', in: 'query' }, { url: 'https://api.test/x?a=1' }).url,
    'https://api.test/x?a=1&api_key=k%201%26', 'added to the query the URL has');
  assert.equal(sent({ type: 'apikey', key: 'api_key', value: 'k', in: 'query' }).url, 'https://api.test/x?api_key=k');
  for (const type of ['none', 'inherit']) assert.deepEqual(sent({ type, token: 't' }).init.headers, [], `${type} adds nothing`);
  assert.deepEqual(sent({ type: 'bearer', token: '' }).init.headers, [], 'an empty token adds nothing');
});

test('auth: what the Headers tab or the URL sets wins; a missing variable is named', () => {
  const mine = buildRequest(req({ headers: 'authorization: Bearer mine', auth: { type: 'bearer', token: 'theirs' } }));
  assert.deepEqual(mine.init.headers, [['authorization', 'Bearer mine']]);
  assert.equal(buildRequest(req({ url: 'https://api.test/x?api_key=mine', auth: { type: 'apikey', key: 'api_key', value: 'theirs', in: 'query' } })).url,
    'https://api.test/x?api_key=mine');
  assert.equal(buildRequest(req({ auth: { type: 'bearer', token: '${token}' } }), {}).error,
    'No value for ${token} (used by the auth) — add it to the environment or the Tools tab, or set this request\'s Auth to None');
  assert.equal(buildRequest(req({ url: '${base}/x', auth: { type: 'bearer', token: '${token}' } }), {}).error,
    'No value for ${base}, ${token} — add them to the environment or the Tools tab', 'not only the auth: the usual message');
  assert.equal(buildRequest(req({ auth: { type: 'apikey', key: 'bad key', value: 'v', in: 'header' } })).kind, 'headers');
});
