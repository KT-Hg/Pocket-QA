// The Random variable's test-data kinds (shared/test-data.js, through shared/var-spec.js):
// their specs both ways, the values a run draws, and what the Variables tab says of them.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { DATE_FORMATS, NAMES, dataDescription, dataSpecString, dataValue, formatDate, parseDataSpec } from '../shared/test-data.js';
import { configValue, isRandomSpec, parseRandomSpec, randomSpecString, randomValue } from '../shared/var-spec.js';
import { variableType } from '../shared/var-order.js';
import { varValueDetail } from '../shared/var-suggest.js';
import { resolveRandomVars } from '../bg/interpolate.js';

/** Random numbers from a list, round and round: a value a test can predict. */
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

const SPECS = {
  '{random:email:example.test}': { type: 'email', domain: 'example.test' },
  '{random:phone:vn}': { type: 'phone', country: 'vn' },
  '{random:name:vi}': { type: 'name', lang: 'vi' },
  '{random:name:en}': { type: 'name', lang: 'en' },
  '{random:int:100:500}': { type: 'int', min: 100, max: 500 },
  '{random:int:-5:-5}': { type: 'int', min: -5, max: -5 },
  '{random:date:+1:dd/MM/yyyy}': { type: 'date', days: 1, format: 'dd/MM/yyyy' },
  '{random:date:-30:yyyy-MM-dd}': { type: 'date', days: -30, format: 'yyyy-MM-dd' },
  '{random:date:+0:MM/dd/yyyy}': { type: 'date', days: 0, format: 'MM/dd/yyyy' },
  '{random:uuid}': { type: 'uuid' },
};

test('a test-data spec parses and is written back the same', () => {
  for (const [s, spec] of Object.entries(SPECS)) {
    assert.deepEqual(parseRandomSpec(s), spec, s);
    assert.equal(dataSpecString(spec), s, s);
    assert.ok(isRandomSpec(s) && variableType(s) === 'r', s);
  }
});

test('the character kinds keep their old spelling and reading', () => {
  assert.deepEqual(parseRandomSpec('{random:alpha:8}'), { type: 'alpha', length: 8 });
  assert.deepEqual(parseRandomSpec('{random:datetime:0}'), { type: 'datetime', length: 0 });
  assert.deepEqual(parseRandomSpec('{random:zzz:4}'), { type: 'zzz', length: 4 }, 'an unknown word still reads as letters & digits');
  assert.equal(configValue({ activeType: 'r', r: { type: 'numeric', length: '6' } }), '{random:numeric:6}');
});

test('a spec that does not make sense is not a Random: the run types it as it is', () => {
  for (const s of ['{random:int:5:1}', '{random:int:1}', '{random:email:nodot}', '{random:email:a..b}', '{random:phone:us}',
    '{random:name:fr}', '{random:date:1:d/M/yy}', '{random:date:+1}', '{random:uuid:4}', '{random:email}', '{random:int:1:99999999999999}']) {
    assert.equal(parseRandomSpec(s), null, s);
    assert.equal(variableType(s), 's', s);
  }
  assert.equal(parseDataSpec('nope', []), null);
});

test('values: each kind as its spec says', () => {
  const now = new Date(2026, 10, 30, 23, 59); // 30 Nov 2026, late in the evening
  const draw = (s, rnd = Math.random) => randomValue(parseRandomSpec(s), { now, rnd });
  for (let n = 0; n < 50; n++) {
    assert.match(draw('{random:email:shop.vn}'), /^qa_[a-z0-9]{6}@shop\.vn$/);
    assert.match(draw('{random:phone:vn}'), /^0[35789]\d{8}$/);
    const vi = draw('{random:name:vi}').split(' ');
    assert.ok(vi.length === 3 && NAMES.vi.last.includes(vi[0]) && NAMES.vi.middle.includes(vi[1]) && NAMES.vi.first.includes(vi[2]), vi.join(' '));
    const n2 = Number(draw('{random:int:100:500}'));
    assert.ok(Number.isInteger(n2) && n2 >= 100 && n2 <= 500, String(n2));
    assert.match(draw('{random:uuid}'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(draw('{random:int:100:500}', () => 0), '100');
  assert.equal(draw('{random:int:100:500}', () => 0.999999), '500');
  assert.equal(draw('{random:name:en}', seq(0, 0)), 'James Smith');
  // Across the end of a month and of a year, and back.
  assert.equal(draw('{random:date:+1:dd/MM/yyyy}'), '01/12/2026');
  assert.equal(draw('{random:date:+32:yyyy-MM-dd}'), '2027-01-01');
  assert.equal(draw('{random:date:-30:dd.MM.yyyy}'), '31.10.2026');
  assert.equal(draw('{random:date:+0:MM/dd/yyyy}'), '11/30/2026');
});

test('formatDate: the five formats', () => {
  const d = new Date(2026, 0, 5);
  assert.deepEqual(DATE_FORMATS.map((f) => formatDate(d, f)), ['05/01/2026', '2026-01-05', '01/05/2026', '05-01-2026', '05.01.2026']);
});

test('a run draws a test-data variable once, as it draws the others', () => {
  const vars = resolveRandomVars({ d: '{random:date:+0:yyyy-MM-dd}', u: { activeType: 'r', r: { type: 'uuid' } }, plain: '{random:int:5:1}' });
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(vars.d, `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  assert.match(vars.u, /^[0-9a-f-]{36}$/);
  assert.equal(vars.plain, '{random:int:5:1}');
});

test('a Random config with a test-data kind: its fields as typed make the spec', () => {
  assert.equal(randomSpecString({ type: 'date', days: '2', format: 'dd-MM-yyyy' }), '{random:date:+2:dd-MM-yyyy}');
  assert.equal(randomSpecString({ type: 'date', days: ' -7 ', format: 'zz' }), '{random:date:-7:dd/MM/yyyy}');
  assert.equal(randomSpecString({ type: 'int', min: '10', max: '20' }), '{random:int:10:20}');
  assert.equal(randomSpecString({ type: 'email', domain: ' qa.shop.vn ' }), '{random:email:qa.shop.vn}');
  assert.equal(randomSpecString({ type: 'name', lang: 'en' }), '{random:name:en}');
  assert.equal(configValue({ activeType: 'r', r: { type: 'phone' } }), '{random:phone:vn}');
});

test('the Variables tab tells a test-data variable in a few words', () => {
  assert.equal(dataDescription(SPECS['{random:date:+1:dd/MM/yyyy}']), 'Date · today +1 · dd/MM/yyyy');
  assert.equal(dataDescription(SPECS['{random:date:-30:yyyy-MM-dd}']), 'Date · today −30 · yyyy-MM-dd');
  assert.equal(dataDescription(SPECS['{random:date:+0:MM/dd/yyyy}']), 'Date · today · MM/dd/yyyy');
  assert.equal(dataDescription(SPECS['{random:int:100:500}']), 'Number 100–500');
  assert.deepEqual(varValueDetail('{random:email:example.test}').chips, ['Email · @example.test']);
  assert.deepEqual(varValueDetail('{random:alpha:8}').chips, ['8 letters']);
});

test('dataValue of no spec is empty', () => {
  assert.equal(dataValue(null), '');
});
