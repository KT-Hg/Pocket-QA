// Random test-data variables (shared/test-data.js) in the five code exports: each
// draws its value by the run's rules. The JS generators are run here; the Python
// expressions run in the machine's Python when there is one (else skipped).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateBookmarklet } = await import('../popup/export-bookmarklet.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');
const { generatePlaywright } = await import('../popup/export-playwright.js');
const { generateRobot } = await import('../popup/export-robot.js');
const { generateJava } = await import('../popup/export-java.js');
const { pyTestDataExpr } = await import('../popup/export/test-data-code.js');
const { parseRandomSpec } = await import('../shared/var-spec.js');

const VARS = {
  mail: '{random:email:shop.test}',
  tel: '{random:phone:vn}',
  who: '{random:name:vi}',
  qty: '{random:int:3:7}',
  day: '{random:date:+1:dd/MM/yyyy}',
  id: '{random:uuid}',
};
const STEPS = [{ type: 'input', selector: '#o', selectors: { css: '#o' }, value: Object.keys(VARS).map((k) => `\${${k}}`).join(' ') }];

const tomorrow = () => {
  const t = new Date(); t.setDate(t.getDate() + 1);
  return `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}/${t.getFullYear()}`;
};
const SHAPES = {
  mail: /^qa_[a-z0-9]{6}@shop\.test$/,
  tel: /^0[35789]\d{8}$/,
  who: /^\S+ \S+ \S+$/u,
  qty: /^[3-7]$/,
  id: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
};
const checkValue = (k, v) => (k === 'day' ? assert.equal(v, tomorrow(), k) : assert.match(v, SHAPES[k], `${k}: ${v}`));

test('Bookmarklet and Playwright: each generator draws as a run draws', () => {
  const js = generateBookmarklet('td', STEPS, VARS).code;
  for (const k of Object.keys(VARS)) {
    const m = js.match(new RegExp(`const _gen_${k} = (.+);$`, 'm'));
    assert.ok(m, `bookmarklet _gen_${k}`);
    for (let n = 0; n < 20; n++) checkValue(k, new Function(`return (${m[1]})()`)());
  }
  const pw = generatePlaywright('td', STEPS, VARS).code;
  for (const k of Object.keys(VARS)) assert.match(pw, new RegExp(`const ${k} = _var\\("${k}", \\(\\(\\) =>`), `playwright ${k}`);
});

test('Selenium: imports timedelta and uuid only for the kinds that need them', () => {
  const py = generateSeleniumPy('td', STEPS, VARS).code;
  assert.match(py, /^from datetime import datetime, timedelta$/m);
  assert.match(py, /^import uuid$/m);
  assert.match(py, /^qty = _var\("qty", str\(random\.randint\(3, 7\)\)\)$/m);
  const plain = generateSeleniumPy('td', STEPS, { mail: VARS.mail }).code;
  assert.doesNotMatch(plain, /timedelta|import uuid/);
});

test('Robot and Java: the same kinds, through Evaluate and testData()', () => {
  const robot = generateRobot('td', STEPS, VARS).code;
  assert.match(robot, /\$\{day\}=    Evaluate    \(datetime\.datetime\.now\(\) \+ datetime\.timedelta\(days=1\)\)\.strftime\("%d\/%m\/%Y"\)/);
  // One cell: Robot splits a line at two spaces or more.
  const whoCell = (robot.split('\n').find((l) => l.includes('${who}=    Evaluate')) || '').split('Evaluate    ')[1];
  assert.ok(whoCell && !/ {2}|\t/.test(whoCell), whoCell);
  const java = generateJava('td', STEPS, VARS).code;
  assert.match(java, /String day = var\("day", testData\("date", "1", "dd\/MM\/yyyy"\)\);/);
  assert.match(java, /String qty = var\("qty", testData\("int", "3", "7"\)\);/);
  assert.match(java, /static String testData\(String kind, String\.\.\. args\)/);
  assert.match(java, /part\.split\("\\\\\|"\)/);
});

const python = (() => {
  for (const exe of ['python', 'python3']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); return exe; } catch { /* next */ }
  }
  return null;
})();

test('Python: the Selenium and Robot expressions run and draw as a run draws', { skip: !python && 'no Python on this machine' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-td-'));
  try {
    const lines = ['import random, string, uuid, datetime as _m', 'from datetime import datetime, timedelta', 'import json'];
    const out = [];
    for (const [k, v] of Object.entries(VARS)) {
      const spec = parseRandomSpec(v);
      lines.push(`${k} = ${pyTestDataExpr(spec)}`);
      // Robot's Evaluate names the datetime module: run that spelling with it in scope.
      lines.push(`${k}_robot = (lambda datetime: ${pyTestDataExpr(spec, { robot: true })})(_m)`);
      out.push(k, `${k}_robot`);
    }
    lines.push(`print(json.dumps({ ${out.map((n) => `"${n}": ${n}`).join(', ')} }, ensure_ascii=False))`);
    const file = join(dir, 'td.py');
    writeFileSync(file, lines.join('\n'), 'utf8');
    const got = JSON.parse(execFileSync(python, ['-X', 'utf8', file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
    for (const k of Object.keys(VARS)) { checkValue(k, got[k]); checkValue(k, got[`${k}_robot`]); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
