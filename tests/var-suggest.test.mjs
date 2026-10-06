// Variable suggestions: which `${…}` the caret is in, which names fit, and the
// text once one is chosen (shared/var-suggest.js).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { findVarToken, insertVarRef, nameQuery, rankVarNames, varValueDetail } from '../shared/var-suggest.js';

/** findVarToken with the caret where `|` is. */
const at = (marked) => findVarToken(marked.replace('|', ''), marked.indexOf('|'));

test('findVarToken: the reference being typed', () => {
  assert.deepEqual(at('${|'), { start: 0, end: 2, query: '', closed: false });
  assert.deepEqual(at('Hi ${us|'), { start: 3, end: 7, query: 'us', closed: false });
  assert.deepEqual(at('#row-${i|d} .name'), { start: 5, end: 10, query: 'i', closed: true });
  assert.deepEqual(at('${a}-${b|'), { start: 5, end: 8, query: 'b', closed: false });
  assert.deepEqual(at('${mã đơ|'), { start: 0, end: 7, query: 'mã đơ', closed: false });
});

test('findVarToken: no reference', () => {
  assert.equal(at('plain |text'), null);
  assert.equal(at('${user} |'), null, 'after a closed reference');
  assert.equal(at('${a\nb|'), null, 'a reference does not cross lines');
  assert.equal(at('$|{a}'), null, 'before the brace');
  assert.equal(at('${a{b|'), null, 'a brace inside the name');
  assert.equal(findVarToken(null, 0), null);
});

test('findVarToken: an unclosed reference ends at the caret, not at later text', () => {
  assert.deepEqual(at('${us| more'), { start: 0, end: 4, query: 'us', closed: false });
  assert.deepEqual(at('${us|er}${x}'), { start: 0, end: 7, query: 'us', closed: true });
});

test('insertVarRef: writes ${name} over the reference, caret after it', () => {
  const text = 'Hi ${us there';
  const tok = findVarToken(text, 7);
  assert.deepEqual(insertVarRef(text, tok, 'user'), { text: 'Hi ${user} there', caret: 10 });
  const closed = '#row-${i} x';
  assert.deepEqual(insertVarRef(closed, findVarToken(closed, 7), 'id'), { text: '#row-${id} x', caret: 10 });
});

test('nameQuery: a name field read as a name', () => {
  assert.equal(nameQuery(' role '), 'role');
  assert.equal(nameQuery('${role}'), 'role');
  assert.equal(nameQuery('${ro'), 'ro');
  assert.equal(nameQuery(undefined), '');
});

test('rankVarNames: starts-with first, then contains, order kept, duplicates once', () => {
  const e = (name, kind = 's') => ({ name, kind });
  const entries = [e('orderId'), e('user'), e('userName'), e('myOrder'), e('order', 'w'), e('orderId', 'c'), e('Organisation')];
  assert.deepEqual(rankVarNames('or', entries).map((x) => x.name), ['orderId', 'order', 'Organisation', 'myOrder']);
  assert.deepEqual(rankVarNames('ORDER', entries).map((x) => `${x.name}:${x.kind}`), ['orderId:s', 'order:w', 'myOrder:s']);
  assert.deepEqual(rankVarNames('', entries).map((x) => x.name), ['orderId', 'user', 'userName', 'myOrder', 'order', 'Organisation']);
  assert.deepEqual(rankVarNames('zz', entries), []);
  assert.equal(rankVarNames('', entries, 2).length, 2);
  assert.deepEqual(rankVarNames('a', [null, { name: '' }, { name: 'a' }]).map((x) => x.name), ['a']);
});

test('varValueDetail: Pick options and Fallback values as chips, the rest counted', () => {
  const cfg = (activeType, rest) => ({ activeType, s: '', r: { type: 'alphanumeric', length: '8' }, p: [], f: [], ...rest });
  assert.deepEqual(varValueDetail(cfg('p', { p: ['vn', 'jp', 'us'] })),
    { chips: ['vn', 'jp', 'us'], more: 0, chain: false, spec: '{pick:vn|jp|us}' });
  assert.deepEqual(varValueDetail(cfg('f', { f: ['Admin1', '', 'Viewer', 'Guest', 'x'] })),
    { chips: ['Admin1', 'Viewer', 'Guest'], more: 1, chain: true, spec: '{fallback:Admin1|Viewer|Guest|x}' });
  assert.deepEqual(varValueDetail(cfg('p', { p: [null] })).chips, [''], 'a lone Blank is one chip');
  assert.deepEqual(varValueDetail('{pick:a||c}'), { chips: ['a', '', 'c'], more: 0, chain: false, spec: '{pick:a||c}' });
  assert.equal(varValueDetail('{fallback:a|b}').chain, true);
});

test('varValueDetail: a Random read out, a Static value as text', () => {
  const rnd = (type, length) => varValueDetail({ activeType: 'r', r: { type, length } }).chips;
  assert.deepEqual(rnd('alphanumeric', '8'), ['8 letters & digits']);
  assert.deepEqual(rnd('alpha', '12'), ['12 letters']);
  assert.deepEqual(rnd('numeric', '4'), ['4 digits']);
  assert.deepEqual(rnd('datetime', '8'), ['date-time'], 'a date-time has no length');
  assert.deepEqual(varValueDetail('{random:hex:9999}').chips, ['512 letters & digits'], 'capped, unknown charset as a run draws it');
  assert.deepEqual(varValueDetail({ activeType: 's', s: 'hello' }), { text: 'hello', spec: 'hello' });
  assert.deepEqual(varValueDetail({ activeType: 'p', p: [''] }), { text: '', spec: '' }, 'a Pick with no options');
  assert.equal(varValueDetail('x'.repeat(50)).text, `${'x'.repeat(40)}…`);
  assert.deepEqual(varValueDetail(null), { text: '', spec: '' });
});
