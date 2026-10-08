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
    execFileSync('python', ['-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
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
  assert.match(code, /if \(_qsel\("#x"\) !== null\) \{\n\s+\/\/ Step 2: click/);
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
    execFileSync('python', ['-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    assert.fail(String(e.stderr || e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Python's verdict on generated code: null when it compiles (or there is no Python here), else the error. */
function compilePy(code) {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-'));
  const file = join(dir, 'gen.py');
  writeFileSync(file, code);
  try {
    execFileSync('python', ['-c', `compile(open(r"${file}", encoding="utf-8").read(), "gen.py", "exec")`], { stdio: 'pipe' });
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
    assert.match(line.trim(), /^\/\/|true \/\* unknown: /, line);
  }
  new Function(js.code.replace(/^javascript:/, ''));
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

test('both exports try the selector type chosen in the form first, as playback does', () => {
  const sels = { id: 'go', css: '#go-css', xpath: '//button[@id="go"]', name: 'q', text: 'it\'s "ok"' };
  const click = (selectorType) => ({ type: 'click', selector: '#go-css', selectors: sels, ...(selectorType ? { selectorType } : {}) });
  const steps = [
    click('css'), click('xpath'), click('name'), click('text'), click(null),
    { type: 'dragdrop', selector: '#go-css', selectors: sels, selectorType: 'css',
      targetSelector: '#t', targetSelectors: { css: '#t', xpath: '//div[@id="t"]' }, targetSelectorType: 'xpath' },
  ];
  const textXPath = `//*[contains(text(), concat('it', "'", 's "ok"'))]`;

  const py = generateSeleniumPy('choice', steps, {}).code;
  for (const [by, sel] of [['CSS_SELECTOR', '#go-css'], ['XPATH', '//button[@id="go"]'], ['NAME', 'q'],
    ['XPATH', textXPath], ['ID', 'go'], ['XPATH', '//div[@id="t"]']]) {
    assert.ok(py.includes(`By.${by}, ${JSON.stringify(sel)}`), `${by} ${sel}`);
  }
  assert.equal(compilePy(py), null);

  const js = generateBookmarklet('choice', steps, {}).code;
  for (const sel of ['#go-css', '//button[@id="go"]', '[name="q"]', textXPath, '//div[@id="t"]']) {
    assert.ok(js.includes(`getEl(${JSON.stringify(sel)}`), sel);
  }
  new Function(js.replace(/^javascript:/, ''));
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
