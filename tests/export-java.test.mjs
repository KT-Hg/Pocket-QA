// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateJava, javaText, javaIdent, javaClassName } = await import('../popup/export-java.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');
const { exportFileBase } = await import('../popup/export-modal.js');
const { SYNTHETIC_SCENARIOS, VARIABLE_SETS } = await import('./fixtures/synthetic.mjs');

// A JDK (PQA_JAVA_HOME) and a folder of the selenium-java and testng jars (PQA_JAVA_LIBS); without, those tests skip.
const JDK = process.env.PQA_JAVA_HOME || '';
const LIBS = process.env.PQA_JAVA_LIBS || '';
const bin = (tool) => join(JDK, 'bin', tool);
const NO_JDK = JDK && existsSync(bin(process.platform === 'win32' ? 'javac.exe' : 'javac')) ? false : 'no JDK (set PQA_JAVA_HOME)';
const NO_LIBS = NO_JDK || (LIBS && existsSync(LIBS) ? false : 'no selenium-java + testng jars (set PQA_JAVA_LIBS)');

function inTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-java-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TRICKY = ['plain', 'a\\b', 'end\\', '\\u0022', 'C:\\users\\u000a', '"q"', 'a\nb\r\tc', '\b\f', '\u0001\u001f\u007f1',
  'Tên có dấu 🎉', '\u2028', '${x}', '*/ /*', '\'s\'', ''];

test('java: text becomes a string literal holding exactly that text', () => {
  assert.equal(javaText('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(javaText('x\ny'), '"x\\ny"');
  assert.equal(javaText('\u00011'), '"\\0011"');
  assert.equal(javaText('\\u0022'), '"\\\\u0022"');
});

test('java: every tricky text comes back out of the JVM as it was', { skip: NO_JDK }, () => {
  inTemp((dir) => {
    const lines = TRICKY.map((s) => `        System.out.println(java.util.Base64.getEncoder().encodeToString(${javaText(s)}.getBytes(java.nio.charset.StandardCharsets.UTF_8)));`);
    writeFileSync(join(dir, 'Echo.java'), ['public class Echo {', '    public static void main(String[] args) {', ...lines, '    }', '}', ''].join('\n'));
    const res = spawnSync(bin('java'), ['-Dfile.encoding=UTF-8', join(dir, 'Echo.java')], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr);
    const got = res.stdout.split(/\r?\n/).slice(0, TRICKY.length).map((b) => Buffer.from(b, 'base64').toString('utf-8'));
    assert.deepEqual(got, TRICKY);
  });
});

test('java: variable and class names Java takes, a file and its class always one name', () => {
  assert.equal(javaIdent('user'), 'user');
  assert.equal(javaIdent('họ tên'), 'h__t_n');
  assert.equal(javaIdent('2fa'), '_fa');
  assert.equal(javaIdent('class'), 'class_v');
  assert.equal(javaIdent('driver'), 'driver_v');
  assert.equal(javaIdent('el3'), 'el3_v');
  assert.equal(javaIdent('_'), '__v');
  for (const name of ['Login Form', 'đăng nhập', '2fa login', 'a/b:c', '***', 'Test', 'x'.repeat(200), 'iPhone checkout']) {
    const cls = javaClassName(name);
    assert.match(cls, /^\p{L}[\p{L}\p{N}\p{M}]*Test$/u, name);
    assert.equal(javaClassName(exportFileBase(name)), cls, `${name}: the file's base gives the same class`);
  }
  assert.equal(javaClassName('Login Form'), 'LoginFormTest');
  assert.equal(javaClassName('đăng nhập'), 'ĐăngNhậpTest');
  assert.equal(javaClassName('2fa login'), 'Scenario2faLoginTest');
});

test('java: each step exported, skipped or to check as in the Selenium Python export', () => {
  for (const s of SYNTHETIC_SCENARIOS) {
    const py = generateSeleniumPy(s.name, structuredClone(s.actions), structuredClone(VARIABLE_SETS.configs));
    const java = generateJava(s.name, structuredClone(s.actions), structuredClone(VARIABLE_SETS.configs));
    const status = (steps) => steps.map((st) => `${st.n}:${st.status}`);
    assert.deepEqual(status(java.steps), status(py.steps), s.name);
    assert.deepEqual(java.stats, py.stats, s.name);
  }
});

test('java: a variable nothing defines is its ${name} text, as a run leaves it; a frame step looks in the frames', () => {
  const { code, warnings } = generateJava('v', [
    { type: 'navigate', url: 'https://x.test/' },
    { type: 'input', selector: '#a', selectors: { css: '#a' }, value: '${missing}', frameId: 2 },
  ], {});
  assert.match(code, /String missing = var\("missing", "\$\{missing\}"\);/);
  assert.ok(warnings.includes('${missing} is used by a step but not defined in the Variables tab'));
  assert.match(code, /WebElement el = locateInFrames\(locators\);/);
  assert.doesNotMatch(generateJava('t', [{ type: 'navigate', url: 'https://x.test/' }], {}).code, /locateInFrames/);
});

// Text javac would read as code if a \u in it were left as is: in a label, and in
// a dropdown's item number, which reaches the step comment through stepWhat.
const NASTY = [
  { type: 'navigate', url: 'https://x.test/' },
  { type: 'click', selector: '#a', selectors: { css: '#a' }, label: 'C:\\users\\u000a System.exit(1); */' },
  { type: 'dropdown', selector: '#dd', selectors: { css: '#dd' }, pick: { index: '1\\u000a } System.exit(1); //', itemSelector: '' } },
  { type: 'condition', conditionType: 'noSuchType', selector: '#b', selectors: { css: '#b' }, skipCount: 1 },
  { type: 'click', selector: '#c', selectors: { css: '#c' } },
  { type: 'uploadFile', selector: '#f', selectors: { css: '#f' } },
  { type: 'click', selector: '#d', selectors: { css: '#d' } },
];

test('java: every synthetic scenario compiles with selenium-java and testng', { skip: NO_LIBS }, () => {
  inTemp((dir) => {
    const files = [];
    let k = 0;
    const add = (name, actions, vars, opts) => {
      const cls = javaClassName(name);
      const code = generateJava(name, actions, vars, opts).code.replace(`public class ${cls} `, `public class ${cls}${k} `);
      files.push(join(dir, `${cls}${k}.java`));
      writeFileSync(files.at(-1), code);
      k++;
    };
    for (const s of SYNTHETIC_SCENARIOS) {
      for (const vars of Object.values(VARIABLE_SETS)) add(s.name, structuredClone(s.actions), structuredClone(vars), { headless: true });
    }
    add('nasty', NASTY, { class: 'x', driver: 'y' }, { driverType: 'Firefox' });
    const res = spawnSync(bin('javac'), ['-encoding', 'UTF-8', '-Werror', '-Xlint:all,-options,-serial', '-cp', join(LIBS, '*'),
      '-d', join(dir, 'out'), ...files], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});
