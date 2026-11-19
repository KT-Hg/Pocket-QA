// What an action's other locators say of the element it acted on (_locatorVerdict
// in content.js): the 🩹 line of the Last run card.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* <locator-note>'), src.indexOf('/* </locator-note> */'));
assert.ok(block.length > 100, 'locator-note block not found in content.js');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${block}; this._locatorVerdict = _locatorVerdict;`, ctx);
const { _locatorVerdict } = ctx;

const email = { name: 'Email' }, coupon = { name: 'Coupon' }, signIn = { name: 'Sign in' }, other = { name: 'Sign in (footer)' };
const hits = (...pairs) => pairs.map(([by, el]) => ({ by, el }));
// vm objects come from another realm: compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('locators that all find the element used: nothing to tell', () => {
  assert.equal(_locatorVerdict(hits(['fullXpath', email], ['id', email], ['css', email], ['name', email])), null);
});

test('a field put at the top of the form: the full XPath finds it, the rest find the old one — split', () => {
  const v = _locatorVerdict(hits(['fullXpath', coupon], ['id', email], ['xpath', email], ['css', email], ['name', email]));
  assert.equal(v.kind, 'split');
  assert.equal(v.used.el, coupon, 'the run used the first one found, as playback does');
  assert.deepEqual(plain(v.used.by), ['fullXpath']);
  assert.equal(v.other.el, email);
  assert.deepEqual(plain(v.other.by), ['id', 'xpath', 'css', 'name']);
  assert.deepEqual(plain(v.missed), []);
});

test('a tie between two elements is told too', () => {
  const v = _locatorVerdict(hits(['fullXpath', coupon], ['css', email]));
  assert.equal(v.kind, 'split');
});

test('only the text still finds the button — fragile, with what found nothing', () => {
  const v = _locatorVerdict(hits(['fullXpath', null], ['id', null], ['xpath', null], ['css', null], ['text', signIn]));
  assert.equal(v.kind, 'fragile');
  assert.equal(v.used.el, signIn);
  assert.deepEqual(plain(v.missed), ['fullXpath', 'id', 'xpath', 'css']);
});

test('half of the locators still finding it is not fragile', () => {
  assert.equal(_locatorVerdict(hits(['fullXpath', null], ['id', email], ['css', email], ['name', null])), null);
});

test('a text that matches another button with the same words, while the rest agree, is not told', () => {
  assert.equal(_locatorVerdict(hits(['fullXpath', signIn], ['id', signIn], ['css', signIn], ['text', other])), null);
});

test('fewer than two locators, or none finding anything: nothing to tell', () => {
  assert.equal(_locatorVerdict(hits(['css', email])), null);
  assert.equal(_locatorVerdict(hits(['css', null], ['id', null])), null);
  assert.equal(_locatorVerdict([]), null);
});
