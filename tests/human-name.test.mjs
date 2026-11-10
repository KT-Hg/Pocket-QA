// The name a recorded step gets from the page (_humanName in content.js): what a
// person calls the element, never what was typed into it.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* <human-name>'), src.indexOf('/* </human-name> */'));
assert.ok(block.length > 100, 'human-name block not found in content.js');

const byId = {};
const ctx = { document: { getElementById: (id) => byId[id] || null } };
vm.createContext(ctx);
vm.runInContext(`${block}; this._humanName = _humanName;`, ctx);
const { _humanName } = ctx;

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** An element fake: attributes, text, and what it sits in (`control`, for closest()). */
const el = (tagName, { attrs = {}, text = '', control = null, labels, type, value } = {}) => ({
  tagName, type, value, labels, innerText: text, textContent: text,
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
  matches: (sel) => sel === 'input, textarea, select' && FIELDS.has(tagName),
  closest: () => control,
});
/** A <label>, the text of the fields inside it left out (a select's options). */
const label = (own, inside = '') => ({
  cloneNode: () => {
    const copy = { textContent: own + inside, querySelectorAll: () => [{ remove: () => { copy.textContent = own; } }] };
    return copy;
  },
});

test('a field is named by its aria-label, then its <label>, then its placeholder', () => {
  assert.equal(_humanName(el('INPUT', { attrs: { 'aria-label': 'Email address', placeholder: 'you@x' } })), 'Email address');
  assert.equal(_humanName(el('INPUT', { labels: [label('Tên đăng nhập')], attrs: { placeholder: 'abc' } })), 'Tên đăng nhập');
  assert.equal(_humanName(el('INPUT', { attrs: { placeholder: '  Mật   khẩu ' } })), 'Mật khẩu');
});

test('a <select> inside its <label> is named by the label, not its options', () => {
  assert.equal(_humanName(el('SELECT', { labels: [label('Country ', 'Viet NamLaosThailand')], text: 'Viet NamLaos' })), 'Country');
});

test('aria-labelledby: the text of the elements it names', () => {
  byId.h1 = { textContent: 'Billing' };
  byId.h2 = { textContent: 'ZIP code' };
  assert.equal(_humanName(el('INPUT', { attrs: { 'aria-labelledby': 'h1 h2' } })), 'Billing ZIP code');
});

test('a click: the text of the button or link it landed in', () => {
  const button = { getAttribute: () => null, innerText: '  Đăng nhập ' };
  assert.equal(_humanName(el('SPAN', { text: 'Đăng nhập', control: button })), 'Đăng nhập');
  const iconLink = { getAttribute: (n) => (n === 'aria-label' ? 'Open the cart' : null), innerText: '' };
  assert.equal(_humanName(el('svg', { control: iconLink })), 'Open the cart');
  // <img alt> inside the link names it before the link's text does.
  assert.equal(_humanName(el('IMG', { attrs: { alt: 'Logo' }, control: { getAttribute: () => null, innerText: 'Home' } })), 'Logo');
});

test('an <input type="submit">: its caption, which is its value', () => {
  assert.equal(_humanName(el('INPUT', { type: 'submit', value: 'Sign in' })), 'Sign in');
});

test('never what was typed into a field', () => {
  assert.equal(_humanName(el('INPUT', { type: 'text', value: 'secret', text: '' })), '');
  assert.equal(_humanName(el('TEXTAREA', { value: 'typed', text: 'typed' })), '');
  assert.equal(_humanName(el('INPUT', { type: 'password', value: 'hunter2', attrs: { name: 'pw' } })), 'pw');
});

test('a long text is a container, not a name: the click falls back to the name attribute or nothing', () => {
  const long = 'This paragraph is far too long to be the name of anything one clicks on';
  assert.equal(_humanName(el('DIV', { text: long })), '');
  assert.equal(_humanName(el('DIV', { text: long, attrs: { name: 'intro' } })), 'intro');
});

test('generic or one-letter names are skipped for the next clue', () => {
  assert.equal(_humanName(el('BUTTON', { attrs: { 'aria-label': 'button' }, text: 'Save draft' })), 'Save draft');
  assert.equal(_humanName(el('INPUT', { attrs: { name: 'u' } })), '');
  assert.equal(_humanName(el('INPUT', { attrs: { placeholder: 'Submit', name: 'search' } })), 'search');
});

test('a name is cut to 60 characters', () => {
  assert.equal(_humanName(el('INPUT', { attrs: { 'aria-label': 'x'.repeat(100) } })).length, 60);
});
