// The results CSV of the API Tests page (apicases/results-csv.js): a row per
// case with its last result, "Not run" for the others, written for Excel, no
// secret value in it.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { resultsCsv, resultsFileName, localTime } = await import('../apicases/results-csv.js');
const { normalizeState, ALL } = await import('../apicases/model.js');

const AT = Date.UTC(2026, 10, 1, 10, 42, 5);

function state() {
  return normalizeState({
    folders: [{ id: 'shop', name: 'Cửa hàng' }, { id: 'b', name: 'Billing' }],
    cases: [
      { id: 'ok', folderId: 'shop', name: 'Đơn hàng', method: 'GET', url: '${baseUrl}/orders?token=${token}',
        last: { at: AT, verdict: 'passed', status: 200, ms: 31, failures: [], bodyHead: '', sent: { method: 'GET', url: 'https://a.test/orders?token=••••' } } },
      { id: 'bad', folderId: 'shop', name: 'Pending, "quoted"', method: 'POST', url: 'https://a.test/x',
        last: { at: AT, verdict: 'failed', status: 500, ms: 9, bodyHead: '',
          failures: [{ kind: 'assert', reason: 'Expected status 2xx, got 500' }, { kind: 'assert', reason: 'Expected id to exist' }], sent: { method: 'POST', url: 'https://a.test/x' } } },
      { id: 'slow', folderId: 'b', name: 'Slow', method: 'GET', url: 'https://b.test/s',
        last: { at: AT, verdict: 'broken', status: null, ms: 300, failures: [{ kind: 'broken', reason: 'No response within 0.3 s' }], bodyHead: '', sent: null } },
      { id: 'new', folderId: 'b', name: 'New', method: 'DELETE', url: 'https://b.test/k?api_key=live-1' },
    ],
  });
}

/** The rows of a CSV written by csvText (every cell quoted). */
function rows(csv) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && csv[i + 1] === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++; }
  }
  return out;
}

test('a row per case in list order, with its last result; Not run for a case never sent', () => {
  const csv = resultsCsv(state());
  assert.ok(csv.startsWith('\uFEFF"Folder"'), 'a BOM, so Excel reads Vietnamese as UTF-8');
  assert.ok(csv.endsWith('"\r\n'), 'CRLF line ends (rows() below splits only on those)');
  const r = rows(csv.slice(1));
  assert.deepEqual(r[0], ['Folder', 'Name', 'Method', 'URL', 'Result', 'Status', 'Time (ms)', 'Failed checks', 'Ran at']);
  assert.deepEqual(r.slice(1), [
    ['Cửa hàng', 'Đơn hàng', 'GET', 'https://a.test/orders?token=••••', 'Passed', '200', '31', '', localTime(AT)],
    ['Cửa hàng', 'Pending, "quoted"', 'POST', 'https://a.test/x', 'Failed', '500', '9', 'Expected status 2xx, got 500\nExpected id to exist', localTime(AT)],
    ['Billing', 'Slow', 'GET', 'https://b.test/s', 'Broken', '', '300', 'No response within 0.3 s', localTime(AT)],
    ['Billing', 'New', 'DELETE', 'https://b.test/k?api_key=••••', 'Not run', '', '', '', ''],
  ]);
});

test('one folder; no token value in the file', () => {
  const r = rows(resultsCsv(state(), 'b').slice(1));
  assert.deepEqual(r.slice(1).map((x) => x[1]), ['Slow', 'New']);
  assert.ok(!resultsCsv(state(), ALL).includes('live-1'));
});

test('localTime and the file name', () => {
  const d = new Date(AT);
  assert.match(localTime(AT), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(Number(localTime(AT).slice(11, 13)), d.getHours());
  assert.equal(resultsFileName(state(), 'shop', AT), `Cửa hàng results ${localTime(AT).slice(0, 10)}.csv`);
  assert.equal(resultsFileName(state(), ALL, AT), `API Tests results ${localTime(AT).slice(0, 10)}.csv`);
});
