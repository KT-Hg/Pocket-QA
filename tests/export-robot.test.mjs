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
  assert.equal(robotText('*a'), '\\*a');   // a leading * (a section/settings or templated marker) is escaped
  assert.equal(robotText('a*b'), 'a*b');   // only at the start
  assert.equal(robotText('*Smoke test'), '\\*Smoke test');
  assert.equal(robotText('msg=hi'), 'msg\\=hi');
  assert.equal(robotText('a b=c'), 'a b=c');
  assert.equal(robotText('a\nb\rc\td'), 'a\\nb\\rc\\td');
  assert.equal(robotText('a b'), 'a\\u00a0b');
  assert.equal(robotText(' a  b '), '${SPACE}a${SPACE} b${SPACE}');
  assert.equal(robotText('   '), '${SPACE}${SPACE}${SPACE}');
});

test('robot: a scenario name that starts with * is one test case, not a section', { skip: NO_ROBOT }, () => {
  const { code } = generateRobot('*Smoke test', [
    { type: 'navigate', url: 'https://x.test/' },
    { type: 'input', selector: '#a', selectors: { css: '#a' }, value: '*also data' },
  ], {});
  const dir = mkdtempSync(join(tmpdir(), 'pqa-robot-'));
  try {
    const file = join(dir, 'star.robot');
    writeFileSync(file, code);
    const py = 'import sys, json\n'
      + 'from robot.api import get_model\n'
      + 'from robot.api.parsing import ModelVisitor\n'
      + 'tests = []\n'
      + 'class V(ModelVisitor):\n'
      + '    def visit_TestCase(self, node): tests.append(node.name)\n'
      + 'V().visit(get_model(sys.argv[1]))\n'
      + 'print(json.dumps(tests))\n';
    const res = spawnSync(ROBOT_PY, ['-c', py, file], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    // Exactly one test case — a `*…` line read as a section would give none — whose
    // name is the scenario's. get_model keeps the escape (\*Smoke test); a run unescapes it.
    const tests = JSON.parse(res.stdout);
    assert.equal(tests.length, 1, `one test case, got ${JSON.stringify(tests)}`);
    assert.match(tests[0], /Smoke test$/);
    assert.equal(robot({ 'star.robot': code }, ['--dryrun']).status, 0, 'a dry run accepts the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// Every character Python's str.splitlines() (and so Robot) breaks a line on, each
// followed by a marker, in a comment (the step label) and in a step comment built
// from text (the dropdown item number): none may open a keyword or a test case.
const SPLIT_MARK = 'PWN!PWN';
const SPLIT_POISON = 'x' + [13, 10, 11, 12, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]
  .map((c) => String.fromCharCode(c) + SPLIT_MARK).join('');

test("robot: a scenario's text opens no keyword or test of its own", { skip: NO_ROBOT }, () => {
  const { code } = generateRobot('Poison', [
    { type: 'navigate', url: 'https://x.test/' },
    { type: 'dropdown', selector: '#d', selectors: { css: '#d' }, pick: { index: SPLIT_POISON, itemSelector: '' }, label: SPLIT_POISON },
    { type: 'click', selector: '#c', selectors: { css: '#c' }, label: SPLIT_POISON },
  ], {});
  const dir = mkdtempSync(join(tmpdir(), 'pqa-robot-'));
  try {
    const file = join(dir, 'poison.robot');
    writeFileSync(file, code);
    // Parse with Robot's own parser; list the test cases and the keyword calls.
    const py = 'import sys, json\n'
      + 'from robot.api import get_model\n'
      + 'from robot.api.parsing import ModelVisitor\n'
      + 'tests = []; kws = []\n'
      + 'class V(ModelVisitor):\n'
      + '    def visit_TestCase(self, node): tests.append(node.name); self.generic_visit(node)\n'
      + '    def visit_KeywordCall(self, node): kws.append(node.keyword or "")\n'
      + 'V().visit(get_model(sys.argv[1]))\n'
      + 'print(json.dumps({"tests": tests, "kws": kws}))\n';
    const res = spawnSync(ROBOT_PY, ['-c', py, file], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const { tests, kws } = JSON.parse(res.stdout);
    // One test case — the scenario — and no keyword whose name is injected text.
    assert.deepEqual(tests, ['Poison'], `extra test case(s) from the scenario's text: ${JSON.stringify(tests)}`);
    assert.ok(!kws.some((k) => k.includes(SPLIT_MARK)), `a keyword name carries injected text: ${JSON.stringify(kws)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('robot: a data file gives a test per row through DataDriver, a column first', () => {
  const { ROBOT_READER_FILE } = REQUIRED;
  const steps = [{ type: 'navigate', url: '${page}' }, { type: 'input', selector: '#n', selectors: { css: '#n' }, value: '${who}' },
    { type: 'readdom', selector: '#t', varName: 'total' }];
  const { code, warnings } = generateRobot('Login CSV', steps, { who: 'Zed' }, { dataFile: 'data.csv' });
  assert.match(code, new RegExp(`^Library {13}DataDriver {4}file=data\.csv {4}reader_class=${ROBOT_READER_FILE.replace('.', '\.')}$`, 'm'));
  assert.match(code, /^Test Template {7}Pocket QA Row$/m);
  assert.match(code, /^\*\*\* Test Cases \*\*\*\nLogin CSV\n {4}\[Documentation\]/m, 'the test is only the template DataDriver copies');
  assert.match(code, /^Pocket QA Row\n {4}\[Documentation\].*\n {4}Set Test Variable {4}\$\{PQA_ROW\} {4}\$\{DataDriver_TEST_DATA\}\[arguments\]\n {4}Start Browser$/m);
  assert.match(code, /^ {4}\$\{who\}= {4}Row Value {4}who {4}\$\{who\}$/m, 'a column wins over the variable and PQA_who');
  assert.match(code, /^ {4}\$\{page\}= {4}Row Column {4}page$/m, 'a name only a column gives');
  assert.match(code, /^ {4}\$\{total\}= {4}Row Value {4}total {4}\$\{EMPTY\}$/m, 'a name a step writes, seeded by its column');
  assert.ok(warnings.some((w) => w.includes(ROBOT_READER_FILE)), 'the modal says the reader goes with it');
  // Without one: no trace of it.
  assert.doesNotMatch(generateRobot('Login CSV', steps, { who: 'Zed' }).code, /DataDriver|Test Template|Row Value|PQA_ROW/);
});

const REQUIRED = await import('../popup/export-robot.js');

test('robot: the DataDriver reader reads a CSV file as the CSV run does', async () => {
  const { robotReaderPy, ROBOT_READER_FILE } = REQUIRED;
  const { parseCSV } = await import('../popup/csv/csv-parse.js');
  const texts = ['﻿name;note\r\nAnn;"two\nlines"\r\n  Bo  ;" kept "\r\n\r\n', 'a,b,c\n1,"x, ""y""",\n2\n', 'a\tb\n1\t2'];
  const dir = mkdtempSync(join(tmpdir(), 'pqa-dd-'));
  try {
    // A stand-in for the two DataDriver classes the reader uses: the reader's own code is what runs.
    const pkg = join(dir, 'DataDriver');
    spawnSync(process.platform === 'win32' ? 'cmd' : 'mkdir', process.platform === 'win32' ? ['/c', 'mkdir', pkg] : [pkg]);
    writeFileSync(join(pkg, '__init__.py'), '');
    writeFileSync(join(pkg, 'AbstractReaderClass.py'), 'class AbstractReaderClass:\n    def __init__(self, file):\n        self.file = file\n');
    writeFileSync(join(pkg, 'ReaderConfig.py'), 'class TestCaseData:\n    def __init__(self, test_case_name="", arguments=None):\n'
      + '        self.test_case_name, self.arguments = test_case_name, arguments or {}\n');
    writeFileSync(join(dir, ROBOT_READER_FILE), robotReaderPy());
    texts.forEach((t, k) => writeFileSync(join(dir, `d${k}.csv`), t));
    writeFileSync(join(dir, 'probe.py'), ['import json, os, sys', 'sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))',
      'from pqa_csv_reader import pqa_csv_reader',
      `out = [[(t.test_case_name, t.arguments) for t in pqa_csv_reader(os.path.join(os.path.dirname(os.path.abspath(__file__)), f"d{k}.csv")).get_data_from_source()] for k in range(${texts.length})]`,
      'print(json.dumps(out))', ''].join('\n'));
    const res = spawnSync('python', [join(dir, 'probe.py')], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (res.error?.code === 'ENOENT') return; // no Python on this machine — nothing to run
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout);
    assert.deepEqual(got.map((f) => f.map(([, args]) => args)), texts.map((t) => parseCSV(t).rows));
    assert.deepEqual(got[0].map(([name]) => name), ['Row 1', 'Row 2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasDataDriver = hasRobot && spawnSync(ROBOT_PY, ['-c', 'import DataDriver'], { stdio: 'ignore' }).status === 0;

test('robot: with DataDriver, a dry run makes a test of each row', { skip: hasDataDriver ? false : 'no robotframework-datadriver (set PQA_ROBOT_PYTHON)' }, () => {
  const { robotReaderPy, ROBOT_READER_FILE } = REQUIRED;
  const { code } = generateRobot('Login CSV', [{ type: 'navigate', url: '${page}' }], {}, { dataFile: 'data.csv' });
  const dir = mkdtempSync(join(tmpdir(), 'pqa-ddrun-'));
  try {
    writeFileSync(join(dir, 'login.robot'), code);
    writeFileSync(join(dir, ROBOT_READER_FILE), robotReaderPy());
    writeFileSync(join(dir, 'data.csv'), 'page;who\nhttps://a.test/;Ann\nhttps://b.test/;Bo\n');
    const res = spawnSync(ROBOT_PY, ['-m', 'robot', '--dryrun', '--output', 'NONE', '--report', 'NONE', '--log', 'NONE', join(dir, 'login.robot')],
      { cwd: dir, encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /2 tests, 2 passed, 0 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
