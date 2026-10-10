// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateRobot, robotText, robotIdent } = await import('../popup/export-robot.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');
const { SYNTHETIC_SCENARIOS, VARIABLE_SETS } = await import('./fixtures/synthetic.mjs');

// A Python with Robot Framework and SeleniumLibrary: PQA_ROBOT_PYTHON, else `python`; none, those tests skip.
const ROBOT_PY = process.env.PQA_ROBOT_PYTHON || 'python';
const hasRobot = spawnSync(ROBOT_PY, ['-c', 'import robot, SeleniumLibrary'], { stdio: 'ignore' }).status === 0;
const NO_ROBOT = hasRobot ? false : `no Robot Framework with SeleniumLibrary in ${ROBOT_PY} (set PQA_ROBOT_PYTHON)`;

function robot(files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-robot-'));
  try {
    const paths = Object.entries(files).map(([name, text]) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    });
    return spawnSync(ROBOT_PY, ['-m', 'robot', '--outputdir', join(dir, 'out'), '--console', 'quiet', ...args, ...paths], { encoding: 'utf-8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TRICKY = ['plain', 'a\\b', 'end\\', '\\', '${x}', '@{x}', '&{x}', '%{x}', '\\${x}', '$', '${', '#x', 'a#b', 'x  #y',
  'x=1', 'msg=hi', 'a=b=c', 'a\nb', 'a\rb', 'a\tb', 'a  b', 'a  b', '　x', ' lead', 'trail ', 'a  b', '   ',
  'a   b  ', '...', 'ELSE', 'AND', 'x y', 'Tên có dấu 🎉', '"q" \'s\' `b`', '', '\u0001'];

test('robot: text becomes one argument with exactly that value', () => {
  assert.equal(robotText(''), '${EMPTY}');
  assert.equal(robotText('a\\b'), 'a\\\\b');
  assert.equal(robotText('${x} @{y} &{z} %{w}'), '\\${x} \\@{y} \\&{z} \\%{w}');
  assert.equal(robotText('#x'), '\\#x');
  assert.equal(robotText('a#b'), 'a#b');
  assert.equal(robotText('msg=hi'), 'msg\\=hi');
  assert.equal(robotText('a b=c'), 'a b=c');
  assert.equal(robotText('a\nb\rc\td'), 'a\\nb\\rc\\td');
  assert.equal(robotText('a b'), 'a\\u00a0b');
  assert.equal(robotText(' a  b '), '${SPACE}a${SPACE} b${SPACE}');
  assert.equal(robotText('   '), '${SPACE}${SPACE}${SPACE}');
});

test('robot: every tricky text reaches a keyword as it was', { skip: NO_ROBOT }, () => {
  const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
  const lines = TRICKY.flatMap((s, k) => [
    `    \${want}=    Evaluate    base64.b64decode('${b64(s)}').decode('utf-8')`,
    `    Should Be Equal    ${robotText(s)}    \${want}    case ${k}    values=False`,
  ]);
  const res = robot({ 'escapes.robot': ['*** Test Cases ***', 'Escapes', ...lines, ''].join('\n') });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('robot: variable names Robot can use, not one it or the test has', () => {
  assert.equal(robotIdent('user'), 'user');
  assert.equal(robotIdent('họ tên'), 'h__t_n');
  assert.equal(robotIdent('2fa'), '_fa');
  assert.equal(robotIdent('22'), 'v__2');
  assert.equal(robotIdent('EMPTY'), 'EMPTY_v');
  assert.equal(robotIdent('test_name'), 'test_name_v');
  assert.equal(robotIdent('pqa_at'), 'pqa_at_v');
  assert.equal(robotIdent('el3'), 'el3_v');
  assert.equal(robotIdent('sw_4'), 'sw_4_v');
  assert.equal(robotIdent('element'), 'element');
});

test('robot: values with variables, names Robot reads as one, Safari headless', () => {
  const acts = [
    { type: 'navigate', url: 'https://shop.test/${page}' },
    { type: 'input', selector: '#q', selectors: { css: '#q' }, value: '${user_name}  #${EMPTY}' },
  ];
  const { code, warnings } = generateRobot('demo', acts, { page: 'home', user_name: 'amy', UserName: 'bo', EMPTY: 'x' },
    { driverType: 'Safari', headless: true });
  assert.match(code, /Site URL {4}https:\/\/shop\.test\/\$\{page\}\n/);
  assert.match(code, /Set Input {4}\$\{el2\} {4}\$\{user_name\}\$\{SPACE\} #\$\{EMPTY_v\}\n/);
  assert.match(code, /\$\{user_name\}=    Set Variable    %\{PQA_user_name=\$\{user_name\}\}/);
  assert.ok(warnings.some((w) => /"user_name" and "UserName" are one variable to Robot/.test(w)), warnings.join('\n'));
  assert.ok(warnings.includes('Safari has no headless mode — the test opens a window'));
});

test('robot: each step exported, skipped or to check as in the Selenium export', () => {
  for (const s of SYNTHETIC_SCENARIOS) {
    const py = generateSeleniumPy(s.name, structuredClone(s.actions), structuredClone(VARIABLE_SETS.configs));
    const rf = generateRobot(s.name, structuredClone(s.actions), structuredClone(VARIABLE_SETS.configs));
    const status = (steps) => steps.map((st) => `${st.n}:${st.status}`);
    assert.deepEqual(status(rf.steps), status(py.steps), s.name);
    assert.deepEqual(rf.stats, py.stats, s.name);
  }
});

test('robot: every synthetic scenario passes a dry run', { skip: NO_ROBOT }, () => {
  const files = {};
  SYNTHETIC_SCENARIOS.forEach((s, k) => Object.entries(VARIABLE_SETS).forEach(([setName, vars]) => {
    files[`s${k}_${setName}.robot`] = generateRobot(s.name, structuredClone(s.actions), structuredClone(vars),
      { headless: true, startUrl: 'https://start.example/' }).code;
  }));
  const res = robot(files, ['--dryrun']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('robot: a step in a frame is looked for in the frames too', () => {
  const { code } = generateRobot('f', [
    { type: 'navigate', url: 'https://x.test/' },
    { type: 'click', selector: '#in', selectors: { css: '#in' }, frameId: 3 },
  ], {});
  assert.match(code, /\$\{el\}=    Locate In Frames    @\{locators\}/);
  assert.match(code, /^Locate In This Frame$/m);
  const top = generateRobot('t', [{ type: 'navigate', url: 'https://x.test/' }], {}).code;
  assert.doesNotMatch(top, /Locate In Frames/);
});
