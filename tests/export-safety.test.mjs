// node --test tests/export-safety.test.mjs
//
// One scenario carrying a "poison" string in every place a scenario's own text
// reaches the generated code — name, label, type, conditionType, switchVar,
// pick.index/itemSelector, selectors, value, url, expectedValue, Child Condition
// fields, attrName, varName, pattern, Script code, folderPath, fileNames, and
// variable names and values. Each export must keep that text as data: a comment
// or a string, never code. Two oracles, both reading the generated file:
//
//  - string: highlightLines() (the export modal's own colourer) splits the code
//    into comment / string / code pieces; the marker PWN!PWN must land in none of
//    the code pieces (kind null or 'kw'). PWN!PWN has a '!', which no variable-name
//    sanitiser leaves in an identifier, so a declared poison *name* never trips it.
//  - line: the file must have as many lines the target language's own line-split
//    gives as code.split('\n') does — a newline the language reads where the
//    generator put none means text opened a line of its own.
//
// Python and JS (bookmarklet, Playwright) are already safe and run here. Java
// (javaOracle) and Robot (robotOracle) get their oracle here too, called from
// their own fix (T2, T3).

import test from 'node:test';
import assert from 'node:assert/strict';

import { highlightLines } from '../popup/export/highlight.js';
import { generateSeleniumPy } from '../popup/export-selenium.js';
import { generateBookmarklet, toBookmarkletUrl } from '../popup/export-bookmarklet.js';
import { generatePlaywright } from '../popup/export-playwright.js';
import { generateJava } from '../popup/export-java.js';
import { generateRobot } from '../popup/export-robot.js';

const MARKER = 'PWN!PWN';
const LS = String.fromCharCode(0x2028); // LINE SEPARATOR — blank, but a newline to JS and Robot
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR — likewise

// Every substring that could end a comment, close a string, open a template
// expression, or be read as a newline by one of the five languages, each trailed
// by the marker so a break-out carries it into code. \x85, LS and PS are blank;
// the 6-char text backslash-u-000a and its 7-char backslash-escaped form probe
// javac's unicode-escape pass (JLS 3.3); %0A probes the bookmarklet URL.
const TOKENS = [
  '\r', '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', LS, PS,
  '\\u000a', '\\\\u000a', '*/', '"""', "'", '"', '`', '${', '%0A',
];
const POISON = 'z' + TOKENS.map((t) => t + MARKER).join('');

// Selectors of every kind the export tries, each poisoned.
const sel = () => ({
  selector: POISON,
  selectorType: 'css',
  selectors: { css: POISON, xpath: POISON, fullXpath: POISON, id: POISON, testId: POISON, dataId: POISON, name: POISON, text: POISON, textTag: POISON },
});
const cond = () => ({ matchMode: POISON, valueEquals: POISON, textContains: POISON, idContains: POISON, classContains: POISON, typeEquals: POISON });

// A Script action's code IS JavaScript: the bookmarklet and Playwright inline it
// to run, so there the marker is meant to be code. Python, Java and Robot pass it
// as a string to execute_script, where it must stay a string — only those get the
// poison body (and its """ probes _scriptToPy's triple-quote escape).
const JS_SCRIPT = 'return document.title;';

// index 0-based; the Switch at 19 (step 20) branches over steps 21 and 22.
const mkActions = (scriptCode) => [
  { type: 'navigate', url: POISON, label: POISON },
  { type: 'click', ...sel(), label: POISON, conditions: cond() },
  { type: 'input', ...sel(), value: POISON, label: POISON },
  { type: 'hover', ...sel(), label: POISON },
  { type: 'dropdown', ...sel(), pick: { index: POISON, itemSelector: POISON }, label: POISON },
  { type: 'dragdrop', ...sel(), targetSelector: POISON, targetSelectors: { css: POISON, xpath: POISON, id: POISON }, label: POISON },
  { type: 'script', code: scriptCode, label: POISON },
  { type: 'readdom', ...sel(), varName: POISON, readFrom: 'visible', label: POISON },
  { type: 'readdom', ...sel(), varName: POISON, readFrom: 'text', pattern: POISON, matchCase: true, label: POISON },
  { type: 'readdom', ...sel(), varName: POISON, readFrom: 'attr', attrName: POISON, label: POISON },
  { type: 'screenshot', label: POISON },
  { type: 'screenshot_full', label: POISON },
  { type: 'screenshot_element', ...sel(), label: POISON },
  { type: 'screenshot_tovar', varName: POISON, captureMode: POISON, label: POISON },
  { type: 'uploadFile', ...sel(), folderPath: POISON, fileName: POISON, fileNames: [POISON, POISON], label: POISON },
  { type: POISON, ...sel(), label: POISON }, // an action type no export knows
  { type: 'condition', conditionType: POISON, ...sel(), expectedValue: POISON, skipCount: 1, label: POISON },
  { type: 'click', ...sel(), label: POISON }, // the step the Condition guards
  { type: 'wait', value: POISON, label: POISON },
  { type: 'switch', switchVar: POISON, label: POISON, cases: [
    { value: POISON, scenarioId: '__self__', startAt: 21, endAt: 21 },
    { value: 'other', scenarioId: '__self__', startAt: 22, endAt: 22 },
  ] },
  { type: 'click', ...sel(), label: POISON }, // step 21, a case body
  { type: 'input', ...sel(), value: POISON, label: POISON }, // step 22, a case body
];
const ACTIONS_STR = mkActions(POISON);    // execute_script wraps the code in a string
const ACTIONS_JS = mkActions(JS_SCRIPT);  // the bookmarklet / Playwright run it as code

const VARIABLES = {
  [POISON]: POISON,               // a poison name and a poison value, static
  cleanName: POISON,              // a poison value under a clean name
  picked: `{pick:${POISON}|other}`, // a poison option in a Pick variable
};

// ── Oracles ────────────────────────────────────────────────────────────────

// Each piece is [text, kind]; a code piece is kind null or 'kw'. highlightLines
// already cut every piece at a \n, so no piece text holds one.
const isCode = ([, k]) => k == null || k === 'kw';

// The marker belongs in a string or a comment, never in code: joined with a NUL
// so it cannot straddle two unrelated code pieces by accident.
function stringOracle(code, lang, who) {
  const codeText = highlightLines(code, lang).flat().filter(isCode).map(([t]) => t).join('\0');
  assert.ok(!codeText.includes(MARKER),
    `${who}: scenario text reached ${lang} code — the marker is in a code token, not a string or comment`);
}

// A JS/Java // comment ends at any of these; highlightLines ends it only at \n,
// so a survivor here is a comment another engine would have closed early.
const NL_IN_COMMENT = new RegExp('[\\r' + LS + PS + ']');
function commentOracle(code, lang, who) {
  for (const line of highlightLines(code, lang))
    for (const [text, kind] of line)
      if (kind === 'cmt') assert.ok(!NL_IN_COMMENT.test(text),
        `${who}: a newline survived in a ${lang} comment — it would end the comment and spill into code`);
}

// The code with every string and comment blanked out, its \n line breaks kept.
// A newline left in here is one in code — a line the generator never wrote. (A \r
// or a line/paragraph separator inside a Python triple-quoted string or a comment
// is legal and must not count, so the skeleton, not the raw code, is split.)
const skeleton = (code, lang) =>
  highlightLines(code, lang).map((line) => line.map((p) => (isCode(p) ? p[0] : '')).join('')).join('\n');

function lineOracle(code, lang, re, who) {
  const sk = skeleton(code, lang);
  assert.equal(sk.split(re).length, sk.split('\n').length,
    `${who}: the language reads a newline where the generator put none`);
}

const PY_NL = /\r\n|[\r\n]/;
const JS_NL = new RegExp('\\r\\n|[\\r\\n' + LS + PS + ']');
const pyOracle = (code, who) => { stringOracle(code, 'py', who); lineOracle(code, 'py', PY_NL, who); };
const jsOracle = (code, who) => { stringOracle(code, 'js', who); commentOracle(code, 'js', who); lineOracle(code, 'js', JS_NL, who); };

// javac resolves \uXXXX before it lexes (JLS 3.3): a \u is an escape only when the
// run of backslashes before it is even. Resolve them, then read as JS/Java.
export function javaUnescapeUnicode(code) {
  return code.replace(/(\\*)\\u+([0-9a-fA-F]{4})/g, (m, pre, hex) =>
    pre.length % 2 === 0 ? pre + String.fromCharCode(parseInt(hex, 16)) : m);
}
export const javaOracle = (code, who) => {
  const resolved = javaUnescapeUnicode(code);
  stringOracle(resolved, 'java', who);
  commentOracle(resolved, 'java', who);
};

// Robot Framework splits logical lines with Python's str.splitlines(): this set.
// Robot has no strings — a cell is code — so the whole file is split, not a skeleton.
const SPLITLINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85' + LS + PS + ']');
export const robotOracle = (code, who) =>
  assert.equal(code.split(SPLITLINES).length, code.split('\n').length,
    `${who}: Robot reads a newline where the generator put none`);

// Decode one browser pass over a javascript: URL's percent-escapes.
const decodePercent = (url) => url.replace(/%([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

// ── Tests ────────────────────────────────────────────────────────────────

test('Selenium script keeps poison out of the Python code', () => {
  pyOracle(generateSeleniumPy('S', ACTIONS_STR, VARIABLES).code, 'selenium script');
});

test('Selenium pytest keeps poison out of the Python code', () => {
  pyOracle(generateSeleniumPy('S', ACTIONS_STR, VARIABLES, { output: 'pytest' }).code, 'selenium pytest');
});

test('Selenium Java keeps poison out of the Java code', () => {
  javaOracle(generateJava('S', ACTIONS_STR, VARIABLES).code, 'selenium java');
});

test('Robot keeps poison out of its own line structure', () => {
  robotOracle(generateRobot('S', ACTIONS_STR, VARIABLES).code, 'robot');
});

test('Playwright keeps poison out of the JS code', () => {
  jsOracle(generatePlaywright('S', ACTIONS_JS, VARIABLES).code, 'playwright');
});

test('bookmarklet keeps poison out of the JS code', () => {
  const { code } = generateBookmarklet('S', ACTIONS_JS, VARIABLES);
  jsOracle(code, 'bookmarklet');
  // The browser decodes the URL's %-escapes before it runs the code.
  jsOracle(decodePercent(toBookmarkletUrl(code)), 'bookmarklet URL');
});

// ── No variable shadows a name the generated file defines for itself ─────────
// A scenario that pulls in every helper, so the file declares them all, then the
// same names used as variables: each must come out renamed (NAME_v), or a
// scenario could bind over a helper the steps call. `sv` is the scenario's own
// Script variable, not a helper, so it is left out of the check.
const HS = { selector: '#a', selectors: { css: '#a' } };
const ALL_HELPERS = [
  { type: 'navigate', url: 'https://x.test/' },
  { type: 'script', code: 'return ${sv};' },
  { type: 'readdom', ...HS, readFrom: 'visible' },
  { type: 'click', ...HS, conditions: { matchMode: 'any', textContains: 'x' } },
  { type: 'screenshot_full' },
  { type: 'dropdown', ...HS, pick: { index: '1', itemSelector: '' } },
  { type: 'condition', conditionType: 'elementExists', ...HS, skipCount: 1 },
  { type: 'click', ...HS },
];
const definedNames = (code, patterns) => {
  const out = new Set();
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1]);
  out.delete('sv');
  return out;
};

test('Selenium: no variable shadows a name the script defines for itself', () => {
  const defs = generateSeleniumPy('S', ALL_HELPERS, { sv: 'x' }).code;
  const names = definedNames(defs, [/^def ([A-Za-z_]\w*)\(/gm, /^([A-Za-z_]\w*) = /gm]);
  assert.ok(['_js', '_read_val', '_find_child', '_READ_VAL_JS', '_FIND_CHILD_JS'].every((n) => names.has(n)),
    `the Read DOM and Script helpers are among the names the script defines: ${[...names].join(', ')}`);
  const withVars = generateSeleniumPy('S', [{ type: 'navigate', url: 'https://x.test/' }],
    Object.fromEntries([...names].map((n) => [n, 'x']))).code;
  for (const n of names) {
    assert.ok(withVars.includes(`${n}_v = _var("${n}"`),
      `a variable named "${n}" shadows what the script defines — add it to _RESERVED_PY`);
  }
});

test('Playwright: no variable shadows a name the test defines for itself', () => {
  const defs = generatePlaywright('S', ALL_HELPERS, { sv: 'x' }).code;
  const names = definedNames(defs, [/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm, /^(?:const|let|var) ([A-Za-z_$][\w$]*) =/gm]);
  const withVars = generatePlaywright('S', [{ type: 'navigate', url: 'https://x.test/' }],
    Object.fromEntries([...names].map((n) => [n, 'x']))).code;
  for (const n of names) {
    assert.ok(withVars.includes(`const ${n}_v = _var("${n}"`),
      `a variable named "${n}" shadows what the test defines`);
  }
});

// A step delay that is not a finite number above 0 — Infinity (JSON's 1e400), or
// text — must produce no wait, as playback waits none (setTimeout makes it 0).
test('a non-finite step delay produces no wait', () => {
  const noWait = [
    { type: 'navigate', url: 'https://x.test/', delay: 0 },
    { type: 'click', ...HS, delay: 1e400 }, // Infinity
    { type: 'click', ...HS, delay: 'abc' },
  ];
  const py = generateSeleniumPy('S', noWait, {}).code;
  const java = generateJava('S', noWait, {}).code;
  const robot = generateRobot('S', noWait, {}).code;
  assert.doesNotMatch(py, /time\.sleep\(/, 'Python: no sleep for a non-finite delay');
  assert.doesNotMatch(java, /Thread\.sleep\(/, 'Java: no sleep for a non-finite delay');
  // A step's Sleep sits at the test body's indent (4 spaces); the retry Sleep inside
  // a keyword is deeper, so this matches only a step delay.
  assert.doesNotMatch(robot, /\n {4}Sleep\b/, 'Robot: no step Sleep for a non-finite delay');
  for (const [lang, code] of [['Python', py], ['Java', java], ['Robot', robot]]) {
    assert.ok(!code.includes('Infinity') && !code.includes('NaN'), `${lang}: no Infinity or NaN in the code`);
  }
});
