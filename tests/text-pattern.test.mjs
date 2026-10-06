// Read DOM "Extract" patterns (shared/text-pattern.js) and the step's written
// variables (writtenVarNames in shared/var-name.js).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const {
  extractWithPattern: x, patternError, patternVarNames, patternRegexSource, patternMismatch,
} = await import('../shared/text-pattern.js');
const { writtenVarNames } = await import('../shared/var-name.js');

const T = 'abc154 155';

test('the literal text around ${name} marks the part to keep', () => {
  assert.deepEqual(x(T, 'abc${value}'), { value: '154 155' });
  assert.deepEqual(x(T, 'abc${value} 155'), { value: '154' });
  assert.deepEqual(x(T, '${value}154 155'), { value: 'abc' });
  assert.deepEqual(x(T, '${value} 155'), { value: 'abc154' });
  assert.deepEqual(x(T, 'abc${a} ${b}'), { a: '154', b: '155' });
  assert.deepEqual(x(T, '${value}'), { value: T });
});

test('the pattern may sit anywhere; a ${name} at an edge runs to the text edge', () => {
  const L = 'Mã: abc154 155 (mới)';
  assert.deepEqual(x(L, 'abc${value} 155'), { value: '154' });
  assert.deepEqual(x(L, 'abc${value}'), { value: '154 155 (mới)' });
  assert.deepEqual(x(L, 'abc${value} ('), { value: '154 155' });
  assert.deepEqual(x(L, '${value} 155'), { value: 'Mã: abc154' });
  assert.equal(x(T, 'xyz${value}'), null);
});

test('a space matches any whitespace, values are trimmed', () => {
  assert.deepEqual(x('abc154\n   155', 'abc${value} 155'), { value: '154' });
  assert.deepEqual(x('abc154 155', 'abc${value} 155'), { value: '154' });
  assert.deepEqual(x('  Total:\n  1,250.00 $ ', 'Total: ${amount} $'), { amount: '1,250.00' });
});

test('letters match in either case unless matchCase', () => {
  assert.deepEqual(x('ABC154 155', 'abc${value} 155'), { value: '154' });
  assert.equal(x('ABC154 155', 'abc${value} 155', { matchCase: true }), null);
});

test('regex characters in the text are literal', () => {
  assert.deepEqual(x('Price (USD): $12.50 [x]', 'Price (USD): $${p} [x]'), { p: '12.50' });
  assert.equal(x('abc1', 'a.c${n}'), null);
});

test('patternError / patternVarNames / patternMismatch', () => {
  assert.equal(patternError('abc${value} 155'), '');
  assert.match(patternError('abc 155'), /Write \$\{name\}/);
  assert.match(patternError('abc${}'), /needs a variable name/);
  assert.match(patternError('${a}${b}'), /between/);
  assert.match(patternError('${a}-${a}'), /twice/);
  assert.deepEqual(patternVarNames('abc${ a } ${b}'), ['a', 'b']);
  assert.match(patternMismatch('x'.repeat(200), 'a${b}'), /…" does not match the Extract pattern a\$\{b\}$/);
});

test('writtenVarNames: Save to var, then the pattern names', () => {
  assert.deepEqual(writtenVarNames({ type: 'readdom', varName: '${full}', pattern: 'abc${a} ${b}' }), ['full', 'a', 'b']);
  assert.deepEqual(writtenVarNames({ type: 'readdom', pattern: '${a} 155' }), ['a']);
  assert.deepEqual(writtenVarNames({ type: 'screenshot_tovar', varName: 'shot', pattern: '${ignored}' }), ['shot']);
  assert.deepEqual(writtenVarNames({ type: 'click', varName: 'x' }), []);
});

test('Python re reads the regex source the same way (Selenium export)', () => {
  const cases = [[T, 'abc${value} 155'], ['Mã: abc154 155 (mới)', 'abc${value} ('], ['ABC154 155', 'abc${a} ${b}'],
    ['Price (USD): $12.50 [x]', 'Price (USD): $${p} [x]'], ['abc154\n 155', '${v} 155']];
  const py = 'import json, re, sys\n'
    + 'for text, src in json.loads(sys.stdin.read()):\n'
    + '    m = re.search(src, text, re.I)\n'
    + '    print(json.dumps([g.strip() for g in m.groups()] if m else None))';
  let out;
  try {
    out = execFileSync('python', ['-c', py], { input: JSON.stringify(cases.map(([t, p]) => [t, patternRegexSource(p)])) });
  } catch (e) {
    if (e.code === 'ENOENT') return; // no Python on this machine — nothing to check
    throw e;
  }
  const rows = out.toString().trim().split(/\r?\n/).map((l) => JSON.parse(l));
  cases.forEach(([t, p], i) => assert.deepEqual(rows[i], Object.values(x(t, p)), p));
});
