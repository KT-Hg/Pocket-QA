// Read DOM: the reader in content.js, variable-name normalisation and variable
// substitution in selectors. No DOM library needed — content.js's reader only
// touches a handful of element properties, which small fakes provide.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── Load the <readdom-core> block of content.js into a sandbox ──────────────
const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const core = src.slice(src.indexOf('/* <readdom-core> */'), src.indexOf('/* </readdom-core> */'));
assert.ok(core.length > 100, 'readdom-core block not found in content.js');

function sandbox({ find = async () => null, byCond = () => ({ el: null, resolvedFallbacks: {} }) } = {}) {
  const ctx = { console: { warn() {} }, findElementWithFallback: find, findElementByCondition: byCond };
  vm.createContext(ctx);
  vm.runInContext(`${core}; this.readElementValue = readElementValue; this.readDomAction = readDomAction;`, ctx);
  return ctx;
}
const { readElementValue } = sandbox();

// Minimal element fakes.
const el = (tagName, props = {}) => ({
  tagName, textContent: '', innerText: undefined, value: undefined,
  isContentEditable: false, attrs: {},
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
  ...props,
});
const opt = (value, text, selected = true) => ({ value, text, selected });

test('text (unchanged): textContent, trimmed', () => {
  const d = el('DIV', { textContent: '  Hello\n  <b>x</b>  ', innerText: 'Hello x' });
  assert.equal(readElementValue(d, 'text'), 'Hello\n  <b>x</b>');
  assert.equal(readElementValue(d, undefined), 'Hello\n  <b>x</b>');
});

test('visible: innerText with whitespace collapsed; textContent when innerText is missing', () => {
  assert.equal(readElementValue(el('DIV', { innerText: '  Hello \n\n  world ', textContent: 'script junk Hello world' }), 'visible'), 'Hello world');
  assert.equal(readElementValue(el('DIV', { textContent: ' a \t b ' }), 'visible'), 'a b');
});

test('visible: <select> → chosen option text; input/textarea → value', () => {
  const sel = el('SELECT', { selectedOptions: [opt('vn', '  Viet  Nam ')], textContent: 'Viet NamLaosThailand' });
  assert.equal(readElementValue(sel, 'visible'), 'Viet Nam');
  assert.equal(readElementValue(el('INPUT', { value: 'typed' }), 'visible'), 'typed');
  assert.equal(readElementValue(el('TEXTAREA', { value: 'multi\nline' }), 'visible'), 'multi\nline');
});

test('value: input / textarea / select / select multiple', () => {
  assert.equal(readElementValue(el('INPUT', { value: 'abc' }), 'value'), 'abc');
  assert.equal(readElementValue(el('TEXTAREA', { value: 'x' }), 'value'), 'x');
  assert.equal(readElementValue(el('SELECT', { value: 'b' }), 'value'), 'b');
  const multi = el('SELECT', { multiple: true, value: 'a', selectedOptions: [opt('a', 'A'), opt('c', 'C')] });
  assert.equal(readElementValue(multi, 'value'), 'a, c');
});

test('value: contenteditable → innerText; other elements → value, then text, then ""', () => {
  assert.equal(readElementValue(el('DIV', { isContentEditable: true, innerText: ' edited ' }), 'value'), 'edited');
  assert.equal(readElementValue(el('BUTTON', { value: 'go', innerText: 'Go!' }), 'value'), 'go');
  assert.equal(readElementValue(el('SPAN', { innerText: ' 42 ' }), 'value'), '42');
  assert.equal(readElementValue(el('LI', { value: 0, innerText: 'item' }), 'value'), 'item');
  assert.equal(readElementValue(el('DIV', { innerText: '' }), 'value'), '');
});

test('attr: getAttribute, "" when absent', () => {
  const a = el('A', { attrs: { href: '/x', 'data-id': '9' } });
  assert.equal(readElementValue(a, 'attr', 'data-id'), '9');
  assert.equal(readElementValue(a, 'attr', 'title'), '');
});

test('readDomAction: missing selector / attribute name', async () => {
  const { readDomAction } = sandbox();
  // Spread: objects from the sandbox belong to another realm.
  assert.deepEqual({ ...await readDomAction({ type: 'readdom', varName: 'v' }) }, { failed: true, error: 'Read DOM: missing selector' });
  assert.deepEqual(
    { ...await readDomAction({ type: 'readdom', selector: '#a', varName: 'v', readFrom: 'attr' }) },
    { failed: true, error: 'Read DOM: missing attribute name' },
  );
});

test('readDomAction: element not found keeps the error message', async () => {
  const { readDomAction } = sandbox({ find: async () => { throw new Error('Timeout waiting for #gone'); } });
  const r = await readDomAction({ type: 'readdom', selector: '#gone', selectors: { css: '#gone' } });
  assert.equal(r.failed, true);
  assert.equal(r.error, 'Timeout waiting for #gone');
});

test('readDomAction: child condition picks the child and reports fallbacks', async () => {
  const parent = el('UL');
  const child = el('LI', { textContent: ' Hanoi ' });
  let seen = null;
  const { readDomAction } = sandbox({
    find: async () => parent,
    byCond: (root, cond) => { seen = [root, cond]; return { el: child, resolvedFallbacks: { '{fallback:A|Hanoi}': 'Hanoi' } }; },
  });
  const r = await readDomAction({ type: 'readdom', selector: 'ul', conditions: { textContains: '{fallback:A|Hanoi}' } });
  assert.equal(seen[0], parent);
  assert.equal(r.value, 'Hanoi');
  assert.deepEqual({ ...r.resolvedFallbacks }, { '{fallback:A|Hanoi}': 'Hanoi' });

  const none = sandbox({ find: async () => parent });
  const miss = await none.readDomAction({ type: 'readdom', selector: 'ul', conditions: { textContains: 'x' } });
  assert.equal(miss.failed, true);
  assert.match(miss.error, /no child element/);
});

// ── normalizeVarName ────────────────────────────────────────────────────────
const { normalizeVarName } = await import('../shared/var-name.js');

test('normalizeVarName', () => {
  assert.equal(normalizeVarName('${abc}'), 'abc');
  assert.equal(normalizeVarName(' abc '), 'abc');
  assert.equal(normalizeVarName(' ${ abc } '), 'abc');
  assert.equal(normalizeVarName(''), null);
  assert.equal(normalizeVarName('${}'), null);
  assert.equal(normalizeVarName('a}b'), null);
  assert.equal(normalizeVarName(null), null);
});

// ── interpolateAction (bg/interpolate.js) ───────────────────────────────────
const { interpolateAction } = await import('../bg/interpolate.js');

test('interpolateAction: selectors, targetSelectors, attrName', () => {
  const a = {
    type: 'dragdrop', selector: '#row-${id}', selectors: { css: '#row-${id}', xpath: '//tr[@id="row-${id}"]', textTag: 'td' },
    targetSelector: '#slot-${slot}', targetSelectors: { css: '#slot-${slot}' }, attrName: 'data-${attr}',
  };
  const out = interpolateAction(a, { id: '7', slot: 'B', attr: 'x' });
  assert.equal(out.selector, '#row-7');
  assert.deepEqual(out.selectors, { css: '#row-7', xpath: '//tr[@id="row-7"]', textTag: 'td' });
  assert.equal(out.targetSelector, '#slot-B');
  assert.deepEqual(out.targetSelectors, { css: '#slot-B' });
  assert.equal(out.attrName, 'data-x');
  // The stored action is not modified.
  assert.equal(a.selectors.css, '#row-${id}');
  // Unknown names stay as written.
  assert.equal(interpolateAction({ selector: '#${nope}', selectors: { css: '#${nope}' } }, { id: 1 }).selectors.css, '#${nope}');
});
