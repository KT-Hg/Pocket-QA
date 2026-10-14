// The ZIP export of a CSV run: one folder per row (row_NN or the Advanced "Folder
// name" template) and the screenshot files inside it.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateResultZip, zipEntries } from '../popup/csv/result-export.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const result = (rowIndex, vars = {}) => ({ rowIndex, vars, failures: [] });
// One screenshot `shot` per row, plus the rows and results the export reads.
function run(names, extraVars = {}) {
  const rows = names.map((name) => ({ name }));
  const results = names.map((_, i) => result(i, extraVars[i]));
  const ss = Object.fromEntries(names.map((_, i) => [`${i}:shot`, PNG]));
  return { rows, results, ss };
}
const paths = (rows, results, ss, naming) => zipEntries(rows, results, ss, naming).map(([p]) => p);

test('empty folder name: row_NN/<var>.png, in the order the screenshots come — as before', () => {
  const ss = { '0:shot': PNG, '1:other': PNG, '0:other': PNG, '10:shot': PNG };
  const results = [0, 1, 10].map((i) => result(i));
  const old = Object.keys(ss).map((k) => `row_${String(Number(k.split(':')[0]) + 1).padStart(2, '0')}/${k.split(':')[1]}.png`);
  assert.deepEqual(paths([], results, ss), old);
  assert.deepEqual(paths([], results, ss, { folderName: '   ' }), old);
  assert.deepEqual(zipEntries([], results, ss).map(([, b]) => b), Object.values(ss));
});

test('${column} per row; a repeated name gets _2', () => {
  const { rows, results, ss } = run(['john', 'kate', 'john']);
  assert.deepEqual(paths(rows, results, ss, { folderName: 'abc ${name}' }),
    ['abc john/shot.png', 'abc kate/shot.png', 'abc john_2/shot.png']);
});

test('names differing only in case are one folder on Windows', () => {
  const { rows, results, ss } = run(['John', 'john', 'JOHN']);
  assert.deepEqual(paths(rows, results, ss, { folderName: '${name}' }), ['John/shot.png', 'john_2/shot.png', 'JOHN_3/shot.png']);
});

test('cleaning: forbidden characters and "/" become _, a trailing dot or space goes, empty falls back to row_NN', () => {
  const { rows, results, ss } = run(['a/b:c?', '', 'x. ', '..', 'a\\b']);
  assert.deepEqual(paths(rows, results, ss, { folderName: '${name}' }),
    ['a_b_c_/shot.png', 'row_02/shot.png', 'x/shot.png', '_/shot.png', 'a_b/shot.png']);
});

test('a variable the run wrote (Read DOM) can be used and wins over the CSV column', () => {
  const { rows, results, ss } = run(['john', 'kate'], { 0: { order: 'A1' }, 1: { order: 'B2', name: 'read' } });
  assert.deepEqual(paths(rows, results, ss, { folderName: '${name} ${order}' }), ['john A1/shot.png', 'read B2/shot.png']);
});

test('an unknown ${var} stays as written', () => {
  const { rows, results, ss } = run(['john']);
  assert.deepEqual(paths(rows, results, ss, { folderName: '${nope}' }), ['${nope}/shot.png']);
});

test('duplicates resolve in row order, not in the IndexedDB key order ("10:" before "2:")', () => {
  const names = Array.from({ length: 12 }, (_, i) => (i === 2 || i === 10 ? 'dup' : `n${i}`));
  const { rows, results, ss } = run(names);
  const idbOrder = Object.fromEntries(Object.entries(ss).sort(([a], [b]) => (a < b ? -1 : 1)));
  const keys = Object.keys(idbOrder);
  assert.ok(keys.indexOf('10:shot') < keys.indexOf('2:shot'));
  const got = paths(rows, results, idbOrder, { folderName: '${name}' });
  assert.equal(got[keys.indexOf('2:shot')], 'dup/shot.png');
  assert.equal(got[keys.indexOf('10:shot')], 'dup_2/shot.png');
});

test('Add row number: the row\'s number in the CSV after the name', () => {
  const { rows, results, ss } = run(['john', 'kate', 'john']);
  assert.deepEqual(paths(rows, results, ss, { folderName: 'abc ${name}', rowNumber: true }),
    ['abc john_01/shot.png', 'abc kate_02/shot.png', 'abc john_03/shot.png']);
});

test('Add row number with no template, or an empty name: plain row_NN, no second number', () => {
  const { rows, results, ss } = run(['john', 'kate', '']);
  assert.deepEqual(paths(rows, results, ss, { folderName: '', rowNumber: true }), ['row_01/shot.png', 'row_02/shot.png', 'row_03/shot.png']);
  assert.deepEqual(paths(rows, results, ss, { folderName: '${name}', rowNumber: true }), ['john_01/shot.png', 'kate_02/shot.png', 'row_03/shot.png']);
});

test('a Screenshot → Variable Filename (ssNames) names the image like a screenshot Filename', () => {
  const ss = { '0:shot': PNG, '0:sub': PNG, '0:plain': PNG, '0:bad': PNG, '0:png': PNG, '1:shot': PNG };
  const results = [
    { ...result(0), ssNames: { shot: 'alice_login', sub: 'sub/alice', bad: 'a:b?', png: 'done.png' } },
    result(1), // no Filename used in this row
  ];
  assert.deepEqual(paths([{ name: 'alice' }, { name: 'bob' }], results, ss), [
    'row_01/alice_login.png', 'row_01/sub/alice.png', 'row_01/plain.png', 'row_01/a_b_.png', 'row_01/done.png', 'row_02/shot.png',
  ]);
});

test('two images on one name in a folder: _2, case ignored', () => {
  const ss = { '0:a': PNG, '0:b': PNG, '0:c': PNG };
  const results = [{ ...result(0), ssNames: { a: 'Same', b: 'same', c: 'same_2' } }];
  assert.deepEqual(paths([], results, ss), ['row_01/Same.png', 'row_01/same_2.png', 'row_01/same_2_2.png']);
});

test('generateResultZip: results.csv with a BOM, then the screenshots, as a ZIP blob', async () => {
  const { rows, results, ss } = run(['john', 'kate']);
  const blob = generateResultZip(['name'], rows, results, ss, { folderName: 'u ${name}' });
  assert.equal(blob.type, 'application/zip');
  const bytes = Buffer.from(await blob.arrayBuffer());
  const text = bytes.toString('latin1');
  assert.ok(text.includes('results.csv\xEF\xBB\xBF"name"'));
  assert.ok(text.includes('u john/shot.png') && text.includes('u kate/shot.png'));
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3); // entries in the end-of-central-directory record
});
