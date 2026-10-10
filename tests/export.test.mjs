// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateBookmarklet } = await import('../popup/export-bookmarklet.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');

const blk = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
const actions = [
  { type: 'navigate', url: 'https://example.com/' },
  { type: 'readdom', selector: '#row-${id} .name', selectors: { css: '#row-${id} .name' }, varName: '${who}', readFrom: 'visible' },
  { type: 'readdom', selector: '#list', selectors: { css: '#list' }, varName: 'city', readFrom: 'attr', attrName: 'data-${attr}',
    conditions: { matchMode: 'any', textContains: 'Hanoi' } },
  { type: 'switch', switchVar: '${who}', cases: [blk('a', 5, 5), blk('b', 6, 6)] },
  { type: 'click', selector: '#case-a', selectors: { css: '#case-a' } },
  { type: 'click', selector: '#case-b', selectors: { css: '#case-b' } },
  { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${who} ${city}' },
];
const vars = { id: '7', attr: 'city' };

test('bookmarklet: selectors with variables, Read DOM reader, block skipped', () => {
  const { code, stats, warnings } = generateBookmarklet('demo', actions, vars);
  assert.match(code, /getEl\(`#row-\$\{id\} \.name`/);
  assert.match(code, /who = _readVal\(_el2, "visible", ""\);/);
  assert.match(code, /city = _readVal\(_el3, "attr", `data-\$\{attr\}`\);/);
  assert.match(code, /_findChild\(_el3_p/);
  assert.match(code, /\[SKIPPED\] switch block — steps 5–6/);
  assert.doesNotMatch(code, /#case-a|#case-b/);
  assert.match(code, /getEl\("#out"/);
  assert.equal(stats.skipped, 3);
  assert.ok(warnings.some((w) => /Switch block at step 4/.test(w)));
  // The generated bookmarklet parses.
  new Function(code.replace(/^javascript:/, ''));
});

test('selenium: selectors with variables, Read DOM reader, block skipped, compiles', () => {
  const { code, stats } = generateSeleniumPy('demo', actions, vars);
  assert.match(code, /By\.CSS_SELECTOR, f"#row-\{id\} \.name"/);
  assert.match(code, /who = _read_val\(el2, "visible", ""\)/);
  assert.match(code, /city = _read_val\(el3, "attr", f"data-\{attr\}"\)/);
  assert.match(code, /_find_child\(el3_p/);
  assert.match(code, /switch block \[SKIPPED\] — steps 5–6/);
  assert.doesNotMatch(code, /#case-a|#case-b/);
  assert.equal(stats.skipped, 3);
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'gen.py');
  writeFileSync(file, code);
  try {
    execFileSync('python', ['-W', 'error::SyntaxWarning', '-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return; // no Python on this machine — nothing to check
    assert.fail(String(e.stderr || e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exports without blocks are unchanged in shape', () => {
  const plain = [
    { type: 'condition', conditionType: 'elementExists', selector: '#x', skipCount: 1 },
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'click', selector: '#b', selectors: { css: '#b' } },
  ];
  const { code } = generateBookmarklet('plain', plain, {});
  assert.match(code, /if \(_checkCond\("elementExists", _first\("#x"\), ''\)\) \{\n\s+\/\/ Step 2: click/);
  assert.match(code, /\}\n\n\s+\/\/ Step 3: click/);
});

test('Read DOM Extract: each ${name} is read out of the text, in both exports', async () => {
  const steps = [
    { type: 'readdom', selector: '#code', selectors: { css: '#code' }, readFrom: 'visible', pattern: 'abc${a} ${b}' },
    { type: 'readdom', selector: '#t', selectors: { css: '#t' }, varName: 'full', readFrom: 'text', pattern: 'Total: ${amount} $', matchCase: true },
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${a}-${b} ${amount} ${full}' },
  ];
  const js = generateBookmarklet('extract', steps, {});
  const { patternRegexSource } = await import('../shared/text-pattern.js');
  const src = (p) => JSON.stringify(patternRegexSource(p));
  assert.ok(js.code.includes(`const _el1_m = new RegExp(${src('abc${a} ${b}')}, "i").exec(_el1_t);`));
  assert.match(js.code, /a = _el1_m\[1\]\.trim\(\);\s+b = _el1_m\[2\]\.trim\(\);/);
  assert.match(js.code, /full = _el2_t;/);
  assert.ok(js.code.includes(`new RegExp(${src('Total: ${amount} $')}, "").exec(_el2_t);`), 'Match case: no "i" flag');
  assert.ok(!js.warnings.some((w) => /\$\{(a|b|amount)\} is used/.test(w)), 'pattern names count as defined');
  new Function(js.code.replace(/^javascript:/, ''));

  const py = generateSeleniumPy('extract', steps, {});
  assert.match(py.code, /^import re$/m);
  assert.match(py.code, /el1_m = re\.search\("abc.*", el1_t, re\.I\)/);
  assert.match(py.code, /a = el1_m\.group\(1\)\.strip\(\)\s+b = el1_m\.group\(2\)\.strip\(\)/);
  assert.match(py.code, /el2_m = re\.search\("Total:.*", el2_t\)\n/);
  assert.ok(!py.warnings.some((w) => /\$\{(a|b|amount)\} is used/.test(w)));
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'gen.py');
  writeFileSync(file, py.code);
  try {
    execFileSync('python', ['-W', 'error::SyntaxWarning', '-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    assert.fail(String(e.stderr || e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both exports run the same in-page Child Condition search and reader (popup/export/page-js.js)', async () => {
  const { FIND_CHILD_JS, READ_VAL_JS } = await import('../popup/export/page-js.js');
  const steps = [{ type: 'readdom', selector: '#p', selectors: { css: '#p' }, varName: 'v', readFrom: 'text',
    conditions: { matchMode: 'all', textContains: '${who}', classContains: 'row' } }];
  const py = generateSeleniumPy('one source', steps, { who: '{fallback:Carol|Bob}' }).code;
  const js = generateBookmarklet('one source', steps, { who: '{fallback:Carol|Bob}' }).code;
  for (const src of [FIND_CHILD_JS, READ_VAL_JS]) {
    assert.ok(py.includes(src), 'the Selenium script runs the page-js source as is');
    assert.ok(js.includes(src.split('\n').map((l) => `  ${l}`).join('\n').trimStart()), 'the bookmarklet declares it');
  }
  assert.doesNotMatch(py, /find_elements\(By\.XPATH, "\.\/\/\*"\)/, 'no Python walk of the subtree, one WebDriver call per element');
  // The criteria go over as a dict, matchMode included; the fallback spec is resolved in the page.
  assert.match(py, /el1 = _find_child\(el1_p, \{"matchMode": "all", "textContains": f"\{who\}", "classContains": "row"\}\)/);
  assert.equal(compilePy(py), null);
});

/** Python's verdict on generated code: null when it compiles (or there is no Python here), else the error. */
function compilePy(code) {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'gen.py');
  writeFileSync(file, code);
  try {
    execFileSync('python', ['-W', 'error::SyntaxWarning', '-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
    return null;
  } catch (e) {
    return e.code === 'ENOENT' ? null : String(e.stderr || e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What an imported scenario can hold: names, labels and types are free text.
const HOSTILE_NAME = 'Đăng nhập "admin" \\ C:\\new\nprint("INJECTED")';
const hostile = [
  { type: 'click', selector: '#a', selectors: { css: '#a' }, label: 'ok\n    print("INJECTED")' },
  { type: 'condition', conditionType: 'isChecked\nprint("INJECTED")', selector: '#b', selectors: { css: '#b' }, skipCount: 1,
    label: 'x\u2028alert("INJECTED") */' },
  { type: 'click', selector: '#c', selectors: { css: '#c' } },
  { type: 'teleport\nprint("INJECTED")', selector: '#d' },
];

test('a name, label or type cannot end its comment or string, in either export', () => {
  const py = generateSeleniumPy(HOSTILE_NAME, hostile, {});
  for (const line of py.code.split('\n').filter((l) => l.includes('INJECTED'))) {
    assert.match(line.trim(), /^#|^print\("✅/, line);
  }
  assert.ok(py.warnings.some((w) => /type "isChecked/.test(w)), 'an unknown condition type is a warning');
  assert.equal(compilePy(py.code), null);

  const js = generateBookmarklet(HOSTILE_NAME, hostile, {});
  for (const line of js.code.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => l.includes('INJECTED'))) {
    assert.match(line.trim(), /^\/\//, line);
  }
  assert.ok(js.warnings.some((w) => /type "isChecked/.test(w)), 'an unknown condition type is a warning');
  new Function(js.code.replace(/^javascript:/, ''));
});

// Fakes for running CHECK_COND_JS outside a page: an element is its style, size, text and attributes.
const fakeEl = ({ style = {}, size = [10, 10], text = '', attrs = {}, value, classes = [] } = {}) => ({
  style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
  getBoundingClientRect: () => ({ width: size[0], height: size[1] }),
  textContent: text,
  ...(value !== undefined ? { value } : {}),
  classList: { contains: (c) => classes.includes(c) },
  hasAttribute: (n) => n in attrs,
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
});

test('the in-page condition check answers as playback does (content.js CHECK_CONDITION)', async () => {
  const { CHECK_COND_JS, CONDITION_TYPES } = await import('../popup/export/page-js.js');
  globalThis.getComputedStyle = (el) => el.style;
  globalThis.window = { location: { href: 'https://shop.test/cart?id=7' } };
  try {
    const check = new Function(`return (${CHECK_COND_JS})`)();
    const fixed = fakeEl(); // position:fixed has no offsetParent, but it is on screen
    const ghost = fakeEl({ style: { opacity: '0' } });
    const cases = [
      ['elementExists', fixed, '', true], ['elementExists', null, '', false],
      ['elementNotExists', null, '', true],
      ['elementVisible', fixed, '', true], ['elementVisible', ghost, '', false],
      ['elementVisible', fakeEl({ size: [0, 0] }), '', false], ['elementVisible', null, '', false],
      ['elementHidden', ghost, '', true], ['elementHidden', fakeEl({ style: { visibility: 'hidden' } }), '', true],
      ['elementHidden', fixed, '', false], ['elementHidden', null, '', true],
      ['textContains', fakeEl({ text: 'Note secret' }), 'secret', true], ['textContains', null, 'x', false],
      ['textEquals', fakeEl({ text: '  Total: 42  ' }), ' Total: 42 ', true],
      ['valueEquals', fakeEl({ value: 'a' }), 'a', true], ['valueEquals', fakeEl(), 'a', false],
      ['valueContains', fakeEl({ value: 'abc' }), 'b', true],
      ['urlContains', null, 'cart', true], ['urlEquals', null, 'https://shop.test/cart?id=7', true],
      ['hasClass', fakeEl({ classes: ['on'] }), 'on', true],
      ['hasAttribute', fakeEl({ attrs: { 'data-id': '5' } }), 'data-id=5', true],
      ['hasAttribute', fakeEl({ attrs: { 'data-id': '6' } }), 'data-id=5', false],
      ['hasAttribute', fakeEl({ attrs: { disabled: '' } }), 'disabled', true],
    ];
    for (const [type, el, expected, want] of cases) {
      assert.equal(check(type, el, expected), want, `${type} ${expected}`);
    }
    assert.deepEqual([...new Set(cases.map((c) => c[0]))].sort(), [...CONDITION_TYPES].sort(), 'every type is covered');
    assert.throws(() => check('isChecked', fixed, ''), /Unknown condition type "isChecked"/);
  } finally {
    delete globalThis.getComputedStyle;
    delete globalThis.window;
  }
});

test('both exports check a Condition with the in-page check, and stop on an unknown type', () => {
  const steps = [
    { type: 'condition', conditionType: 'hasAttribute', selector: '#t', selectors: { css: '#t' }, expectedValue: 'data-id=${n}', skipCount: 1 },
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'condition', conditionType: 'urlContains', expectedValue: 'cart', skipCount: 1 },
    { type: 'click', selector: '#b', selectors: { css: '#b' } },
    { type: 'condition', conditionType: 'isChecked', selector: '#c', selectors: { css: '#c' }, skipCount: 1 },
    { type: 'click', selector: '#d', selectors: { css: '#d' } },
  ];
  const py = generateSeleniumPy('conds', steps, { n: '5' });
  assert.match(py.code, /^ {4}if _check_cond\("hasAttribute", \[\(By\.CSS_SELECTOR, "#t"\)\], f"data-id=\{n\}"\):$/m);
  assert.match(py.code, /^ {4}if _check_cond\("urlContains", None, "cart"\):$/m);
  // It stops there; the block after it is kept for a check put in by hand.
  assert.match(py.code, /^ {4}raise Exception\("Condition step 5: unknown condition type, named in the comment above"\)\n {4}if True:\n {8}# Step 6: click$/m);
  assert.equal(compilePy(py.code), null);

  const js = generateBookmarklet('conds', steps, { n: '5' });
  assert.match(js.code, /^ {4}if \(_checkCond\("hasAttribute", _first\("#t"\), `data-id=\$\{n\}`\)\) \{$/m);
  assert.match(js.code, /^ {4}if \(_checkCond\("urlContains", null, "cart"\)\) \{$/m);
  assert.match(js.code, /^ {4}throw new Error\("Condition step 5: unknown condition type, named in the comment above"\);\n {4}if \(true\) \{\n {6}\/\/ Step 6: click$/m);
  new Function(js.code.replace(/^javascript:/, ''));

  for (const r of [py, js]) {
    assert.equal(r.steps.find((s) => s.n === 5).status, 'verify');
    assert.match(r.steps.find((s) => s.n === 5).reason, /stops there/);
    assert.ok(r.warnings.some((w) => /Condition step 5: type "isChecked" is unknown \u2014 the exported code stops there/.test(w)));
  }
});

test('the copied bookmark URL is the code as written, and it runs', async () => {
  const { toBookmarkletUrl } = await import('../popup/export-bookmarklet.js');
  const steps = [
    { type: 'script', code: 'const a = 1\nconsole.log(a)' },                  // relies on line breaks
    { type: 'script', code: 'const b = 2; // a trailing comment\nconsole.log(b);' },
    { type: 'input', selector: '#n', selectors: { css: '#n' }, value: 'John  Smith\t100%41' },
  ];
  const { code } = generateBookmarklet('copy', steps, {});
  const url = toBookmarkletUrl(code);
  assert.ok(url.startsWith('javascript:'));
  assert.doesNotMatch(url, /[\t\r\n]/, 'nothing a URL parser would drop');
  // What the browser runs: the URL with its percent-encoding decoded.
  const runs = decodeURIComponent(url.slice('javascript:'.length));
  assert.equal(runs, code.slice('javascript:'.length).trim());
  new Function(runs);
  assert.ok(runs.includes('John  Smith\\t100%41'), 'values keep their spacing and percent signs');
});

test('both exports try every locator in the order playback does, the chosen type first', () => {
  const sels = { id: 'go', css: '#go-css', xpath: '//button[@id="go"]', name: 'q', text: 'it\'s "ok"' };
  const click = (selectorType) => ({ type: 'click', selector: '#go-css', selectors: sels, ...(selectorType ? { selectorType } : {}) });
  const steps = [
    click('css'), click('xpath'), click('name'), click('text'), click(null),
    { type: 'dragdrop', selector: '#go-css', selectors: sels, selectorType: 'css',
      targetSelector: '#t', targetSelectors: { css: '#t', xpath: '//div[@id="t"]' }, targetSelectorType: 'xpath' },
    { type: 'click', selectors: { text: 'OK', textTag: 'button' } },
  ];
  const orders = [
    ['css', 'id', 'xpath', 'name', 'text'], ['xpath', 'id', 'css', 'name', 'text'], ['name', 'id', 'xpath', 'css', 'text'],
    ['text', 'id', 'xpath', 'css', 'name'], ['id', 'xpath', 'css', 'name', 'text'], ['css', 'id', 'xpath', 'name', 'text'],
  ];

  const PY = { css: '(By.CSS_SELECTOR, "#go-css")', id: '(By.ID, "go")', xpath: '(By.XPATH, "//button[@id=\\"go\\"]")',
    name: '(By.NAME, "q")', text: `("text", ${JSON.stringify(sels.text)})` };
  const py = generateSeleniumPy('choice', steps, {}).code;
  orders.slice(0, 5).forEach((order, i) => {
    assert.ok(py.includes(`el${i + 1} = _find([${order.map((t) => PY[t]).join(', ')}], 10, clickable=True)`), order.join());
  });
  assert.ok(py.includes(`el6_src = _find([${orders[5].map((t) => PY[t]).join(', ')}], 10)`));
  assert.ok(py.includes('el6_tgt = _find([(By.XPATH, "//div[@id=\\"t\\"]"), (By.CSS_SELECTOR, "#t")], 10)'));
  assert.ok(py.includes('el7 = _find([("text", "OK", "button")], 10, clickable=True)'), 'a Text locator alone still goes through _find');
  assert.equal(compilePy(py), null);

  const JS = { css: '"#go-css"', id: '"#go"', xpath: JSON.stringify(sels.xpath), name: JSON.stringify('[name="q"]'),
    text: `{ text: ${JSON.stringify(sels.text)} }` };
  const js = generateBookmarklet('choice', steps, {}).code;
  orders.slice(0, 5).forEach((order, i) => {
    assert.ok(js.includes(`const _el${i + 1} = await getEl([${order.map((t) => JS[t]).join(', ')}], 5000);`), order.join());
  });
  assert.ok(js.includes(`const _el6_t = await getEl([${JSON.stringify('//div[@id="t"]')}, "#t"], 5000);`));
  assert.ok(js.includes('const _el7 = await getEl({ text: "OK", tag: "button" }, 5000);'));
  new Function(js.replace(/^javascript:/, ''));
});

test('a step with one locator keeps the short form', () => {
  const steps = [{ type: 'click', selector: '#n', selectors: { css: '#n' } }, { type: 'input', selectors: { id: 'q' }, value: 'x' }];
  const py = generateSeleniumPy('short', steps, {}).code;
  assert.match(py, /el1 = WebDriverWait\(driver, 10\)\.until\(EC\.element_to_be_clickable\(\(By\.CSS_SELECTOR, "#n"\)\)\)/);
  assert.match(py, /el2 = WebDriverWait\(driver, 10\)\.until\(EC\.presence_of_element_located\(\(By\.ID, "q"\)\)\)/);
  assert.doesNotMatch(py, /def _find|def _locate/, 'no helper it does not use');
  const js = generateBookmarklet('short', steps, {}).code;
  assert.ok(js.includes('const _el1 = await getEl("#n", 5000);') && js.includes('const _el2 = await getEl("#q", 5000);'));
  assert.doesNotMatch(js, /const _findText/);
});

test('the in-page Text search finds what playback finds: the innermost exact text, or by tag', async () => {
  const { FIND_TEXT_JS } = await import('../popup/export/page-js.js');
  const el = (tagName, text, kids = []) => ({ tagName, textContent: text, kids, contains(o) { return o === this || kids.some((k) => k.contains(o)); } });
  const span = el('SPAN', 'OK'), button = el('BUTTON', 'OK', [span]), other = el('BUTTON', 'OK Cancel'), body = el('BODY', 'OK Cancel OK', [other, button]);
  const order = [other, button, span];
  globalThis.document = {
    body, querySelectorAll: (t) => order.filter((e) => e.tagName === t.toUpperCase()),
    createTreeWalker: (root, _what, filter) => {
      const nodes = order.filter((n) => filter.acceptNode(n) === 1);
      return { nextNode: () => nodes.shift() ?? null };
    },
  };
  globalThis.NodeFilter = { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  try {
    const find = new Function(`return (${FIND_TEXT_JS})`)();
    assert.equal(find(' OK ', ''), span, 'exact once trimmed, innermost; "OK Cancel" is not it');
    assert.equal(find('OK', 'button'), button, 'a picked element is looked up by its tag');
    assert.equal(find('Nope', ''), null);
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
  }
});

test('Random: the length is capped at 512 in both exports and the preview, as a run caps it', async () => {
  const { parseRandomSpec, MAX_RANDOM_LENGTH } = await import('../shared/var-spec.js');
  assert.equal(MAX_RANDOM_LENGTH, 512);
  assert.deepEqual(parseRandomSpec('{random:alpha:9999}'), { type: 'alpha', length: 512 });
  assert.deepEqual(parseRandomSpec('{random:numeric:512}'), { type: 'numeric', length: 512 });
  const steps = [{ type: 'input', selector: '#o', selectors: { css: '#o' }, value: '${big} ${small}' }];
  const v = { big: '{random:alpha:9999}', small: '{random:numeric:12}' };
  const js = generateBookmarklet('rand', steps, v).code;
  assert.match(js, /_gen_big = \(\) => Array\.from\(\{length:512\}/);
  assert.match(js, /_gen_small = \(\) => Array\.from\(\{length:12\}/);
  const py = generateSeleniumPy('rand', steps, v).code;
  assert.match(py, /^big = ''\.join\(random\.choices\(string\.ascii_letters, k=512\)\)$/m);
  assert.match(py, /^small = ''\.join\(random\.choices\(string\.digits, k=12\)\)$/m);
});

test('the Selenium script switches stdout to UTF-8 before its first print', () => {
  // A redirected stdout on Windows is cp1252: printing ✅ or "Đăng nhập" raised UnicodeEncodeError.
  const { code } = generateSeleniumPy('Đăng nhập', [{ type: 'click', selector: '#a', selectors: { css: '#a' } }], {});
  const lines = code.split('\n');
  const reconfigure = lines.indexOf('    sys.stdout.reconfigure(encoding="utf-8")');
  const firstPrint = lines.findIndex((l) => /\bprint\(/.test(l));
  assert.match(code, /^import sys$/m);
  assert.ok(reconfigure > 0 && reconfigure < firstPrint, `reconfigure at ${reconfigure}, first print at ${firstPrint}`);
  assert.equal(compilePy(code), null);
});

// One step of each kind the Actions tab tells apart; step 2 is disabled, so numbers are the scenario's own.
const stepKinds = [
  { type: 'navigate', url: 'https://example.com/' },
  { type: 'click', selector: '#off', selectors: { css: '#off' }, disabled: true },
  { type: 'click', selector: '#a', selectors: { css: '#a' } },
  { type: 'uploadFile', selector: '#f', selectors: { css: '#f' }, folderPath: 'C:\in', fileNames: ['a.txt'] },
  { type: 'teleport', selector: '#t' },
  { type: 'script', code: 'console.log(1)' },
  { type: 'click', selector: '#in-frame', selectors: { css: '#in-frame' }, frameId: 3 },
  { type: 'screenshot' },
];
const statusOf = (steps) => Object.fromEntries(steps.map((s) => [s.n, s.status]));

test('each export says, step by step, what it exported, skipped or wants checked', () => {
  const py = generateSeleniumPy('kinds', stepKinds, {});
  assert.deepEqual(statusOf(py.steps), { 1: 'ok', 3: 'ok', 4: 'skip', 5: 'skip', 6: 'verify', 7: 'verify', 8: 'ok' });
  const js = generateBookmarklet('kinds', stepKinds, {});
  assert.deepEqual(statusOf(js.steps), { 1: 'verify', 3: 'ok', 4: 'skip', 5: 'skip', 6: 'verify', 7: 'verify', 8: 'skip' });
  for (const { steps } of [py, js]) {
    assert.ok(steps.every((s) => s.type === stepKinds[s.n - 1].type), 'each step names its action type');
    assert.ok(steps.filter((s) => s.status !== 'ok').every((s) => s.reason), 'a step not exported as is says why');
    assert.match(steps.find((s) => s.n === 7).reason, /iframe/);
  }
  // Upload File and an unknown type are skipped by the code, so they count as skipped.
  assert.deepEqual([py.stats.supported, py.stats.skipped], [5, 2]);
  assert.deepEqual([js.stats.supported, js.stats.skipped], [4, 3]);
});

test('a Switch block is one skipped step per action in it', () => {
  const { steps, stats } = generateSeleniumPy('demo', actions, vars);
  assert.deepEqual(statusOf(steps), { 1: 'ok', 2: 'ok', 3: 'ok', 4: 'skip', 5: 'skip', 6: 'skip', 7: 'ok' });
  assert.match(steps.find((s) => s.n === 5).reason, /Switch block at step 4/);
  assert.equal(stats.skipped, 3);
  // The same in the bookmarklet, but for its step 1, a Navigate, which reloads the page there.
  assert.deepEqual(statusOf(generateBookmarklet('demo', actions, vars).steps), { ...statusOf(steps), 1: 'verify' });
});

test('the in-page Input chooses a <select> option as playback does, and fails on one it does not have', async () => {
  const { SET_INPUT_JS } = await import('../popup/export/page-js.js');
  globalThis.MouseEvent ??= class extends Event {};
  const setInput = new Function(`return (${SET_INPUT_JS})`)();
  const select = (value) => {
    const fired = [];
    return {
      tagName: 'SELECT', isContentEditable: false, value, fired,
      options: [{ value: 'r', text: 'Red' }, { value: 'g', text: 'Green' }],
      scrollIntoView() {}, focus() { fired.push('focus'); },
      dispatchEvent(e) { fired.push(e.type); },
    };
  };
  const el = select('r');
  setInput(el, 'Green'); // by its text, as playback falls back to
  assert.equal(el.value, 'g');
  assert.deepEqual(el.fired, ['focus', 'input', 'change', 'blur', 'click']);
  const kept = select('r');
  assert.throws(() => setInput(kept, 'Blue'), /The dropdown has no option "Blue"/);
  assert.equal(kept.value, 'r', 'the choice is left alone');
});

test('the bookmarklet clicks, hovers, types and drags with the in-page helpers', async () => {
  const { CLICK_JS, HOVER_JS, SET_INPUT_JS, DRAG_DROP_JS } = await import('../popup/export/page-js.js');
  const steps = [
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'hover', selector: '#m', selectors: { css: '#m' } },
    { type: 'input', selector: '#n', selectors: { css: '#n' }, value: 'x' },
    { type: 'dragdrop', selector: '#s', selectors: { css: '#s' }, targetSelector: '#t', targetSelectors: { css: '#t' } },
    { type: 'click', selector: '#p', selectors: { css: '#p' }, conditions: { textContains: 'Bob' } },
  ];
  const { code } = generateBookmarklet('acts', steps, {});
  for (const line of ['_click(_el1);', '_hover(_el2);', '_setInput(_el3, "x");', '_dragDrop(_el4_s, _el4_t);', '_click(_el5);']) {
    assert.ok(code.includes(`    ${line}\n`), line);
  }
  for (const src of [CLICK_JS, HOVER_JS, SET_INPUT_JS, DRAG_DROP_JS]) {
    assert.ok(code.includes(src.split('\n').map((l) => `  ${l}`).join('\n').trimStart()), 'declared from page-js');
  }
  assert.doesNotMatch(code, /^\s+_el\d+\.click\(\);$|const setInput/m, 'no click or Input of its own');
  new Function(code.replace(/^javascript:/, ''));
});

test('Selenium fills a field send_keys cannot with the in-page Input', async () => {
  const { SET_INPUT_JS } = await import('../popup/export/page-js.js');
  const steps = [
    { type: 'input', selector: '#when', selectors: { css: '#when' }, value: '2026-10-10' },
    { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Alice' },
  ];
  const { code } = generateSeleniumPy('fields', steps, {});
  // A date's typed format follows the browser's locale; a color or a range takes no typing.
  assert.match(code, /^_SCRIPT_INPUT_TYPES = \("date", "time", "datetime-local", "month", "week", "color", "range"\)$/m);
  assert.match(code, /^ {4}elif el1\.get_attribute\("type"\) in _SCRIPT_INPUT_TYPES:\n {8}driver\.execute_script\(_SET_INPUT_JS, el1, "2026-10-10"\)\n {4}else:\n {8}el1\.clear\(\)$/m);
  assert.ok(code.includes(SET_INPUT_JS), 'run from page-js as is');
  assert.match(code, /^ {8}el2\.send_keys\("Alice"\)$/m, 'any other field is still typed into');
  assert.equal(compilePy(code), null);
});

test('the bookmarklet lists a locator once: an id and the CSS #id are the same selector', () => {
  const steps = [{ type: 'click', selector: '#n', selectors: { id: 'n', css: '#n', xpath: '//*[@id="n"]' } },
    { type: 'click', selector: '#m', selectors: { id: 'm', css: '#m' } }];
  const { code } = generateBookmarklet('dedupe', steps, {});
  assert.ok(code.includes(`const _el1 = await getEl(["#n", ${JSON.stringify('//*[@id="n"]')}], 5000);`));
  assert.ok(code.includes('const _el2 = await getEl("#m", 5000);'), 'one left: the short form');
});
