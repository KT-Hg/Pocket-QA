// cssEscape (shared/css-escape.js): CSS.escape for the service worker, which has
// no CSS global. Expected values are what CSS.escape returns in Chrome.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { cssEscape } from '../shared/css-escape.js';

test('cssEscape: plain identifiers are unchanged', () => {
  assert.equal(cssEscape('dd2'), 'dd2');
  assert.equal(cssEscape('a0123456789b'), 'a0123456789b');
  assert.equal(cssEscape('-a'), '-a');
  assert.equal(cssEscape('--'), '--');
  assert.equal(cssEscape('--a'), '--a');
  assert.equal(cssEscape('_x-Y_'), '_x-Y_');
  assert.equal(cssEscape('\x80\x2D\x5F\xA9'), '\x80\x2D\x5F\xA9');
  assert.equal(cssEscape('mã-đơn'), 'mã-đơn');
  assert.equal(cssEscape('\uD834\uDF06'), '\uD834\uDF06', 'a surrogate pair passes through');
});

test('cssEscape: a leading digit, or a digit after a leading hyphen, is a code point', () => {
  assert.equal(cssEscape('0a'), '\\30 a');
  assert.equal(cssEscape('1st'), '\\31 st');
  assert.equal(cssEscape('-0a'), '-\\30 a');
  assert.equal(cssEscape('--0'), '--0');
  assert.equal(cssEscape('a1'), 'a1');
});

test('cssEscape: a lone hyphen, control characters and NUL', () => {
  assert.equal(cssEscape('-'), '\\-');
  assert.equal(cssEscape('\x01\x02\x1E\x1F'), '\\1 \\2 \\1e \\1f ');
  assert.equal(cssEscape('a\x7Fb'), 'a\\7f b');
  assert.equal(cssEscape('\0'), '\uFFFD');
  assert.equal(cssEscape('a\0b'), 'a\uFFFDb');
});

test('cssEscape: other ASCII is backslash-escaped', () => {
  assert.equal(cssEscape('a.b:c'), 'a\\.b\\:c');
  assert.equal(cssEscape(' !xy'), '\\ \\!xy');
  assert.equal(cssEscape('form[name]'), 'form\\[name\\]');
  assert.equal(cssEscape('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(cssEscape('#id'), '\\#id');
});

test('cssEscape: non-strings are stringified', () => {
  assert.equal(cssEscape(42), '\\34 2');
  assert.equal(cssEscape(null), 'null');
});
