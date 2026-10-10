// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { locatorsOf } from '../shared/locator-order.js';

const all = { css: '#c', id: 'i', xpath: '//x', fullXpath: '/html/body/x', testId: 't', dataId: 'd', name: 'n', text: 'OK', textTag: 'button' };

test('locators come in the order playback tries them (content.js _locators)', () => {
  assert.deepEqual(locatorsOf(all).map((l) => l.type), ['fullXpath', 'id', 'xpath', 'css', 'testId', 'dataId', 'name', 'text']);
  assert.deepEqual(locatorsOf(all).at(-1), { type: 'text', value: 'OK', tag: 'button' });
});

test('the type chosen in the form goes first, the rest keep their order', () => {
  assert.deepEqual(locatorsOf(all, '', 'css').map((l) => l.type), ['css', 'fullXpath', 'id', 'xpath', 'testId', 'dataId', 'name', 'text']);
  assert.deepEqual(locatorsOf({ css: '#c' }, '', 'id').map((l) => l.type), ['css'], 'a chosen type the action lacks changes nothing');
});

test('a bare selector string is a CSS one; empty values are not locators', () => {
  assert.deepEqual(locatorsOf(null, '#old'), [{ type: 'css', value: '#old' }]);
  assert.deepEqual(locatorsOf({ css: '', id: 'i' }, '#old'), [{ type: 'id', value: 'i' }]);
  assert.deepEqual(locatorsOf({}, '#old'), [{ type: 'css', value: '#old' }], 'nothing in the map: the old selector');
  assert.deepEqual(locatorsOf({}, ''), []);
});
