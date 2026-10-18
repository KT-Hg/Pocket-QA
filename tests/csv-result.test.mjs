// The result file of a CSV run: a Run Result column (shared/verdict.js) before
// Action Failed, and each failure's reason in it — alike in CSV, HTML, XLSX, ZIP.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateResultCsv, generateResultHtml, generateResultXlsx, generateResultZip } from '../popup/csv/result-export.js';

const headers = ['user'];
const rows = ['a', 'b', 'c', 'd', 'e'].map((user) => ({ user }));
const assertFail = { index: 7, type: 'assert', label: 'Check toast', reason: 'Expected text "Saved", got "Error"', kind: 'assert' };
const broken = { index: 2, type: 'click', label: '', reason: 'Element not found', kind: 'broken' };
const results = [
  { rowIndex: 0, vars: {}, failures: [] },
  { rowIndex: 1, vars: {}, failures: [assertFail] },
  { rowIndex: 2, vars: {}, failures: [broken, assertFail] },
  { rowIndex: 3, vars: {}, failures: [], completed: false },
  // Recorded before Assert: no kind, no reason, no `completed`.
  { rowIndex: 4, vars: {}, failures: [{ index: 3, type: 'click', label: 'Go' }] },
];
const VERDICTS = ['✓ Passed', '✗ Failed', '⚠ Test broken', '⏹ Stopped', '⚠ Test broken'];
const B_FAILED = '[7] assert "Check toast": Expected text "Saved", got "Error"';
const csv = generateResultCsv(headers, rows, results);
const csvLines = csv.split('\r\n');

test('CSV: Run Result before Action Failed, one verdict per row', () => {
  assert.equal(csvLines[0], '"user","Run Result","Action Failed"');
  assert.deepEqual(csvLines.slice(1).map((l) => l.split('","')[1]), VERDICTS);
});

test('Action Failed gives each failure its reason; one recorded without a reason reads as before', () => {
  assert.equal(csvLines[2], `"b","✗ Failed","${B_FAILED.replace(/"/g, '""')}"`);
  assert.equal(csvLines[3], `"c","⚠ Test broken","[2] click: Element not found; ${B_FAILED.replace(/"/g, '""')}"`);
  assert.equal(csvLines[5], '"e","⚠ Test broken","[3] click ""Go"""');
});

test('a "Run Result" or "Action Failed" column of the CSV itself keeps its own name and values', () => {
  const own = generateResultCsv(['Run Result'], [{ 'Run Result': 'mine' }], [{ ...results[1], rowIndex: 0 }]).split('\r\n');
  assert.equal(own[0], '"Run Result","Run Result","Action Failed"');
  assert.equal(own[1].split('","')[0], '"mine');
});

test('HTML: the same columns and cells', () => {
  const html = generateResultHtml(headers, rows, results, {}, []);
  assert.match(html, /<th>user<\/th><th>Run Result<\/th><th>Action Failed<\/th>/);
  for (const v of VERDICTS) assert.ok(html.includes(`>${v}</td>`), v);
  assert.ok(html.includes(B_FAILED.replace(/"/g, '&quot;')));
});

test('XLSX: the same columns and cells', async () => {
  const xml = Buffer.from(await generateResultXlsx(headers, rows, results, {}, []).arrayBuffer()).toString('utf8');
  for (const s of ['Run Result', 'Action Failed', ...VERDICTS, B_FAILED.replace(/"/g, '&quot;')]) assert.ok(xml.includes(s), s);
});

test('ZIP: its results.csv is the CSV', async () => {
  const bytes = Buffer.from(await generateResultZip(headers, rows, results, {}, {}).arrayBuffer()).toString('utf8');
  assert.ok(bytes.includes(csv));
});
