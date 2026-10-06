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
