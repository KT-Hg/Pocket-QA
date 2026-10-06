// Dropdown "Choose item #": shared/dropdown-pick.js, and the copies that cannot
// import it — content.js's <dropdown-pick-core> block, the bookmarklet's
// _pickIdx and the Selenium export's _pick_index — which must pick the same item.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { parsePickIndex, pickItemIndex, pickIndexError, pickStrings } from '../shared/dropdown-pick.js';
import { interpolateAction } from '../bg/interpolate.js';
import { getReadVarNames } from '../popup/utils.js';

const { generateBookmarklet } = await import('../popup/export-bookmarklet.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');

// Inputs every copy is run on: the item number, how many items, which may be
// chosen at random, and the "random" draw.
const RAWS = ['1', '2', ' 3 ', '-1', '-3', '4', '-5', '0', '-0', '', '  ', 'abc', '1.5', '+2', '2a', 'random', 'RANDOM', ' Random ', null, undefined, 7];
const COUNTS = [0, 1, 3, 4];
const ELIGIBLE = [() => true, (k) => k !== 0, () => false];
const DRAWS = [0, 0.49, 0.99];

function* cases() {
  for (const raw of RAWS) for (const count of COUNTS) for (const [e, eligible] of ELIGIBLE.entries()) for (const draw of DRAWS) {
    yield { raw, count, e, eligible, draw };
  }
}

test('pickItemIndex: counts from 1, -1 is the last, random draws from the eligible', () => {
  const only = (raw, count, eligible, draw = 0) => pickItemIndex(raw, count, eligible, () => draw);
  assert.deepEqual(only('1', 3), { index: 0 });
  assert.deepEqual(only(' 3 ', 3), { index: 2 });
  assert.deepEqual(only('-1', 3), { index: 2 });
  assert.deepEqual(only('-3', 3), { index: 0 });
  assert.match(only('4', 3).error, /no item #4 \(3 found\)/);
  assert.match(only('-4', 3).error, /no item #-4 \(3 found\)/);
  assert.match(only('0', 3).error, /"0" is not an item number/);
  assert.match(only('1.5', 3).error, /not an item number/);
  assert.match(only('', 3).error, /no item number/);
  assert.deepEqual(only('random', 4, (k) => k % 2 === 1, 0), { index: 1 });
  assert.deepEqual(only('random', 4, (k) => k % 2 === 1, 0.99), { index: 3 });
  assert.match(only('random', 2, () => false).error, /no item to choose at random \(2 found\)/);
});

test('parsePickIndex / pickIndexError: what the form accepts', () => {
  assert.deepEqual(parsePickIndex(' Random '), { random: true });
  assert.deepEqual(parsePickIndex('-2'), { n: -2 });
  assert.equal(pickIndexError('2'), null);
  assert.equal(pickIndexError('random'), null);
  assert.equal(pickIndexError('${row}'), null, 'a variable is checked when it plays');
  assert.equal(pickIndexError('#${row}'), null);
  assert.match(pickIndexError(''), /Item # is required/);
  assert.match(pickIndexError('   '), /Item # is required/);
  assert.match(pickIndexError('0'), /not an item number/);
  assert.match(pickIndexError('first'), /not an item number/);
});

test('pickStrings / interpolateAction / getReadVarNames: the item fields take variables', () => {
  const a = { type: 'dropdown', selector: '#s', pick: { by: 'index', index: '${row}', itemSelector: '.m-${menu} li' } };
  assert.deepEqual(pickStrings(a), ['${row}', '.m-${menu} li']);
  assert.deepEqual(pickStrings({ type: 'dropdown' }), []);
  const done = interpolateAction(a, { row: '2', menu: 'top' });
  assert.deepEqual(done.pick, { by: 'index', index: '2', itemSelector: '.m-top li' });
  assert.equal(a.pick.index, '${row}', 'the stored action is not changed');
  assert.deepEqual([...getReadVarNames([a])].sort(), ['menu', 'row']);
});

// ── content.js ──────────────────────────────────────────────────────────────
const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const core = src.slice(src.indexOf('/* <dropdown-pick-core> */'), src.indexOf('/* </dropdown-pick-core> */'));
assert.ok(core.length > 200, 'dropdown-pick-core block not found in content.js');

function contentCore() {
  const fired = [];
  const ctx = {
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    Math: Object.create(Math),
    fired,
  };
  vm.createContext(ctx);
  vm.runInContext(`${core}; this.parsePickIndex = parsePickIndex; this.pickItemIndex = pickItemIndex; this.pickNativeOption = pickNativeOption;`, ctx);
  return ctx;
}

test('content.js: its pickItemIndex chooses what shared/dropdown-pick.js chooses', () => {
  const c = contentCore();
  for (const { raw, count, eligible, draw } of cases()) {
    const want = pickItemIndex(raw, count, eligible, () => draw);
    const got = c.pickItemIndex(raw, count, eligible, () => draw);
    assert.deepEqual({ ...got }, want, JSON.stringify({ raw, count, draw }));
  }
});

test('content.js: a native <select> gets its option set and the page told', () => {
  const c = contentCore();
  const select = (opts) => {
    const fired = [];
    return {
      fired, selectedIndex: 0,
      options: opts.map(([value, text, disabled = false]) => ({ value, text, disabled })),
      dispatchEvent(e) { fired.push(e.type); },
    };
  };
  const s = select([['', '-- Select --'], ['vn', ' Viet Nam '], ['la', 'Laos', true], ['th', 'Thailand']]);
  assert.deepEqual({ ...c.pickNativeOption(s, { index: '2' }).picked }, { index: 2, text: 'Viet Nam', count: 4 });
  assert.equal(s.selectedIndex, 1);
  assert.deepEqual(s.fired, ['input', 'change', 'blur', 'click']);

  assert.equal(c.pickNativeOption(s, { index: '-1' }).picked.text, 'Thailand');
  assert.equal(s.selectedIndex, 3);

  const off = c.pickNativeOption(s, { index: '3' });
  assert.equal(off.failed, true);
  assert.match(off.error, /item #3 \("Laos"\) is disabled/);
  assert.equal(s.selectedIndex, 3, 'unchanged after an error');

  assert.match(c.pickNativeOption(s, { index: '9' }).error, /^Dropdown: there is no item #9 \(4 found\)/);
  assert.match(c.pickNativeOption(s, {}).error, /^Dropdown: no item number/);

  // random never lands on the placeholder or a disabled option
  c.Math.random = () => 0;
  assert.equal(c.pickNativeOption(s, { index: 'random' }).picked.text, 'Viet Nam');
  c.Math.random = () => 0.99;
  assert.equal(c.pickNativeOption(s, { index: 'random' }).picked.text, 'Thailand');
});

// ── the exports ─────────────────────────────────────────────────────────────
const pickActions = [
  { type: 'dropdown', selector: '#country', selectors: { css: '#country' }, pick: { by: 'index', index: '${row}' } },
  { type: 'dropdown', selector: '#menu', selectors: { css: '#menu' }, pick: { by: 'index', index: '-1', itemSelector: '.menu li' }, delay: 200 },
  { type: 'dropdown', selector: '#plain', selectors: { css: '#plain' } },
];

test('bookmarklet: _pickItem for item #, the plain open unchanged, and its _pickIdx chooses what shared does', () => {
  const { code } = generateBookmarklet('demo', pickActions, { row: '2' });
  assert.match(code, /await _pickItem\(_el1, `\$\{row\}`, "", 5000\);/);
  assert.match(code, /await _pickItem\(_el2, "-1", "\.menu li", 5000\);/);
  assert.match(code, /\/\/ Step 1: dropdown → item #\$\{row\}/);
  assert.match(code, /_el3\.click\(\);/);
  new Function(code.replace(/^javascript:/, '')); // parses

  const start = code.indexOf('  const _pickIdx = ');
  const end = code.indexOf('\n  };', start) + '\n  };'.length;
  assert.ok(start > 0 && end > start, '_pickIdx not found in the bookmarklet');
  const ctx = { Math: Object.create(Math) };
  vm.createContext(ctx);
  vm.runInContext(`${code.slice(start, end)}; this._pickIdx = _pickIdx;`, ctx);
  for (const { raw, count, eligible, draw } of cases()) {
    const want = pickItemIndex(raw, count, eligible, () => draw);
    ctx.Math.random = () => draw;
    let got;
    try { got = { index: ctx._pickIdx(raw, count, eligible) }; } catch (e) { got = { error: e.message }; }
    assert.equal('error' in got, 'error' in want, JSON.stringify({ raw, count, draw, got, want }));
    if (!('error' in want)) assert.equal(got.index, want.index, JSON.stringify({ raw, count, draw }));
  }

  // Only a scenario that chooses an item carries the helper.
  assert.doesNotMatch(generateBookmarklet('demo', [pickActions[2]], {}).code, /_pickIdx/);
});

test('selenium: _pick_item for item #, compiles, and its _pick_index chooses what shared does', () => {
  const { code } = generateSeleniumPy('demo', pickActions, { row: '2' });
  assert.match(code, /^import random$/m);
  assert.match(code, /^import re$/m);
  assert.match(code, /_pick_item\(el1, f"\{row\}", "", 10\.0\)|_pick_item\(el1, f"\{row\}", "", 10\)/);
  assert.match(code, /_pick_item\(el2, "-1", "\.menu li", 10\.0\)|_pick_item\(el2, "-1", "\.menu li", 10\)/);
  assert.match(code, /el3\.click\(\)/);
  const plain = generateSeleniumPy('demo', [pickActions[2]], {}).code;
  assert.doesNotMatch(plain, /_pick_index|^import re$|^import random$/m);

  // Run _pick_index itself on the deterministic cases (random is checked by kind only).
  const start = code.indexOf('def _pick_index(');
  const end = code.indexOf('\n\n\ndef _pick_item(');
  const fn = code.slice(start, end);
  const rows = [];
  for (const { raw, count, e } of cases()) {
    if (raw === null || raw === undefined || typeof raw === 'number') continue;
    rows.push({ raw, count, e });
  }
  const py = [
    'import json, random, re, sys',
    fn,
    'out = []',
    'for row in json.loads(sys.stdin.read()):',
    '    ok = [lambda k: True, lambda k: k != 0, lambda k: False][row["e"]]',
    '    try:',
    '        out.append({"index": _pick_index(row["raw"], row["count"], ok)})',
    '    except Exception as ex:',
    '        out.append({"error": str(ex)})',
    'print(json.dumps(out))',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'pick.py');
  writeFileSync(file, py);
  try {
    writeFileSync(join(dir, 'gen.py'), code);
    execFileSync('python', ['-c', `compile(open(r"${join(dir, 'gen.py')}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
    const got = JSON.parse(execFileSync('python', [file], { input: JSON.stringify(rows), stdio: 'pipe' }).toString());
    rows.forEach((row, k) => {
      const want = pickItemIndex(row.raw, row.count, ELIGIBLE[row.e], () => 0);
      const g = got[k];
      assert.equal('error' in g, 'error' in want, JSON.stringify({ row, g, want }));
      if (!('error' in want) && !/random/i.test(row.raw)) assert.equal(g.index, want.index, JSON.stringify(row));
      if (!('error' in want) && /random/i.test(row.raw)) assert.ok(ELIGIBLE[row.e](g.index), JSON.stringify(row));
    });
  } catch (e) {
    if (e.code === 'ENOENT') return; // no Python on this machine — nothing to check
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
