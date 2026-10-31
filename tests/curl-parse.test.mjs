// A curl command read into a request of the API Tests page (apicases/curl.js):
// commands as DevTools' "Copy as cURL (bash)" writes them, and the ones it refuses.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseCurl, splitWords } = await import('../apicases/curl.js');

test('splitWords: bash quoting', () => {
  assert.deepEqual(splitWords(`curl 'a b' "c \\"d\\" \\$e" f\\ g $'h\\ni\\'j'`).words, ['curl', 'a b', 'c "d" $e', 'f g', "h\ni'j"]);
  assert.deepEqual(splitWords('curl \\\r\n  -s \\\n x').words, ['curl', '-s', 'x'], 'line continuations, CRLF too');
  assert.deepEqual(splitWords(`x $'\\u1ec7' $'\\xe9' $'\\xc3\\xa9'`).words, ['x', 'ệ', 'é', 'é'], '\\u, a character code, UTF-8 bytes');
  assert.match(splitWords(`curl 'open`).error, /never closed/);
  assert.match(splitWords(`curl "open`).error, /never closed/);
});

test('a GET copied from DevTools: browser headers and the cookie left out', () => {
  const r = parseCurl(`curl 'https://api.example.com/users?page=2' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: vi-VN,vi;q=0.9,en;q=0.8' \\
  -H 'authorization: Bearer eyJhbGciOi' \\
  -H 'cookie: sid=abc; theme=dark' \\
  -H 'priority: u=1, i' \\
  -H 'referer: https://app.example.com/' \\
  -H 'sec-ch-ua: "Chromium";v="130", "Microsoft Edge";v="130"' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)'`);
  assert.equal(r.error, undefined);
  assert.equal(r.request.method, 'GET');
  assert.equal(r.request.url, 'https://api.example.com/users?page=2');
  assert.equal(r.request.name, 'GET /users');
  assert.equal(r.request.headers, 'accept: application/json, text/plain, */*\naccept-language: vi-VN,vi;q=0.9,en;q=0.8\nauthorization: Bearer eyJhbGciOi');
  assert.equal(r.request.bodyType, 'none');
  assert.match(r.notes[0], /^the Cookie header/);
  assert.equal(r.notes[1], '5 headers the browser sets itself (priority, referer, sec-ch-ua, sec-fetch-mode, user-agent)');
});

test('a POST of JSON: POST implied, body indented', () => {
  const r = parseCurl(`curl 'https://api.example.com/users' -H 'content-type: application/json' --data-raw '{"name":"An","age":30}'`);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.bodyType, 'json');
  assert.equal(r.request.body, '{\n  "name": "An",\n  "age": 30\n}');
  assert.deepEqual(r.notes, []);
});

test('$\'…\' JSON with Vietnamese text and a quote', () => {
  const r = parseCurl(`curl 'https://x.test/n' -H 'content-type: application/json' --data-raw $'{"name":"Vi\\u1ec7t \\xe9","q":"it\\'s"}'`);
  assert.deepEqual(JSON.parse(r.request.body), { name: 'Việt é', q: "it's" });
});

test('form bodies: by Content-Type, or -d without one', () => {
  const a = parseCurl(`curl 'https://x.test/login' -H 'content-type: application/x-www-form-urlencoded' --data-raw 'user=an&pass=1%262'`);
  assert.equal(a.request.bodyType, 'form');
  assert.equal(a.request.body, 'user=an&pass=1%262');
  const b = parseCurl(`curl https://x.test/login -d user=an -d pass=1`);
  assert.equal(b.request.bodyType, 'form', 'curl sends -d as a form');
  assert.equal(b.request.body, 'user=an&pass=1');
  const c = parseCurl(`curl https://x.test/t -H 'Content-Type: text/plain' -d 'hello'`);
  assert.equal(c.request.bodyType, 'text');
});

test('-X, -u, -m, combined flags; -G puts the data in the URL', () => {
  const r = parseCurl(`curl -sSL -X put -u 'an:pá' -m 5 https://x.test/a`);
  assert.equal(r.request.method, 'PUT');
  assert.equal(r.request.headers, `Authorization: Basic ${Buffer.from('an:pá').toString('base64')}`);
  assert.equal(r.request.timeoutMs, 5000);

  const g = parseCurl(`curl -G https://x.test/s?a=0 -d q=1 --data-urlencode 'name=A B&C'`);
  assert.equal(g.request.method, 'GET');
  assert.equal(g.request.url, 'https://x.test/s?a=0&q=1&name=A%20B%26C');
  assert.equal(g.request.body, '');

  assert.equal(parseCurl(`curl -XDELETE --url=https://x.test/a/1`).request.method, 'DELETE');
  assert.equal(parseCurl(`curl -I https://x.test/`).request.method, 'HEAD');
  assert.equal(parseCurl(`curl x.test/a`).request.url, 'http://x.test/a', 'no scheme: http, as curl does');
});

test('--json adds Content-Type and Accept', () => {
  const r = parseCurl(`curl --json '{"a":1}' https://x.test/j`);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.headers, 'Content-Type: application/json\nAccept: application/json');
  assert.equal(r.request.bodyType, 'json');
});

test('double-quoted header value with escaped quotes', () => {
  assert.equal(parseCurl(`curl "https://x.test/a" -H "X-Name: \\"An\\""`).request.headers, 'X-Name: "An"');
});

test('what is refused, by name', () => {
  assert.equal(parseCurl('').error, 'Paste a curl command');
  assert.match(parseCurl('curl ^"https://x.test/^" -H ^"a: b^"').error, /Copy as cURL \(cmd\)/);
  assert.match(parseCurl('Invoke-WebRequest -Uri "https://x.test"').error, /^Not a curl command/);
  assert.equal(parseCurl('curl -s').error, 'No URL in the command');
  assert.equal(parseCurl('curl --frobnicate https://x.test').error, 'Option --frobnicate is not understood');
  assert.match(parseCurl('curl -F file=@a.png https://x.test').error, /multipart/);
  assert.match(parseCurl('curl -d @body.json https://x.test').error, /from a file/);
  assert.match(parseCurl('curl https://a.test https://b.test').error, /^Two URLs/);
  assert.match(parseCurl('curl -X TRACE https://a.test').error, /^Method TRACE is not supported/);
  assert.match(parseCurl('curl ftp://a.test/x').error, /^Only http/);
  assert.equal(parseCurl('curl -H').error, '-H needs a value');
});

test('toCurl → parseCurl gives the request back', async () => {
  const { toCurl } = await import('../apicases/curl.js');
  const vars = { base: 'https://api.test', name: 'Bánh "mì"' };
  const cases = [
    { method: 'GET', url: '${base}/users?page=2&q=a b', headers: 'Accept: application/json', bodyType: 'none', body: '' },
    { method: 'POST', url: '${base}/users', headers: 'Authorization: Bearer t', bodyType: 'json', body: '{"name": "${name}", "note": "it\'s\\nok"}' },
    { method: 'PUT', url: 'https://api.test/x', headers: '', bodyType: 'form', body: 'a=1&b=x%20y' },
    { method: 'PATCH', url: 'https://api.test/x', headers: 'X-Line: one', bodyType: 'text', body: 'line 1\nline 2\ttab' },
    { method: 'DELETE', url: 'https://api.test/x/1', headers: "X-Quote: it's", bodyType: 'none', body: '' },
    { method: 'OPTIONS', url: 'https://api.test/x', headers: '', bodyType: 'none', body: '' },
    { method: 'HEAD', url: 'https://api.test/x', headers: '', bodyType: 'none', body: '' },
  ];
  for (const c of cases) {
    const { command, error } = toCurl(c, vars);
    assert.equal(error, undefined);
    const back = parseCurl(command);
    assert.equal(back.error, undefined, `${c.method}: ${back.error}\n${command}`);
    assert.equal(back.request.method, c.method, command);
    assert.equal(back.request.url, new URL(c.url.replace('${base}', vars.base)).href);
    if (c.bodyType === 'json') {
      assert.deepEqual(JSON.parse(back.request.body), { name: 'Bánh "mì"', note: "it's\nok" });
    } else if (c.bodyType !== 'none') {
      assert.equal(back.request.body, c.body, command);
      assert.equal(back.request.bodyType, c.bodyType, command);
    }
    for (const line of c.headers.split('\n').filter(Boolean)) assert.ok(back.request.headers.includes(line), `${line} in ${back.request.headers}`);
  }
  assert.match(toCurl({ method: 'GET', url: '${nope}' }).error, /No value for \$\{nope\}/);
  assert.equal(parseCurl(`curl -X OPTIONS https://a.test`).request.method, 'OPTIONS', 'OPTIONS is a method now');
});
