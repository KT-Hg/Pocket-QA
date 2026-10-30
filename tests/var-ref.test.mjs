// Variable references: bare Switch names, and every scanner agreeing with what
// interpolateAction() substitutes.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = new Proxy(() => {}, { get: (t, p) => (p === 'then' ? undefined : globalThis.chrome) });

const { normalizeVarRef } = await import('../shared/var-name.js');
const { interpolateAction } = await import('../bg/interpolate.js');
const { getUsedVarNames, getReadVarNames } = await import('../popup/utils.js');

test('normalizeVarRef', () => {
  assert.equal(normalizeVarRef('role'), '${role}');
  assert.equal(normalizeVarRef(' role '), '${role}');
  assert.equal(normalizeVarRef('${role}'), '${role}');
  assert.equal(normalizeVarRef(' ${role} '), '${role}');
  assert.equal(normalizeVarRef('${a}-${b}'), '${a}-${b}');
  assert.equal(normalizeVarRef('role}'), '${role}');
  assert.equal(normalizeVarRef(''), '');
  assert.equal(normalizeVarRef(null), '');
});

test('interpolateAction: bare switchVar and typeEquals are substituted', () => {
  const a = interpolateAction(
    { type: 'switch', switchVar: 'role', conditions: { typeEquals: '${t}' } },
    { role: 'admin', t: 'email' },
  );
  assert.equal(a.switchVar, 'admin');
  assert.equal(a.conditions.typeEquals, 'email');
  assert.equal(interpolateAction({ type: 'switch', switchVar: 'role' }, {}).switchVar, '${role}');
});

// Script code is escaped, not plain-substituted (_applyVarsToCode): a value
// from a CSV cell or read off the page must stay a value inside a string literal.
test('interpolateAction: a Script variable stays one string inside any quotes', () => {
  const tricky = `it's "quoted" \`tick\` back\\slash \${x} line1\nline2\r`;
  for (const q of ["'", '"', '`']) {
    const { code } = interpolateAction({ type: 'script', code: `return ${q}\${v}${q};` }, { v: tricky });
    assert.equal(new Function(code)(), tricky, `inside ${q}…${q}`);
  }
});

test('interpolateAction: a name every object inherits is not a variable', () => {
  const a = interpolateAction({ type: 'input', value: '${toString}-${constructor}-${x}' }, { x: '1' });
  assert.equal(a.value, '${toString}-${constructor}-1');
  const s = interpolateAction({ type: 'script', code: "return '${toString}';" }, { x: '1' });
  assert.equal(s.code, "return '${toString}';");
});

test('getReadVarNames / getUsedVarNames', () => {
  const actions = [
    { type: 'switch', switchVar: 'role' },
    { type: 'click', selectors: { css: '#${id}' }, attrName: '${attr}' },
    { type: 'uploadFile', folderPath: '${dir}', fileNames: ['${f}'] },
    { type: 'click', conditions: { idContains: '${i}', classContains: '${c}', typeEquals: '${t}' } },
    { type: 'readdom', varName: '${out}', selector: '#x' },
  ];
  const read = [...getReadVarNames(actions)].sort();
  assert.deepEqual(read, ['attr', 'c', 'dir', 'f', 'i', 'id', 'role', 't']);
  assert.deepEqual([...getUsedVarNames(actions)].sort(), [...read, 'out'].sort());
});

// ── Renaming a variable ─────────────────────────────────────────────────────
const { renameVarRefs, SELECTOR_KEYS, writtenVarNames } = await import('../shared/var-name.js');

// ${old} in every field interpolateAction() fills in, and values that are not strings.
const EVERY_FIELD = {
  type: 'click', delay: 500, clickThrough: false, note: null,
  selector: '#${old}', targetSelector: '.${old}',
  selectors: Object.fromEntries(SELECTOR_KEYS.map((k) => [k, k + '-${old}'])),
  targetSelectors: { css: '#t-${old}', xpath: '//*[@id="${old}"]' },
  attrName: 'data-${old}', value: 'Hi ${old}!', url: 'https://x.test/${old}', code: "return '${old}';",
  expectedValue: '${old}', switchVar: '${old}-${keep}', fileName: '${old}.png', folderPath: 'C:/${old}',
  fileNames: ['a-${old}.txt', 'b.txt'],
  conditions: { valueEquals: '${old}', textContains: '${old}', idContains: '${old}', classContains: '${old}', typeEquals: '${old}' },
  pick: { index: '${old}', itemSelector: 'li.${old}' },
};

test('renameVarRefs: every field interpolateAction fills in follows the new name', () => {
  const { action, count } = renameVarRefs(EVERY_FIELD, 'old', 'neu');
  assert.deepEqual(interpolateAction(action, { neu: 'V', keep: 'K' }), interpolateAction(EVERY_FIELD, { old: 'V', keep: 'K' }));
  assert.ok(!JSON.stringify(action).includes('${old}'));
  assert.equal(count, JSON.stringify(EVERY_FIELD).split('${old}').length - 1);
  const used = getUsedVarNames([action]);
  assert.ok(used.has('neu') && !used.has('old'), [...used].join());
  assert.equal(action.delay, 500);
  assert.equal(action.clickThrough, false);
  assert.equal(action.note, null);
});

test('renameVarRefs: names written bare', () => {
  const sw = (switchVar) => renameVarRefs({ type: 'switch', switchVar }, 'old', 'neu');
  assert.deepEqual(sw('old'), { action: { type: 'switch', switchVar: 'neu' }, count: 1 });
  assert.equal(sw(' old ').action.switchVar, 'neu');
  assert.equal(sw('${old}-${x}').action.switchVar, '${neu}-${x}');
  assert.equal(sw('older').count, 0);
  for (const varName of ['old', '${old}', ' old ']) {
    const r = renameVarRefs({ type: 'readdom', varName, pattern: 'Order ${old} of ${n}' }, 'old', 'neu');
    assert.deepEqual(r.action, { type: 'readdom', varName: 'neu', pattern: 'Order ${neu} of ${n}' }, varName);
    assert.equal(r.count, 2, varName);
    assert.deepEqual(writtenVarNames(r.action), ['neu', 'n']);
  }
  assert.equal(renameVarRefs({ type: 'screenshot_tovar', varName: 'old' }, 'old', 'neu').action.varName, 'neu');
  // Only Read DOM and Screenshot → Variable write to varName (writtenVarNames).
  assert.equal(renameVarRefs({ type: 'click', varName: 'old' }, 'old', 'neu').count, 0);
});

test('renameVarRefs: other names stay as they are', () => {
  const a = { type: 'input', value: '${oldX} ${xold} $old {old} old ${ old }', switchVar: 'older', label: 'old' };
  const r = renameVarRefs(a, 'old', 'neu');
  assert.equal(r.action, a);
  assert.equal(r.count, 0);
  // Literal, not a RegExp or a replacement pattern.
  assert.equal(renameVarRefs({ value: '${a.b} ${aXb}' }, 'a.b', 'c').action.value, '${c} ${aXb}');
  assert.equal(renameVarRefs({ value: '${x$(y)}' }, 'x$(y)', 'z').action.value, '${z}');
  assert.equal(renameVarRefs({ value: '${old}' }, 'old', 'p$&q').action.value, '${p$&q}');
});

test('renameVarRefs: labels and nested values follow; the action given is left alone', () => {
  const a = { type: 'switch', label: 'Role ${old}', cases: [{ value: 'admin', note: ['${old}/${old}'] }], switchVar: 'role' };
  const before = structuredClone(a);
  const r = renameVarRefs(a, 'old', 'neu');
  assert.deepEqual(r.action, { type: 'switch', label: 'Role ${neu}', cases: [{ value: 'admin', note: ['${neu}/${neu}'] }], switchVar: 'role' });
  assert.equal(r.count, 3);
  assert.deepEqual(a, before);
  assert.notEqual(r.action, a);
});

// ── Pick / Fallback Blank entries ───────────────────────────────────────────
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const { listEntries, listSpec, parseListSpec } = await import('../shared/var-name.js');
const { resolveRandomVars } = await import('../bg/interpolate.js');

test('listSpec / parseListSpec keep Blank entries, drop unfilled ones', () => {
  assert.deepEqual(listEntries(['a', null, '', '  ', 'c']), ['a', '', 'c']);
  assert.equal(listSpec('pick', ['a', null, '']), '{pick:a|}');
  assert.equal(listSpec('fallback', [null]), '{fallback:|}');
  assert.equal(listSpec('pick', ['', '']), '');
  assert.deepEqual(parseListSpec('pick', '{pick:a||c}'), ['a', '', 'c']);
  assert.deepEqual(parseListSpec('fallback', '{fallback:a|b}'), ['a', 'b']);
  assert.equal(parseListSpec('pick', 'plain'), null);
});

test('Pick can resolve to a Blank', () => {
  const seen = new Set();
  const v = { activeType: 'p', p: [null, 'x'] };
  for (let i = 0; i < 200; i++) seen.add(resolveRandomVars({ v }).v);
  assert.deepEqual([...seen].sort(), ['', 'x']);
});

test('Fallback Blank matches a child whose field is empty', () => {
  // A Windows checkout with core.autocrlf has CRLF line ends; the search below is for LF.
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('// Detects {fallback:A|B|C}');
  const end = src.indexOf('return { el: null, resolvedFallbacks };\n}', start) + 42;
  assert.ok(start > 0 && end > start, 'fallback block not found in content.js');
  // Depth-first list of fake elements stands in for the TreeWalker.
  const kids = [
    { id: 'a', value: 'filled', textContent: 'One', className: '', getAttribute: () => null },
    { id: 'b', value: '', textContent: '', className: '', getAttribute: () => null },
  ];
  const ctx = {
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    document: { createTreeWalker: () => { let i = 0; return { nextNode: () => kids[i++] || null }; } },
  };
  for (const k of kids) k.childNodes = [];
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}; this.find = findElementByCondition;`, ctx);
  const root = {};
  const r1 = ctx.find(root, { valueEquals: '{fallback:missing||filled}' });
  assert.equal(r1.el.id, 'b');                         // Blank → empty value, before "filled"
  assert.deepEqual({ ...r1.resolvedFallbacks }, {});   // a Blank win is not stuck
  const r2 = ctx.find(root, { valueEquals: '{fallback:filled|}' });
  assert.equal(r2.el.id, 'a');
  assert.equal(r2.resolvedFallbacks['{fallback:filled|}'], 'filled');
});
