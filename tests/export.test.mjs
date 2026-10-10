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
  // A "Continue at" of its own: a block the exports leave out (their branches resume right after it).
  { type: 'switch', switchVar: '${who}', cases: [blk('a', 5, 5), blk('b', 6, 6)], continueAt: 7 },
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
  // A comment, the closing print, or the one string that names the step running.
  for (const line of py.code.split('\n').filter((l) => l.includes('INJECTED'))) {
    assert.match(line.trim(), /^#|^print\("✅|^_at = "(?:[^"\\]|\\.)*"$/, line);
  }
  assert.ok(py.warnings.some((w) => /type "isChecked/.test(w)), 'an unknown condition type is a warning');
  assert.equal(compilePy(py.code), null);

  const js = generateBookmarklet(HOSTILE_NAME, hostile, {});
  for (const line of js.code.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => l.includes('INJECTED'))) {
    assert.match(line.trim(), /^\/\/|^_at = "(?:[^"\\]|\\.)*";$/, line);
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
  // A CSS selector goes through _find, which looks inside shadow roots too, as playback does.
  assert.match(py, /el1 = _find\(\[\(By\.CSS_SELECTOR, "#n"\)\], 10, clickable=True\)/);
  // An id keeps the short form, with what it looked for as the message: WebDriverWait's own is empty.
  assert.match(py, /el2 = WebDriverWait\(driver, 10\)\.until\(EC\.presence_of_element_located\(\(By\.ID, "q"\)\), "no element found by id: q"\)/);
  const idOnly = generateSeleniumPy('short', [steps[1]], {}).code;
  assert.doesNotMatch(idOnly, /def _find|def _locate/, 'no helper it does not use');
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
  assert.match(py, /^big = _var\("big", ''\.join\(random\.choices\(string\.ascii_letters, k=512\)\)\)$/m);
  assert.match(py, /^small = _var\("small", ''\.join\(random\.choices\(string\.digits, k=12\)\)\)$/m);
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
  // Step 7 was recorded in a frame: Selenium looks for it there too, the bookmarklet in same-origin frames only.
  const py = generateSeleniumPy('kinds', stepKinds, {});
  assert.deepEqual(statusOf(py.steps), { 1: 'ok', 3: 'ok', 4: 'ok', 5: 'skip', 6: 'verify', 7: 'ok', 8: 'ok' });
  const js = generateBookmarklet('kinds', stepKinds, {});
  assert.deepEqual(statusOf(js.steps), { 1: 'verify', 3: 'ok', 4: 'skip', 5: 'skip', 6: 'verify', 7: 'verify', 8: 'skip' });
  assert.match(js.steps.find((s) => s.n === 7).reason, /iframe — a bookmarklet reaches only the frames of its own site/);
  assert.match(js.code, /const _el7 = await getEl\("#in-frame", 5000, _inFrames\);/);
  assert.match(js.code, /const getEl = \(sels, timeout = 5000, find = _first\) =>/);
  assert.doesNotMatch(generateBookmarklet('top', [stepKinds[2]], {}).code, /_inFrames|find = _first/, 'none without a step in a frame');
  new Function(js.code.replace(/^javascript:/, ''));
  for (const { steps } of [py, js]) {
    assert.ok(steps.every((s) => s.type === stepKinds[s.n - 1].type), 'each step names its action type');
    assert.ok(steps.filter((s) => s.status !== 'ok').every((s) => s.reason), 'a step not exported as is says why');
  }
  // What the code leaves out counts as skipped: an unknown type in both, Upload File in the bookmarklet.
  assert.deepEqual([py.stats.supported, py.stats.skipped], [6, 1]);
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

test('Selenium uploads files into a file input, and drops them on a drop zone, as playback does', () => {
  const up = (extra) => ({ type: 'uploadFile', selector: '#f', selectors: { css: '#f' }, ...extra });
  const steps = [
    up({ folderPath: 'C:\\in\\', fileNames: ['a.txt', '${name}'] }),
    up({ folderPath: '/home/me/in', fileName: 'old.txt' }),
    up({ folderPath: 'C:\\in', fileNames: ['a.txt'], uploadMode: 'dropzone' }),
    up({ folderPath: '', fileNames: ['a.txt'] }),
  ];
  const { code, steps: status } = generateSeleniumPy('upload', steps, { name: 'b.txt' });
  // The folder loses its trailing separators and keeps its own kind; ${var} names are f-strings.
  assert.ok(code.includes('    el1.send_keys("\\n".join(["C:\\\\in\\\\a.txt", f"C:\\\\in\\\\{name}"]))\n'), 'several files, one per line');
  assert.ok(code.includes('    el2.send_keys("/home/me/in/old.txt")\n'), 'an older action with one fileName');
  assert.match(code, /^ {4}el1 = _find\(\[\(By\.CSS_SELECTOR, "#f"\)\], 10\)$/m,
    'present is enough: pages hide their file inputs');
  // A drop zone: the files set on a hidden file input (the bridge playback adds), then dropped on the zone.
  assert.match(code, /^ {4}# Step 3: upload file to a drop zone\n {4}_at = .*\n {4}el3 = _find\(\[\(By\.CSS_SELECTOR, "#f"\)\], 10\)\n {4}el3_b = driver\.execute_script\(_DROP_BRIDGE_JS\)\n {4}el3_b\.send_keys\("C:\\\\in\\\\a\.txt"\)\n {4}driver\.execute_script\(_DROP_FILES_JS, el3, el3_b\)$/m);
  assert.match(code, /^_DROP_FILES_JS = r"""return \(/m);
  assert.match(code, /^ {4}raise Exception\("Upload File \(step 4\): missing folder or file name\(s\)"\)$/m);
  assert.deepEqual(status.map((s) => s.status), ['ok', 'ok', 'ok', 'verify']);
  assert.equal(compilePy(code), null);
});

test('Selenium saves the whole page for a full-page screenshot, the way each driver can', () => {
  const steps = [
    { type: 'screenshot_full' },
    { type: 'screenshot_tovar', varName: 'shot', target: 'full' },
    { type: 'screenshot_tovar', varName: 'view', target: 'page' },
  ];
  // Chrome and Edge: through CDP, beyond the window.
  for (const driverType of ['Chrome', 'Edge']) {
    const { code, steps: status } = generateSeleniumPy('full', steps, {}, { driverType });
    assert.match(code, /^ {4}_save_full_page\(f"screenshot_full_step1\.png"\)$/m, driverType);
    assert.match(code, /^ {4}_save_full_page\(_ss_file2\)$/m, 'a full-page screenshot into a variable too');
    assert.match(code, /^ {4}driver\.save_screenshot\(_ss_file3\)$/m, 'the visible part stays the visible part');
    assert.match(code, /^import base64$/m);
    assert.match(code, /^def _save_full_page\(path\):$/m);
    assert.match(code, /"captureBeyondViewport": True/);
    assert.doesNotMatch(code, /requires a compatible driver/);
    assert.ok(status.every((s) => s.status === 'ok'));
    assert.equal(compilePy(code), null);
  }
  // The browser it runs in decides (PQA_BROWSER may not be the one exported): Firefox
  // has its own, Safari saves the window only — exported for Safari, the step says so.
  const ff = generateSeleniumPy('full', steps, {}, { driverType: 'Firefox' });
  assert.match(ff.code, /^ {4}_save_full_page\(f"screenshot_full_step1\.png"\)$/m);
  assert.match(ff.code, /^ {4}if hasattr\(driver, "save_full_page_screenshot"\):\n {8}driver\.save_full_page_screenshot\(path\)$/m);
  assert.match(ff.code, /^ {4}if not hasattr\(driver, "execute_cdp_cmd"\):\n {8}driver\.save_screenshot\(path\)$/m);
  assert.equal(compilePy(ff.code), null);
  const safari = generateSeleniumPy('full', steps, {}, { driverType: 'Safari' });
  assert.match(safari.code, /^ {4}_save_full_page\(f"screenshot_full_step1\.png"\)$/m);
  assert.deepEqual(safari.steps.map((s) => s.status), ['verify', 'verify', 'ok']);
  assert.match(safari.steps[0].reason, /Safari/);
});

test('a bookmarklet that starts with a Navigate opens the page and stops, and plays on once there', async () => {
  const steps = [{ type: 'navigate', url: 'https://shop.test/cart/' }, { type: 'wait', delay: 0 }];
  const { code, steps: status } = generateBookmarklet('nav', steps, {});
  // What a click on the bookmark runs, on a page at `href`: where it sent the page, what it said, whether it finished.
  const click = async (href) => {
    const seen = { alerts: [], done: false, location: { href } };
    const saved = { location: globalThis.location, alert: globalThis.alert, log: console.log };
    globalThis.location = seen.location;
    globalThis.alert = (m) => seen.alerts.push(m);
    console.log = (m) => { if (/completed/.test(m)) seen.done = true; };
    try {
      await new Function(`return ${code.slice('javascript:'.length)}`)();
    } finally {
      Object.assign(globalThis, { location: saved.location, alert: saved.alert });
      if (saved.location === undefined) delete globalThis.location;
      if (saved.alert === undefined) delete globalThis.alert;
      console.log = saved.log;
    }
    return seen;
  };
  const elsewhere = await click('https://shop.test/home');
  assert.equal(elsewhere.location.href, 'https://shop.test/cart/', 'sent to the page');
  assert.equal(elsewhere.alerts.length, 1, 'and told to run the bookmark again');
  assert.equal(elsewhere.done, false, 'nothing after the Navigate ran');
  for (const there of ['https://shop.test/cart/', 'https://shop.test/cart', 'https://shop.test/cart#top']) {
    const again = await click(there);
    assert.deepEqual([again.location.href, again.alerts.length, again.done], [there, 0, true], there);
  }
  assert.equal(status[0].status, 'verify');
  assert.match(status[0].reason, /run the bookmark again/);
});

test('a bookmarklet goes on across the pages of its site, a click per page, redirected or not', async () => {
  // Scripts record what ran, and the value of a Random variable each time.
  const steps = [
    { type: 'navigate', url: 'https://shop.test/a' },
    { type: 'script', code: 'globalThis.__seen.push("s2 " + tok)' },
    { type: 'navigate', url: 'https://shop.test/b' },
    { type: 'script', code: 'globalThis.__seen.push("s4 " + tok)' },
    { type: 'navigate', url: 'https://other.test/' },
    { type: 'script', code: 'globalThis.__seen.push("s6")' },
  ];
  const { code, steps: status } = generateBookmarklet('multi', steps, { tok: '{random:alpha:8}' });
  const storage = new Map();
  // A click on the bookmark on a page at `href`: where it sent the page, and what it said.
  const click = async (href) => {
    const seen = { alerts: [], location: { href, origin: new URL(href).origin } };
    Object.assign(globalThis, {
      location: seen.location, alert: (m) => seen.alerts.push(m), __seen: globalThis.__seen || [],
      sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    });
    try {
      await new Function(`return ${code.slice('javascript:'.length)}`)();
    } finally {
      for (const k of ['location', 'alert', 'sessionStorage']) delete globalThis[k];
    }
    return seen;
  };
  try {
    globalThis.__seen = [];
    assert.equal((await click('https://shop.test/home')).location.href, 'https://shop.test/a', 'step 1 opens its page');
    // Redirected to a login page: the next click goes on all the same.
    assert.equal((await click('https://shop.test/login')).location.href, 'https://shop.test/b', 'steps 2–3 ran, step 3 opened its page');
    const last = await click('https://shop.test/b');
    assert.equal(last.location.href, 'https://other.test/', 'step 5 opens another site');
    assert.match(last.alerts[0], /another site/);
    const [s2, s4] = globalThis.__seen;
    assert.match(s2, /^s2 [a-zA-Z]{8}$/);
    assert.equal(s4, `s4 ${s2.slice(3)}`, 'the variables come back on the next page');
    assert.equal(globalThis.__seen.length, 2, 'nothing after a Navigate to another site');
    assert.equal(storage.size, 0, 'nothing left to go on from');
  } finally {
    delete globalThis.__seen;
  }
  assert.deepEqual(status.map((s) => s.status), ['verify', 'verify', 'verify', 'verify', 'verify', 'verify']);
  assert.match(status[2].reason, /run the bookmark again on it to play on \(a page of the same site only\)/);
  // A Navigate first only: as it was (golden).
  assert.doesNotMatch(generateBookmarklet('one', steps.slice(0, 2), {}).code, /_resumeKey|_from/);
});

test('Selenium Headless: each driver its own way, and none for Safari', () => {
  const steps = [{ type: 'click', selector: '#a', selectors: { css: '#a' } }];
  const head = (driverType) => generateSeleniumPy('h', steps, {}, { driverType, headless: true });
  // The browser and the window exported are the defaults of PQA_BROWSER and PQA_HEADLESS.
  for (const driverType of ['Chrome', 'Edge', 'Firefox']) {
    const { code } = head(driverType);
    assert.ok(code.includes(`    name = os.environ.get("PQA_BROWSER", "${driverType}")\n    headless = os.environ.get("PQA_HEADLESS", "1") == "1"\n`), driverType);
    assert.match(code, /^driver = _start_browser\(\)$/m);
    assert.equal(compilePy(code), null);
  }
  // Headless has no screen: the size of a desktop window, each browser by its own flag.
  assert.match(head('Chrome').code, /^ {8}options\.add_argument\("--headless=new"\)\n {8}options\.add_argument\("--window-size=1920,1080"\)$/m);
  assert.match(head('Firefox').code, /^ {8}options\.add_argument\("-headless"\)\n {8}options\.add_argument\("--width=1920"\)\n {8}options\.add_argument\("--height=1080"\)$/m);
  const safari = head('Safari');
  assert.match(safari.code, /^ {4}if name == "Safari":\n {8}return webdriver\.Safari\(\) {2}# no headless mode$/m);
  assert.ok(safari.warnings.some((w) => /Safari has no headless mode/.test(w)));
  // Off, the script opens its window as it always did.
  assert.match(generateSeleniumPy('h', steps, {}, { driverType: 'Edge' }).code, /os\.environ\.get\("PQA_HEADLESS", "0"\)/);
});

test('Selenium: a driver name that is not one of the four becomes Chrome, never code', () => {
  const steps = [{ type: 'click', selector: '#a', selectors: { css: '#a' } }];
  for (const driverType of ['Chrome(); import os', 'Opera', '']) {
    const { code } = generateSeleniumPy('d', steps, {}, { driverType });
    assert.match(code, /os\.environ\.get\("PQA_BROWSER", "Chrome"\)/, JSON.stringify(driverType));
    // The file imports os itself: what must not be there is the name's own text.
    assert.doesNotMatch(code, /Chrome\(\); import os/);
  }
});

test('Selenium as a pytest test: a fixture opens and quits the browser, the steps are the test', () => {
  const steps = [
    { type: 'readdom', selector: '#n', selectors: { css: '#n' }, varName: 'seed', readFrom: 'text' },
    { type: 'input', selector: '#o', selectors: { css: '#o' }, value: '${salute} ${seed}' },
  ];
  const vars = { salute: 'Hi', seed: 'INIT' };
  const { code } = generateSeleniumPy('Đăng nhập "admin"', steps, vars, { output: 'pytest', startUrl: 'https://shop.test/' });
  assert.match(code, /^import pytest$/m);
  // The helpers use the module's `driver`; the fixture starts it and always quits it.
  assert.ok(code.includes('\ndriver = None\n\n\n@pytest.fixture\ndef browser():\n'), 'a fixture named browser');
  assert.ok(code.includes('    global driver\n    driver = _start_browser()\n    yield driver\n    driver.quit()\n'));
  // The test: named after the scenario, letters folded to ASCII; it opens the start page.
  // Its steps in a try whose error names the step that failed.
  assert.match(code, /^def test_dang_nhap_admin\(browser\):\n {4}_at = ""\n {4}try:\n {8}driver\.get\(_url\("https:\/\/shop\.test\/"\)\)$/m);
  assert.match(code, /^ {4}except Exception as e:\n {8}_save_failure\(\)\n {8}raise Exception\(f"\{_at or 'Error'\}: \{e\}"\) from e$/m);
  // Variables inside the test: a step writing `seed` makes it a local of the function.
  assert.match(code, /^ {8}salute = _var\("salute", "Hi"\)$/m);
  assert.match(code, /^ {8}seed = _var\("seed", "INIT"\)$/m);
  assert.match(code, /^ {8}seed = _read_val\(el1, "text", ""\)$/m);
  // pytest reports the failure; the script's own prints and module-level try / except are gone.
  assert.doesNotMatch(code, /print\(|^try:|^except|reconfigure|^import sys$/m);
  assert.equal(compilePy(code), null);

  const head = generateSeleniumPy('x', steps, vars, { output: 'pytest', driverType: 'Edge', headless: true }).code;
  assert.ok(head.includes('    name = os.environ.get("PQA_BROWSER", "Edge")\n    headless = os.environ.get("PQA_HEADLESS", "1") == "1"\n'));
  assert.equal(compilePy(head), null);
});

test('Selenium as a script, the default, is unchanged by the pytest option', () => {
  const steps = [{ type: 'click', selector: '#a', selectors: { css: '#a' } }];
  assert.equal(generateSeleniumPy('s', steps, {}, { output: 'script' }).code, generateSeleniumPy('s', steps, {}).code);
  assert.doesNotMatch(generateSeleniumPy('s', steps, {}).code, /pytest/);
});

/** Node's verdict on a generated spec, as an ES module: null when it parses, else the error. */
function checkModule(code) {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'gen.spec.mjs');
  writeFileSync(file, code);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (e) {
    return String(e.stderr || e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run a generated spec against a fake Playwright: `test` keeps the test function,
 * `page` records every call. Returns the calls, as "method arg…" strings; their
 * `steps`, the test.step titles in the order they ran.
 */
async function runSpec(code, { kind = 'text', checks = {}, text = 'read' } = {}) {
  const calls = [];
  const fmt = (v) => (typeof v === 'function' ? 'fn' : JSON.stringify(v));
  const READS = ['text', 'visible', 'value', 'attr'];
  const locator = (sel) => {
    const el = {
      sel,
      first: () => el,
      count: async () => 1,
      elementHandle: async () => el,
      click: async () => calls.push(`click ${sel}`),
      hover: async () => calls.push(`hover ${sel}`),
      fill: async (v) => calls.push(`fill ${sel} ${fmt(v)}`),
      screenshot: async (o) => calls.push(`shot ${sel} ${fmt(o)}`),
      dragTo: async (t) => calls.push(`drag ${sel} ${t.sel}`),
      setInputFiles: async (f) => calls.push(`upload ${sel} ${fmt(f)}`),
      // A Child Condition's search: the child it finds.
      evaluateHandle: async (fn, cond) => ({ asElement: () => locator(`child of ${sel} ${fmt(cond)}`) }),
      // _input asks the field's kind first; Read DOM reads; the rest is a page function on the element.
      evaluate: async (fn, arg) => {
        if (arg === undefined) return kind;
        if (Array.isArray(arg) && READS.includes(arg[0])) { calls.push(`read ${sel} ${fmt(arg)}`); return text; }
        calls.push(`evaluate ${sel} ${fmt(arg)}`);
        return undefined;
      },
    };
    return el;
  };
  const page = {
    locator,
    // The hidden file input an upload to a drop zone fills.
    evaluateHandle: async () => ({ asElement: () => locator('bridge') }),
    goto: async (u) => calls.push(`goto ${u}`),
    waitForTimeout: async (ms) => calls.push(`wait ${ms}`),
    // A string is a script step; a function with [type, element, expected] a Condition.
    evaluate: async (src, arg) => {
      if (typeof src !== 'function') return calls.push(`script ${fmt(src)}`);
      calls.push(`check ${arg[0]} ${arg[1] ? arg[1].sel : null} ${fmt(arg[2])}`);
      return checks[arg[0]] ?? true;
    },
    screenshot: async (o) => calls.push(`shot page ${fmt(o)}`),
  };
  let body = null;
  // Not enumerable: a deepEqual of the calls leaves it out.
  Object.defineProperty(calls, 'steps', { value: [] });
  const step = async (title, fn) => { calls.steps.push(title); return fn(); };
  const test = Object.assign((name, fn) => { body = fn; }, { use() {}, setTimeout() {}, step });
  const js = code.replace(/^import \{ test \} from '@playwright\/test';$/m, '');
  new Function('test', js)(test);
  await body({ page });
  return calls;
}

test('Playwright: a spec npx playwright test runs, each step through the page', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const steps = [
    { type: 'navigate', url: 'https://shop.test/' },
    { type: 'input', selector: '#user', selectors: { css: '#user', id: 'user' }, value: '${user}' },
    { type: 'click', selector: '#go', selectors: { id: 'go', css: '#go-css', xpath: '//button[@id="go"]' } },
    { type: 'click', selectors: { text: 'OK' }, selectorType: 'text' },
    { type: 'hover', selectors: { text: 'Menu', textTag: 'li' } },
    { type: 'wait', delay: 250 },
    { type: 'script', code: 'console.log("${user}")' },
    { type: 'screenshot_full' },
    { type: 'screenshot_tovar', varName: 'shot', target: 'element', selector: '#card', selectors: { css: '#card' } },
  ];
  const { code, steps: status } = generatePlaywright('Log in', steps, { user: 'bob' }, { stepDelay: 0, elTimeout: 4000 });
  assert.match(code, /^import \{ test \} from '@playwright\/test';$/m);
  assert.match(code, /^const TIMEOUT = 4000;$/m);
  assert.match(code, /^test\("Log in", async \(\{ page \}\) => \{$/m);
  assert.equal(checkModule(code), null);
  // The locators in playback's order, through _find when there are several; one stays a plain locator.
  assert.match(code, /const el2 = page\.locator\("#user"\)\.first\(\);/);
  assert.match(code, /const el3 = await _find\(page, \["#go", "xpath=\/\/button\[@id=\\"go\\"\]", "#go-css"\]\);/);
  assert.match(code, /const el4 = page\.locator\("text=\\"OK\\""\)\.first\(\);/);
  assert.match(code, /const el5 = page\.locator\("li:text-is\(\\"Menu\\"\)"\)\.first\(\);/);
  const calls = await runSpec(code);
  assert.deepEqual(calls, [
    'goto https://shop.test/',
    'fill #user "bob"',
    'click #go',
    'click text="OK"',
    'hover li:text-is("Menu")',
    'wait 250',
    'script "console.log(\\"bob\\")"',
    'shot page {"path":"screenshot_full_step8.png","fullPage":true}',
    'shot #card {"path":"screenshot_shot_step9.png"}',
  ]);
  // Each step a test.step of the report, named as its comment.
  assert.deepEqual(calls.steps, ['Step 1: navigate', 'Step 2: input', 'Step 3: click', 'Step 4: click', 'Step 5: hover', 'Step 6: wait',
    'Step 7: script', 'Step 8: screenshot (full page)', 'Step 9: screenshot → variable "shot"']);
  assert.match(code, /^ {2}\/\/ Step 3: click\n {2}await test\.step\("Step 3: click", async \(\) => \{\n {4}const el3 = /m);
  assert.deepEqual(status.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'verify', 'ok', 'ok'], 'a script, as in the other exports, is to check');
  // A date (or color, range, <select>) goes through the extension's own setter, as playback sets it.
  const date = generatePlaywright('d', [{ type: 'input', selector: '#d', selectors: { css: '#d' }, value: '2026-10-10' }], {}, { stepDelay: 0 }).code;
  assert.deepEqual(await runSpec(date, { kind: 'date' }), ['goto https://your-url-here.com', 'evaluate #d "2026-10-10"']);
});

test('Playwright: Conditions decide with the in-page check, and guard their steps', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const steps = [
    { type: 'condition', conditionType: 'textContains', selector: '#greet', selectors: { css: '#greet' }, expectedValue: '${who}', skipCount: 1 },
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'condition', conditionType: 'urlContains', expectedValue: 'cart', skipCount: 1 },
    { type: 'click', selector: '#b', selectors: { css: '#b' } },
    { type: 'condition', conditionType: 'isChecked', selector: '#c', selectors: { css: '#c' }, skipCount: 1 },
    { type: 'click', selector: '#d', selectors: { css: '#d' } },
  ];
  const { code, steps: status, warnings } = generatePlaywright('conds', steps, { who: 'Bob' }, { stepDelay: 0 });
  // The check is a test.step of its own; the steps it guards are theirs.
  assert.match(code, /^ {2}if \(await test\.step\("Step 1: condition — textContains", async \(\) => page\.evaluate\(_checkCond, \["textContains", await _first\(page, \["#greet"\]\), `\$\{who\}`\]\)\)\) \{$/m);
  assert.match(code, /^ {2}if \(await test\.step\("Step 3: condition — urlContains", async \(\) => page\.evaluate\(_checkCond, \["urlContains", null, "cart"\]\)\)\) \{$/m);
  // An unknown type stops there, as a run does; its name stays in the comment.
  assert.match(code, /^ {2}throw new Error\("Condition step 5: unknown condition type, named in the comment above"\);\n {2}if \(true\) \{$/m);
  assert.ok(warnings.some((w) => /Condition step 5: type "isChecked" is unknown/.test(w)));
  assert.deepEqual(status.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'verify', 'ok']);
  assert.equal(checkModule(code), null);
  const calls = await runSpec(code.replace(/^ {2}throw new Error\("Condition step 5.*$/m, ''), { checks: { textContains: false, urlContains: true } });
  assert.deepEqual(calls.filter((c) => !c.startsWith('goto')), [
    'check textContains #greet "Bob"', 'check urlContains null "cart"', 'click #b', 'click #d',
  ], 'the guarded step runs only when its check holds');
  assert.deepEqual(calls.steps, ['Step 1: condition — textContains', 'Step 3: condition — urlContains', 'Step 4: click', 'Step 6: click']);
});

test('Playwright: Child Condition, Read DOM, Choose item #, drag and Upload File, as the other exports do them', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const { FIND_CHILD_JS, READ_VAL_JS, PICK_ITEM_JS } = await import('../popup/export/page-js.js');
  const steps = [
    { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { matchMode: 'all', textContains: '${who}', classContains: 'row' } },
    { type: 'readdom', selector: '#t', selectors: { css: '#t' }, varName: 'full', readFrom: 'visible', pattern: 'Total: ${amount}' },
    { type: 'dropdown', selector: '#dd', selectors: { css: '#dd' }, pick: { by: 'index', index: '-1', itemSelector: '#menu li' } },
    { type: 'dragdrop', selector: '#s', selectors: { css: '#s' }, targetSelector: '#z', targetSelectors: { css: '#z' } },
    { type: 'uploadFile', selector: '#f', selectors: { css: '#f' }, folderPath: 'C:\\in\\', fileNames: ['a.txt', '${name}'] },
    { type: 'uploadFile', selector: '#zone', selectors: { css: '#zone' }, folderPath: 'C:\\in', fileNames: ['a.txt'], uploadMode: 'dropzone' },
    { type: 'input', selector: '#o', selectors: { css: '#o' }, value: '${full} ${amount}' },
  ];
  const { code, steps: status } = generatePlaywright('more', steps, { who: 'Bob', name: 'b.txt' }, { stepDelay: 0 });
  // The extension's own in-page code, written out once each.
  assert.ok(code.includes(FIND_CHILD_JS) && code.includes(READ_VAL_JS), 'Child Condition and Read DOM as the page-js sources');
  assert.ok(code.includes(PICK_ITEM_JS.split('\n').map((l) => `  ${l}`).join('\n')), 'Choose item # inside _pick');
  assert.match(code, /const el1 = \(await el1_p\.evaluateHandle\(_findChild, \{matchMode: "all", textContains: `\$\{who\}`, classContains: "row"\}\)\)\.asElement\(\);/);
  assert.match(code, /if \(!el1\) throw new Error\('Child condition not matched \(step 1\)'\);/);
  assert.match(code, /const el2_m = new RegExp\(.*, "i"\)\.exec\(el2_t\);/);
  assert.deepEqual(status.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(checkModule(code), null);
  const calls = await runSpec(code, { text: 'Total: 42' });
  assert.deepEqual(calls.filter((c) => !c.startsWith('goto')), [
    'click child of #people {"matchMode":"all","textContains":"Bob","classContains":"row"}',
    'read #t ["visible",""]',
    'evaluate #dd ["-1","#menu li",10000]',
    'drag #s #z',
    'upload #f ["C:\\\\in\\\\a.txt","C:\\\\in\\\\b.txt"]',
    // A drop zone: the files on a hidden file input, then dropped on the zone.
    'upload bridge ["C:\\\\in\\\\a.txt"]',
    'evaluate #zone {"sel":"bridge"}',
    'fill #o "Total: 42 42"',
  ], 'the extract fills its variables, and the step after uses them');
});

test('a Wait waits what playback waits, and only a number reaches the code', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const { waitMs } = await import('../shared/wait-ms.js');
  // An imported scenario can hold anything in `delay`; each export writes it into code.
  const evil = '0); alert(document.cookie); (0';
  const steps = [
    { type: 'wait', delay: evil },
    { type: 'wait', value: '250' },
    { type: 'wait' },
    { type: 'wait', delay: 0, value: '700' },
    { type: 'wait', delay: -5 },
    { type: 'click', selector: '#a', selectors: { css: '#a' }, delay: evil },
  ];
  assert.deepEqual(steps.slice(0, 5).map(waitMs), [0, 250, 500, 700, 0], 'what a run waits: parseInt reads the leading 0; setTimeout waits no less than 0');
  const bm = generateBookmarklet('w', steps, {}).code;
  const pw = generatePlaywright('w', steps, {}, { stepDelay: 0 }).code;
  const py = generateSeleniumPy('w', steps, {}, { stepDelay: 0 }).code;
  for (const code of [bm, pw, py]) assert.ok(!code.includes('document.cookie'), 'the delay is never code');
  assert.deepEqual([...bm.matchAll(/await sleep\((.*)\);/g)].map((m) => m[1]).slice(0, 5), ['0', '250', '500', '700', '0']);
  assert.deepEqual([...pw.matchAll(/waitForTimeout\((.*)\);/g)].map((m) => m[1]), ['0', '250', '500', '700', '0']);
  assert.deepEqual([...py.matchAll(/time\.sleep\((.*)\)/g)].map((m) => m[1]), ['0', '0.25', '0.5', '0.7', '0']);
  assert.equal(checkModule(pw), null);
  new Function(bm.replace(/^javascript:/, ''));
});

/** Python's verdict on a generated script: null when it compiles (or there is no Python), else the error. */
function checkPython(code) {
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

test('Selenium: a one-line Script that ends in a quote still compiles', () => {
  for (const code of ['window.done = "yes"', 'window.done = "${who}"', 'window.done = "a\\""']) {
    const py = generateSeleniumPy('q', [{ type: 'script', code }], { who: 'Bob' }).code;
    assert.equal(checkPython(py), null, code);
    assert.match(py, /^ {4}"""\)$/m, 'the closing quotes on their own line');
  }
});

test('a ${ that names no variable stays text in the JS exports, as in a run', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const { jsValue, jsIdentifier } = await import('../popup/export/js-code.js');
  const { applyVars } = await import('../bg/interpolate.js');
  const values = ['price ${', 'a ${} b', 'tick ` and ${who}', 'cost $${who}', 'x \\ ${who} ${', '${who}${'];
  const value = jsValue(jsIdentifier(new Set()));
  for (const v of values) {
    assert.equal(new Function('who', `return ${value(v)};`)('Bob'), applyVars(v, { who: 'Bob' }), v);
  }
  const steps = values.map((v) => ({ type: 'input', selector: '#a', selectors: { css: '#a' }, value: v }));
  new Function(generateBookmarklet('d', steps, { who: 'Bob' }).code.replace(/^javascript:/, ''));
  assert.equal(checkModule(generatePlaywright('d', steps, { who: 'Bob' }).code), null);
});

test('a variable never takes a name the generated code uses for itself', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const el = { selector: '#a', selectors: { css: '#a' } };
  const read = { type: 'readdom', ...el, readFrom: 'text' };

  // Bookmarklet: `location` would hide the page's own for the first Navigate's check.
  const bmVars = { location: 'Hanoi', alert: 'a', domVar: 'd', _el2: 'e' };
  const bm = generateBookmarklet('n', [{ type: 'navigate', url: 'https://a.test/' },
    { type: 'input', ...el, value: '${location} ${alert} ${domVar} ${_el2}' }, read], bmVars).code;
  assert.match(bm, /const location_v = "Hanoi";/);
  assert.match(bm, /_setInput\(_el2, `\$\{location_v\} \$\{alert_v\} \$\{domVar_v\} \$\{_el2_v\}`\);/);
  assert.match(bm, /_at1\(location\.href\)/, 'the page\'s own location');
  new Function(bm.replace(/^javascript:/, ''));

  // Playwright: the steps' elements share the test function with the variables.
  const pw = generatePlaywright('n', [{ type: 'click', ...el }, { type: 'input', ...el, value: '${el2} ${el2_t}' }, read],
    { el2: 'x', el2_t: 'y' }, { stepDelay: 0 }).code;
  assert.equal(checkModule(pw), null);
  const calls = await runSpec(pw);
  assert.ok(calls.includes('fill #a "x y"'), calls.join('\n'));

  // Selenium: step 2's element was written over the variable el2; `re` hid the module.
  const py = generateSeleniumPy('n', [{ type: 'click', ...el }, { type: 'input', ...el, value: '${el2} ${re} ${dom_var} ${open}' },
    { ...read, pattern: 'Total: ${amount}' }, read], { el2: 'x', re: 'r', dom_var: 'd', open: 'o' }).code;
  assert.match(py, /^el2_v = _var\("el2", "x"\)$/m);
  assert.match(py, /^re_v = _var\("re", "r"\)$/m);
  assert.match(py, /send_keys\(f"\{el2_v\} \{re_v\} \{dom_var_v\} \{open_v\}"\)/);
  assert.equal(checkPython(py), null);
});

test('a step with two reasons to check it lists both', () => {
  const { steps } = generateBookmarklet('r', [{ type: 'script', code: 'go()', frameId: 3 }], {});
  assert.equal(steps[0].status, 'verify');
  assert.match(steps[0].reason, /iframe/);
  assert.match(steps[0].reason, /custom JS/);
});

test('a disabled step inside a Switch block is not counted as skipped', () => {
  const steps = [
    { type: 'switch', switchVar: '${who}', cases: [blk('a', 2, 3)] },
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'click', selector: '#b', selectors: { css: '#b' }, disabled: true },
  ];
  assert.deepEqual(generateBookmarklet('b', steps, { who: 'a' }).steps.map((s) => s.n), [1, 2]);
});

test('Selenium: literal braces beside a variable stay characters in the f-string', () => {
  const py = generateSeleniumPy('b', [{ type: 'input', selector: '#a', selectors: { css: '#a' }, value: '{"id":1} for ${host}' }], { host: 'x' }).code;
  assert.match(py, /send_keys\(f"\{\{\\"id\\":1\}\} for \{host\}"\)/);
  assert.equal(checkPython(py), null);
});

test('Choose item # at random never picks a <select>\'s empty option, as a run does not', async () => {
  const { PICK_ITEM_JS } = await import('../popup/export/page-js.js');
  const pickItem = new Function('sleep', `${PICK_ITEM_JS}\nreturn _pickItem;`)(() => Promise.resolve());
  const el = { tagName: 'SELECT', options: [{ value: '' }, { value: 'a' }, { value: 'b' }], selectedIndex: 0, dispatchEvent() {} };
  const random = Math.random;
  Math.random = () => 0;
  try {
    await pickItem(el, 'random', '', 0);
  } finally {
    Math.random = random;
  }
  assert.equal(el.selectedIndex, 1, 'the first item with a value');
});

test('the export modal\'s Actions tab: a badge for every action type the exports know, and what each step does', async () => {
  const { ACT_TYPE_INFO, actionDesc } = await import('../popup/export-modal.js');
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const { readFileSync } = await import('node:fs');
  // Every name the exporters switch on, and the keys of Playwright's table: action
  // types among them, and locator or condition types the generators turn down.
  const src = ['export-bookmarklet', 'export-selenium', 'export-playwright']
    .map((f) => readFileSync(new URL(`../popup/${f}.js`, import.meta.url), 'utf8')).join('\n');
  const names = new Set(['condition', ...[...src.matchAll(/case '(\w+)':|^ {2}(\w+): /gm)].map((m) => m[1] || m[2])]);
  const unknown = 'not an action type this version knows';
  const known = [...names].filter((type) => [generateBookmarklet, generateSeleniumPy, generatePlaywright].some((gen) => {
    const [step] = gen('t', [{ type, selector: '#a', selectors: { css: '#a' } }], {}).steps;
    return step && step.reason !== unknown;
  }));
  assert.ok(known.includes('uploadFile') && known.includes('click') && !known.includes('xpath'), known.join());
  assert.deepEqual(known.filter((type) => !ACT_TYPE_INFO[type]), [], 'types the exports know with no badge in the Actions tab');

  assert.equal(actionDesc({ type: 'screenshot_full' }), 'full page');
  assert.equal(actionDesc({ type: 'screenshot' }), 'viewport');
  assert.equal(actionDesc({ type: 'condition', conditionType: 'elementExists', selectors: { css: '.welcome' } }), 'elementExists · .welcome');
  assert.equal(actionDesc({ type: 'condition', conditionType: 'urlContains', expectedValue: '/home' }), 'urlContains · /home');
});

test('the export code colours: joined, the pieces are the code of every golden export, line for line', async () => {
  const { highlightLines } = await import('../popup/export/highlight.js');
  const { readFileSync } = await import('node:fs');
  let checked = 0;
  for (const [file, lang] of [['export-bookmarklet', 'js'], ['export-selenium', 'py'], ['export-playwright', 'js']]) {
    const golden = JSON.parse(readFileSync(new URL(`./golden/${file}.json`, import.meta.url), 'utf8'));
    for (const [key, { code }] of Object.entries(golden)) {
      if (typeof code !== 'string') continue;
      const lines = highlightLines(code, lang);
      assert.equal(lines.map((pieces) => pieces.map(([text]) => text).join('')).join('\n'), code, `${file}: ${key}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} golden exports`);
});

test('the export code colours: strings, comments and keywords, each where it is', async () => {
  const { highlightLines } = await import('../popup/export/highlight.js');
  const kinds = (code, lang) => highlightLines(code, lang).map((pieces) => pieces.filter(([, k]) => k).map(([t, k]) => `${k}:${t}`));
  assert.deepEqual(kinds('x = "a # b"  # note\nif x is None: pass', 'py'),
    [['str:"a # b"', 'cmt:# note'], ['kw:if', 'kw:is', 'kw:None', 'kw:pass']]);
  assert.deepEqual(kinds('s = f"{a}\'" + r\'\d\'\n"""one\n# two"""', 'py'),
    [['str:f"{a}\'"', 'str:r\'\d\''], ['str:"""one'], ['str:# two"""']]);
  assert.deepEqual(kinds('const u = "http://x"; // go\nlet t = `a ${b ? "}" : `c`} d`;', 'js'),
    [['kw:const', 'str:"http://x"', 'cmt:// go'], ['kw:let', 'str:`a ${', 'str:"}"', 'str:`c`} d`']]);
  assert.deepEqual(kinds('if (/["\']/.test(s)) return a / b / c; x.default', 'js'),
    [['kw:if', 'str:/["\']/', 'kw:return']]);
});

test('the three exports warn alike about the variables: one identifier for two names, a name that is not one, a Fallback', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const steps = [{ type: 'input', selector: '#a', selectors: { css: '#a' }, value: '${a-b} ${a_b} ${city}' }];
  const vars = { 'a-b': '1', a_b: '2', city: '{fallback:Hanoi|Hue}' };
  for (const [gen, lang] of [[generateBookmarklet, 'JS'], [generateSeleniumPy, 'Python'], [generatePlaywright, 'JS']]) {
    const { warnings } = gen('v', steps, vars);
    assert.ok(warnings.includes(`"a-b" and "a_b" both become the ${lang} identifier \`a_b\` — rename one`), `${gen.name}: ${warnings}`);
    assert.ok(warnings.includes(`"a-b" is not a valid ${lang} identifier — exported as \`a_b\``), `${gen.name}: ${warnings}`);
    assert.ok(warnings.some((w) => w.startsWith('"city" is a Fallback variable')), `${gen.name}: ${warnings}`);
  }
});

test('bookmarklet: _findChild is declared only for a step with a Child Condition', () => {
  const click = { type: 'click', selector: '#a', selectors: { css: '#a' } };
  assert.doesNotMatch(generateBookmarklet('b', [click], {}).code, /_findChild/);
  const code = generateBookmarklet('b', [{ ...click, conditions: { textContains: 'x' } }], {}).code;
  assert.match(code, /const _findChild = /);
  new Function(code.replace(/^javascript:/, ''));
});

test('an error names the step that failed: one line per step that runs records it', () => {
  const steps = [
    { type: 'click', selector: '#a', selectors: { css: '#a' } },
    { type: 'condition', conditionType: 'elementExists', selector: '#b', selectors: { css: '#b' }, skipCount: 1 },
    { type: 'click', selector: '#c', selectors: { css: '#c' }, label: 'Sign in' },
    { type: 'screenshot' },
  ];
  const ats = (code) => code.split('\n').filter((l) => /^\s*_at = "Step \d+: /.test(l)).map((l) => l.trim());
  // The bookmarklet skips the screenshot: no line for it.
  assert.deepEqual(ats(generateBookmarklet('e', steps, {}).code),
    ['_at = "Step 1: click";', '_at = "Step 2: condition — elementExists";', '_at = "Step 3: click — Sign in";']);
  const py = generateSeleniumPy('e', steps, {}).code;
  assert.deepEqual(ats(py),
    ['_at = "Step 1: click"', '_at = "Step 2: condition — elementExists"', '_at = "Step 3: click — Sign in"', '_at = "Step 4: screenshot (visible)"']);
  assert.match(py, /^ {4}print\(f"❌ \{_at or 'Error'\}: \{e\}"\)$/m);
  assert.match(generateBookmarklet('e', steps, {}).code, /alert\('Error' \+ \(_at \? ' at ' \+ _at : ''\) \+ ': ' \+ err\.message\);/);
  assert.equal(compilePy(py), null);
});

test('the environment changes an exported run without an export: PQA_<name>, PQA_BASE_URL', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const steps = [
    { type: 'input', selector: '#u', selectors: { css: '#u' }, value: '${user}' },
    { type: 'navigate', url: 'https://shop.test/cart' },
    { type: 'navigate', url: 'https://other.test/x' },
  ];
  const opts = { stepDelay: 0, startUrl: 'https://shop.test/login?next=1#top' };
  const pw = generatePlaywright('env', steps, { user: 'bob' }, opts).code;
  assert.match(pw, /^\/\/ {3}PQA_<name> {4}a variable's value: PQA_user$/m);
  assert.match(pw, /^ {2}const user = _var\("user", "bob"\);$/m);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { PQA_user: 'amy', PQA_BASE_URL: 'https://staging.shop.test/app/' });
    assert.deepEqual(await runSpec(pw), ['goto https://staging.shop.test/app/login?next=1#top', 'fill #u "amy"',
      'goto https://staging.shop.test/app/cart', 'goto https://other.test/x'], 'the first page\'s site moves; another site stays');
    delete process.env.PQA_user;
    delete process.env.PQA_BASE_URL;
    assert.deepEqual(await runSpec(pw), ['goto https://shop.test/login?next=1#top', 'fill #u "bob"',
      'goto https://shop.test/cart', 'goto https://other.test/x'], 'unset: as exported');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }

  // Selenium's _var and _url, run by Python itself.
  const py = generateSeleniumPy('env', steps, { user: 'bob' }, opts).code;
  assert.match(py, /^user = _var\("user", "bob"\)$/m);
  assert.match(py, /^driver\.get\(_url\("https:\/\/shop\.test\/login\?next=1#top"\)\)$/m);
  const helpers = py.slice(py.indexOf('def _var('), py.indexOf('def _start_browser('));
  const probe = `import os\nfrom urllib.parse import urlsplit, urlunsplit\n${helpers}\n`
    + 'print(_var("user", "bob"), _url("https://shop.test/login?next=1#top"), _url("https://shop.test/cart"), _url("https://other.test/x"))';
  try {
    const out = execFileSync('python', ['-c', probe], { env: { ...process.env, PQA_user: 'amy', PQA_BASE_URL: 'https://staging.shop.test/app/' } }).toString().trim();
    assert.equal(out, 'amy https://staging.shop.test/app/login?next=1#top https://staging.shop.test/app/cart https://other.test/x');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // no Python on this machine — nothing to run
  }
});

test('a data file: a test per row; pytest reads the CSV as the CSV run does', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const { parseCSV } = await import('../popup/csv/csv-parse.js');
  const steps = [{ type: 'navigate', url: '${page}' }, { type: 'input', selector: '#n', selectors: { css: '#n' }, value: '${who}' }];
  const py = generateSeleniumPy('csv', steps, { who: 'Zed' }, { output: 'pytest', dataFile: 'data.csv' });
  assert.match(py.code, /^@pytest\.mark\.parametrize\("_row", _rows\("data\.csv"\)\)\ndef test_csv\(browser, _row\):$/m);
  assert.match(py.code, /^ {8}who = _row\.get\("who", _var\("who", "Zed"\)\)$/m, 'a column wins, then the environment, then the variable');
  assert.match(py.code, /^ {8}page = _column\(_row, "page"\)$/m, 'a name only a column gives');
  assert.deepEqual(py.warnings, ['${page} is not in the Variables tab: it comes from the column "page" of data.csv']);
  assert.equal(compilePy(py.code), null);
  // The Script runs once: no data file there.
  assert.doesNotMatch(generateSeleniumPy('csv', steps, { who: 'Zed' }, { dataFile: 'data.csv' }).code, /_rows|parametrize/);

  const pw = generatePlaywright('csv', steps, { who: 'Zed' }, { dataFile: 'data.csv' }).code;
  assert.match(pw, /^for \(const \[n, _row\] of _rows\("data\.csv"\)\.entries\(\)\) \{\n {2}test\("csv" \+ ' #' \+ \(n \+ 1\), async \(\{ page \}\) => \{$/m);
  assert.match(pw, /^ {4}const who = _row\["who"\] \?\? _var\("who", "Zed"\);$/m);
  assert.equal(checkModule(pw), null);

  // _rows, run by Python on CSV text the CSV run reads: the same rows.
  const texts = [
    '\uFEFFname;note\r\nAnn;"two\nlines"\r\n  Bo  ;" kept "\r\n\r\n',
    'a,b,c\n1,"x, ""y""",\n2\n',
    'a\tb\n1\t2',
  ];
  const helpers = py.code.slice(py.code.indexOf('def _rows('), py.code.indexOf('def _column('));
  const dir = mkdtempSync(join(tmpdir(), 'pqa-csv-'));
  try {
    texts.forEach((t, k) => writeFileSync(join(dir, `d${k}.csv`), t));
    writeFileSync(join(dir, 'probe.py'), `import json, os\n${helpers}\nprint(json.dumps([_rows(f"d{k}.csv") for k in range(${texts.length})]))\n`);
    const out = execFileSync('python', [join(dir, 'probe.py')], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).toString();
    assert.deepEqual(JSON.parse(out), texts.map((t) => parseCSV(t).rows));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // no Python on this machine — nothing to run
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a step recorded in a frame: Selenium and Playwright look for its element in the frames too', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const steps = [
    { type: 'input', selector: '#fName', selectors: { css: '#fName' }, value: 'Zoe', frameId: 7 },
    { type: 'click', selector: '#after', selectors: { id: 'after' } },
    { type: 'condition', conditionType: 'elementExists', selector: '#x', selectors: { css: '#x' }, frameId: 7, skipCount: 1 },
    { type: 'script', code: 'go()' },
  ];
  const py = generateSeleniumPy('frames', steps, {});
  // Every lookup from the page and into its frames: a framed step leaves the driver in its frame.
  assert.match(py.code, /^ {4}el1 = _find\(\[\(By\.CSS_SELECTOR, "#fName"\)\], 10, frames=True\)$/m);
  assert.match(py.code, /^ {4}el2 = _find\(\[\(By\.ID, "after"\)\], 10, clickable=True, frames=True\)$/m);
  assert.match(py.code, /^def _locate_in_frames\(locators\):$/m);
  assert.match(py.code, /^def _check_cond\(cond_type, locators, expected\):\n {4}driver\.switch_to\.default_content\(\)$/m);
  assert.match(py.code, /^ {8}driver\.switch_to\.default_content\(\)\n {8}driver\.execute_script\("""go\(\)"""\)$/m, 'a script runs in the page');
  assert.deepEqual(statusOf(py.steps), { 1: 'ok', 2: 'ok', 3: 'verify', 4: 'verify' }, 'a Condition is still checked in the page');
  assert.equal(compilePy(py.code), null);

  const pw = generatePlaywright('frames', steps, {}, { stepDelay: 0 });
  assert.match(pw.code, /const el1 = await _inFrames\(page, \["#fName"\]\);/);
  assert.match(pw.code, /const el2 = page\.locator\("#after"\)\.first\(\);/, 'a step of the page stays one');
  assert.deepEqual(statusOf(pw.steps), { 1: 'ok', 2: 'ok', 3: 'verify', 4: 'verify' });
  assert.equal(checkModule(pw.code), null);
  // No step in a frame: none of it.
  assert.doesNotMatch(generateSeleniumPy('top', [steps[1]], {}).code, /frames|_locate_in_frames/);
});

test('a Switch block of ranges written as branches on its variable, as a run picks the case', async () => {
  const { generatePlaywright } = await import('../popup/export-playwright.js');
  const self = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
  const steps = [
    { type: 'switch', switchVar: 'role', cases: [self('admin', 2, 2), self('user', 3, 4), { value: 'none', scenarioId: '__self__', empty: true },
      self('__default__', 6, 6)] },
    { type: 'click', selector: '#admin', selectors: { css: '#admin' } },
    { type: 'click', selector: '#user', selectors: { css: '#user' } },
    { type: 'click', selector: '#user2', selectors: { css: '#user2' }, disabled: true },
    { type: 'click', selector: '#orphan', selectors: { css: '#orphan' } },
    { type: 'click', selector: '#other', selectors: { css: '#other' } },
    { type: 'click', selector: '#after', selectors: { css: '#after' } },
  ];
  const vars = { role: 'user' };
  const py = generateSeleniumPy('sw', steps, vars);
  assert.match(py.code, /^ {4}if f"\{role\}" == "admin":\n {8}# Step 2: click$/m);
  assert.match(py.code, /^ {4}elif f"\{role\}" == "user":\n {8}# Step 3: click$/m);
  assert.match(py.code, /^ {4}elif f"\{role\}" == "none":\n {8}pass\n {4}else:\n {8}# Step 6: click$/m);
  assert.doesNotMatch(py.code, /#orphan/, 'in no case: never runs');
  // Each step in order: the Switch and its cases' steps OK, the action in no case skipped.
  assert.deepEqual(statusOf(py.steps), { 1: 'ok', 2: 'ok', 3: 'ok', 5: 'skip', 6: 'ok', 7: 'ok' });
  assert.match(py.steps.find((s) => s.n === 5).reason, /in none of its cases/);
  assert.ok(!py.warnings.some((w) => /Switch block/.test(w)));
  assert.equal(compilePy(py.code), null);

  const js = generateBookmarklet('sw', steps, vars).code;
  assert.match(js, /if \(role === "admin"\) \{|if \(`\$\{role\}` === "admin"\) \{/);
  assert.match(js, /\} else \{\n {6}\/\/ Step 6: click/);
  new Function(js.replace(/^javascript:/, ''));
  const pw = generatePlaywright('sw', steps, vars, { stepDelay: 0 });
  assert.equal(checkModule(pw.code), null);
  // On the fake page: only the user case's step, then the step after the block.
  const calls = await runSpec(pw.code);
  assert.deepEqual(calls.filter((c) => c.startsWith('click')), ['click #user', 'click #after']);

  // A case that plays another scenario, or jumps: the block is left out as before.
  const jump = [{ ...steps[0], cases: [...steps[0].cases, { value: 'x', scenarioId: 'other-id' }] }, ...steps.slice(1)];
  assert.match(generateSeleniumPy('sw', jump, vars).code, /switch block \[SKIPPED\]/);
});
