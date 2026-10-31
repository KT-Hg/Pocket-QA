// A case's headers as rows of the Headers tab, and back (apicases/headers.js).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseRows, rowsText, rowProblem, valueSuggestions, addedHeaders } = await import('../apicases/headers.js');
const { parseHeaders } = await import('../shared/api-request.js');

test('text → rows: on, off (#), a line with no ":"', () => {
  assert.deepEqual(parseRows('Accept: application/json\n\n# X-Debug:  1 \n#Authorization: Bearer a:b\nbroken line\n#'), [
    { on: true, name: 'Accept', value: 'application/json' },
    { on: false, name: 'X-Debug', value: '1' },
    { on: false, name: 'Authorization', value: 'Bearer a:b' },
    { on: true, name: 'broken line', value: '' },
  ]);
  assert.deepEqual(parseRows(''), []);
});

test('rows → text: empty rows left out, # for those turned off', () => {
  assert.equal(rowsText([
    { on: true, name: ' Accept ', value: ' application/json ' },
    { on: true, name: '', value: '' },
    { on: false, name: 'X-Debug', value: '1' },
  ]), 'Accept: application/json\n# X-Debug: 1');
});

test('round trip, and what is sent is what the table shows', () => {
  const text = 'Accept: application/json\n# X-Off: 1\nAuthorization: Bearer ${token}';
  assert.equal(rowsText(parseRows(text)), text);
  assert.deepEqual(parseHeaders(rowsText(parseRows(text))).headers, [['Accept', 'application/json'], ['Authorization', 'Bearer ${token}']]);
});

test('rowProblem: no name, forbidden names, bad characters', () => {
  assert.equal(rowProblem({ name: 'Accept', value: 'x' }), '');
  assert.equal(rowProblem({ name: '', value: '' }), '', 'an empty row says nothing');
  assert.equal(rowProblem({ name: ' ', value: 'x' }), 'Give this header a name');
  assert.match(rowProblem({ name: 'cookie', value: 'a=1' }), /site's own cookies go along instead/);
  assert.equal(rowProblem({ name: 'Origin', value: 'x' }), 'The browser sets Origin itself — this row is not sent');
  assert.match(rowProblem({ name: 'Sec-Fetch-Mode', value: 'x' }), /sets Sec-Fetch-Mode itself/);
  assert.match(rowProblem({ name: 'My Header', value: 'x' }), /no spaces/);
  assert.match(rowProblem({ name: 'broken line', value: '' }), /no spaces/, 'a line with no ":" in the text gets this');
});

test('value suggestions by name, any case', () => {
  assert.ok(valueSuggestions('content-TYPE').includes('application/json'));
  assert.deepEqual(valueSuggestions('X-Unknown'), []);
});

test('addedHeaders: Content-Type of the body unless a row sets it, and the cookies', () => {
  const c = { method: 'POST', bodyType: 'json', cookies: true };
  assert.deepEqual(addedHeaders(c, []).map(([n, v]) => `${n}: ${v}`), ['Content-Type: application/json', 'Cookie: the browser\'s cookies for the site']);
  assert.deepEqual(addedHeaders(c, [{ on: true, name: 'content-type', value: 'x' }]).map(([n]) => n), ['Cookie']);
  assert.deepEqual(addedHeaders(c, [{ on: false, name: 'Content-Type', value: 'x' }]).map(([n]) => n), ['Content-Type', 'Cookie'], 'a row turned off sets nothing');
  assert.deepEqual(addedHeaders({ method: 'GET', bodyType: 'json', cookies: false }, []), [], 'GET sends no body');
  assert.equal(addedHeaders({ method: 'PUT', bodyType: 'text', cookies: false }, [])[0][1], 'text/plain;charset=UTF-8');
});
