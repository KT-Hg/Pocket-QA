/**
 * export-playwright.js — the Playwright Test export: a scenario as a
 * <name>.spec.js that `npx playwright test` runs. Unlike a bookmarklet it goes on
 * across pages, and it runs in CI as it is.
 *
 * It does what playback does: each step's locators in playback's order
 * (shared/locator-order.js), tried in turn by _find, and the extension's own
 * in-page code (popup/export/page-js.js) where Playwright's call would differ.
 */

import { commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout } from '../shared/switch-blocks.js';
import { normalizeVarName, normalizeVarRef, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs } from '../shared/wait-ms.js';
import { mark } from './export/steps.js';
import { exportVariables, inFrame, locatorsFor, undefinedVarNames, walkActions, warnUndefinedVars } from './export/walk.js';
import { parseCSV, _delimiterOf } from './csv/csv-parse.js';
import {
  SET_INPUT_JS, CHECK_COND_JS, CONDITION_TYPES, FIND_CHILD_JS, READ_VAL_JS, PICK_ITEM_JS, DROP_BRIDGE_JS, DROP_FILES_JS,
} from './export/page-js.js';
import { JS_RESERVED, jsIdentifier, jsValue, jsConditions, randomFnJS } from './export/js-code.js';

// What the generated spec declares for itself, beside the JS reserved words.
const RESERVED = new Set(['test', 'page', 'TIMEOUT', '_find', '_first', '_input', '_setInput', '_js', '_SCRIPT_INPUT_TYPES',
  '_checkCond', '_findChild', '_readVal', '_pick', '_dropBridge', '_dropFiles', '_inFrames', '_var', '_url', '_firstOrigin', 'process', '_row', '_rows', '_column',
  'readFileSync', 'join', '_delimiterOf', 'parseCSV', ...JS_RESERVED]);
// The steps' elements (el3, el3_t) share the test function with the variables.
const ident = jsIdentifier(RESERVED, /^el\d+(_|$)/);
const valueJS = jsValue(ident);

/**
 * One locator as a Playwright selector: CSS as it is, xpath=… for an XPath, and
 * for a Text one the exact text — text="…", or tag:text-is("…") for one picked on
 * the page with its tag.
 */
function selectorPW({ type, value, tag }) {
  switch (type) {
    case 'xpath':
    case 'fullXpath': return valueJS(`xpath=${value}`);
    case 'id':        return valueJS(`#${cssEscape(value)}`);
    case 'name':      return valueJS(`[name="${cssEscape(value)}"]`);
    case 'testId':    return valueJS(`[data-testid="${cssEscape(value)}"]`);
    case 'dataId':    return valueJS(`[data-id="${cssEscape(value)}"]`);
    case 'text':      return valueJS(tag ? `${tag}:text-is(${JSON.stringify(value)})` : `text=${JSON.stringify(value)}`);
    default:          return valueJS(value);
  }
}

// An element's selectors as Playwright takes them, each once.
const selectorsPW = (locs) => [...new Set(locs.map(selectorPW))];

/**
 * The line that finds an element into `elVar`: a plain locator for one selector,
 * else _find over all of them in order. .first(): playback acts on the first
 * match where Playwright would refuse several. `framed`: recorded in a frame, the
 * element is looked for in the page and then each frame (_inFrames).
 */
function findPW(locs, elVar, framed = false) {
  const sels = selectorsPW(locs);
  if (framed) return `const ${elVar} = await _inFrames(page, [${sels.join(', ')}]);`;
  return sels.length === 1
    ? `const ${elVar} = page.locator(${sels[0]}).first();`
    : `const ${elVar} = await _find(page, [${sels.join(', ')}]);`;
}

// A script step's code as a JS string; ${name}s are filled in at run time, escaped by _js.
function scriptPW(code) {
  const parts = String(code).split(/(\$\{[^}]+\})/g).filter((p) => p !== '');
  const pieces = parts.map((p) => {
    const m = p.match(/^\$\{([^}]+)\}$/);
    return m ? `_js(${ident(m[1].trim())})` : JSON.stringify(p);
  });
  return `await page.evaluate(${pieces.join(' + ') || '""'});`;
}

// What the environment changes without an export: a variable (PQA_<name>), the site (PQA_BASE_URL).
const ENV_HELPERS = String.raw`// A variable's value: PQA_<name> from the environment when it is set, else the exported one.
const _var = (name, value) => process.env['PQA_' + name] ?? value;

// u — or, with PQA_BASE_URL set and u on the site of the first page opened, the same page there.
let _firstOrigin = null;
function _url(u) {
  const x = new URL(u);
  _firstOrigin ??= x.origin;
  const base = process.env.PQA_BASE_URL;
  return base && x.origin === _firstOrigin ? base.replace(/\/+$/, '') + x.pathname + x.search + x.hash : u;
}`;

// The comment the spec opens with: how to run it, and what the environment can change.
const runNotes = (varNames) => [
  '// How to run: npm install -D @playwright/test, then: npx playwright test <this file>',
  '// Without exporting again, the environment can set:',
  "//   PQA_BASE_URL  a site to open instead of the first page's (staging, production): its steps go there",
  ...(varNames.length ? [`//   PQA_<name>    a variable's value: ${commentText(varNames.map((n) => `PQA_${n}`).join(', '))}`] : []),
];

// A spec with a data file: its rows, read as the extension's CSV run reads them (its
// own parser, popup/csv/csv-parse.js), and the value of a column a step needs. The
// file is the one beside the spec (__dirname; an ES module project has none: the
// folder npx runs from).
const lf = (fn) => fn.toString().replace(/\r\n?/g, '\n');
const CSV_HELPERS = `// The rows of a CSV file beside this spec, read as the extension's CSV run reads them.
${lf(_delimiterOf)}

${lf(parseCSV)}

function _rows(name) {
  const parsed = parseCSV(readFileSync(join(typeof __dirname === 'string' ? __dirname : process.cwd(), name), 'utf8'));
  if (!parsed) throw new Error(name + ': a header row and at least one row of data are needed');
  return parsed.rows;
}

// The row's value of a column a step needs.
function _column(row, name) {
  if (!(name in row)) throw new Error('the data file has no column "' + name + '"');
  return row[name];
}`;

// The spec's own helpers, each written out only when a step uses it.
const FIND_HELPER = String.raw`// How the extension finds an element (content.js _locators): each selector in turn
// until one finds it, for up to TIMEOUT; one the page cannot parse is passed over.
async function _find(page, selectors) {
  const end = Date.now() + TIMEOUT;
  for (;;) {
    for (const s of selectors) {
      const el = page.locator(s).first();
      if (await el.count().catch(() => 0)) return el;
    }
    if (Date.now() > end) throw new Error('No element found by ' + selectors.join(' | '));
    await page.waitForTimeout(100);
  }
}`;

const INPUT_HELPER = `// An Input as the extension makes it: a <select>, a date, time, color or range field
// through its own setter (a typed date follows the browser's locale); any other field filled.
const _setInput = ${SET_INPUT_JS};
const _SCRIPT_INPUT_TYPES = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'];
async function _input(el, value) {
  const kind = await el.evaluate((e) => (e.tagName === 'SELECT' ? 'select' : e.type));
  if (kind === 'select' || _SCRIPT_INPUT_TYPES.includes(kind)) await el.evaluate(_setInput, value);
  else await el.fill(value);
}`;

const FRAMES_HELPER = String.raw`// An element recorded inside a frame: looked for in the page, then in each of its frames,
// each selector in turn, for up to TIMEOUT.
async function _inFrames(page, selectors) {
  const end = Date.now() + TIMEOUT;
  for (;;) {
    for (const frame of page.frames()) {
      for (const s of selectors) {
        const el = frame.locator(s).first();
        if (await el.count().catch(() => 0)) return el;
      }
    }
    if (Date.now() > end) throw new Error('No element found by ' + selectors.join(' | ') + ' in the page or its frames');
    await page.waitForTimeout(100);
  }
}`;

const FIRST_HELPER = String.raw`// The element a Condition checks: the first selector that finds one now, without waiting.
async function _first(page, selectors) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) return el.elementHandle();
  }
  return null;
}`;

// The extension's in-page code (popup/export/page-js.js), as the page functions
// Playwright hands its arguments to: page.evaluate(fn, arg), element.evaluate(fn, arg).
const PAGE_HELPERS = {
  check: `// A Condition as the extension checks it (content.js CHECK_CONDITION); page.evaluate
// hands it one argument, [type, element, expected].
const _checkCond = ([type, el, expected]) => (${CHECK_COND_JS})(type, el, expected);`,
  child: `// The child a Child Condition picks in its parent (content.js findElementByCondition).
const _findChild = ${FIND_CHILD_JS};`,
  read: `// What Read DOM reads (content.js readElementValue); [from, attr] as one argument.
const _readVal = (el, [from, attr]) => (${READ_VAL_JS})(el, from, attr);`,
  pick: `// A Dropdown's "Choose item #", as the bookmarklet makes it in the page.
const _pick = async (el, [raw, itemSel, timeout]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${PICK_ITEM_JS.split('\n').map((l) => `  ${l}`).join('\n')}
  return _pickItem(el, raw, itemSel, timeout);
};`,
  drop: `// An upload to a drop zone as the extension makes it (bg/cdp/upload.js): the files set on a
// hidden file input, then dropped on the zone with one DataTransfer.
const _dropBridge = ${DROP_BRIDGE_JS};
const _dropFiles = ${DROP_FILES_JS};`,
};

// The spec's _js, written out from its own source: escaping quotes, backticks and
// ${ inside a string of generated code is where such helpers go wrong.
const jsEscapeForSpec = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'")
  .replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
// toString() is the source as checked out, CRLF on a Windows checkout: in LF, as the rest.
const JS_HELPER = `// A value inlined into script code, escaped as the extension escapes it (_applyVarsToCode).
const _js = ${jsEscapeForSpec.toString().replace(/\r\n?/g, '\n')};`;

// A screenshot of the page, visible part or whole.
const pageShot = (a, s) => {
  const full = a.type !== 'screenshot';
  return [`// Step ${s.n}: screenshot (${full ? 'full page' : 'visible'})${s.lbl}`,
    `await page.screenshot({ path: "screenshot${full ? '_full' : ''}_step${s.n}.png"${full ? ', fullPage: true' : ''} });`];
};

// The lines that find the step's element into `el`: its parent first when a Child Condition picks it.
function findLines(action, el, ctx) {
  if (!action.conditions || !['click', 'input', 'hover', 'readdom'].includes(action.type)) return [findPW(locatorsFor(action), el, inFrame(action))];
  ctx.uses.add('child');
  return [findPW(locatorsFor(action), `${el}_p`, inFrame(action)),
    `const ${el} = (await ${el}_p.evaluateHandle(_findChild, ${jsConditions(action.conditions, valueJS)})).asElement();`,
    `if (!${el}) throw new Error('Child condition not matched (step ${el.slice(2)})');`];
}

// Read DOM: each ${name} of the pattern takes its part of the text; "Save to var" the whole.
function readdomLines(a, s) {
  s.ctx.uses.add('read');
  const slots = a.pattern ? patternVarNames(a.pattern) : [];
  const vn = normalizeVarName(a.varName);
  const read = `await ${s.el}.evaluate(_readVal, [${JSON.stringify(a.readFrom || 'text')}, ${valueJS(a.attrName || '')}])`;
  const targets = [vn && ident(vn), ...slots.map(ident)].filter(Boolean);
  const out = [`// Step ${s.n}: readdom → ${targets.map((t) => `"${t}"`).join(', ') || 'nothing kept'}${s.lbl}`, ...s.find()];
  if (!slots.length) {
    // With no variable the value is read and dropped, as a run reads and drops it.
    out.push(vn ? `${ident(vn)} = ${read};` : `${read};`);
    return out;
  }
  out.push(`const ${s.el}_t = ${read};`);
  if (vn) out.push(`${ident(vn)} = ${s.el}_t;`);
  out.push(`const ${s.el}_m = new RegExp(${JSON.stringify(patternRegexSource(a.pattern))}, ${JSON.stringify(a.matchCase ? '' : 'i')}).exec(${s.el}_t);`);
  out.push(`if (!${s.el}_m) throw new Error(${JSON.stringify(`Read DOM (step ${s.n}): text does not match ${String(a.pattern).trim()}: `)} + ${s.el}_t);`);
  slots.forEach((nm, k) => out.push(`${ident(nm)} = ${s.el}_m[${k + 1}].trim();`));
  return out;
}

// Upload File into a file input, the paths playback hands it (bg/playback/steps/upload.js).
function uploadLines(a, s) {
  const folder = String(a.folderPath || '').replace(/[/\\]+$/, '');
  let names = [];
  if (Array.isArray(a.fileNames) && a.fileNames.length) names = a.fileNames;
  else if (a.fileName) names = [a.fileName];
  const zone = a.uploadMode === 'dropzone';
  const head = `// Step ${s.n}: upload file${names.length > 1 ? 's' : ''}${zone ? ' to a drop zone' : ''}${s.lbl}`;
  if (!folder || !names.length) {
    mark(s.step, 'verify', 'no folder or file name — the exported code stops there, as a run does');
    return [head, `throw new Error("Upload File (step ${s.n}): missing folder or file name(s)");`];
  }
  const sep = folder.includes('\\') ? '\\' : '/';
  const files = `[${names.map((nm) => valueJS(`${folder}${sep}${nm}`)).join(', ')}]`;
  if (!zone) return [head, ...s.find(), `await ${s.el}.setInputFiles(${files});`];
  // As playback drops them (bg/cdp/upload.js): set on a hidden file input, then dropped on the zone.
  s.ctx.uses.add('drop');
  return [head, ...s.find(), `const ${s.el}_b = (await page.evaluateHandle(_dropBridge)).asElement();`,
    `await ${s.el}_b.setInputFiles(${files});`, `await ${s.el}.evaluate(_dropFiles, ${s.el}_b);`];
}

/**
 * Per action type: (action, s) → its lines, where s = { n, lbl, el, find, ctx,
 * step } — find() is the line that finds the step's element into `el`.
 */
const STEP_LINES = {
  navigate: (a, s) => [`// Step ${s.n}: navigate${s.lbl}`, `await page.goto(_url(${valueJS(a.url || a.value)}));`],
  click:    (a, s) => [`// Step ${s.n}: click${s.lbl}`, ...s.find(), `await ${s.el}.click();`],
  hover:    (a, s) => [`// Step ${s.n}: hover${s.lbl}`, ...s.find(), `await ${s.el}.hover();`],
  input:    (a, s) => {
    s.ctx.uses.add('input');
    return [`// Step ${s.n}: input${s.lbl}`, ...s.find(), `await _input(${s.el}, ${valueJS(a.value)});`];
  },
  wait:     (a, s) => [`// Step ${s.n}: wait${s.lbl}`, `await page.waitForTimeout(${waitMs(a)});`],
  script:   (a, s) => {
    const code = String(a.code || a.value || '').trim();
    if (/\$\{[^}]+\}/.test(code)) s.ctx.uses.add('js');
    mark(s.step, 'verify', 'custom JS run through page.evaluate() — check it');
    return [`// Step ${s.n}: script${s.lbl}`, scriptPW(code)];
  },
  screenshot: pageShot,
  screenshot_full: pageShot,
  screenshot_element: (a, s) => [`// Step ${s.n}: screenshot element${s.lbl}`, ...s.find(), `await ${s.el}.screenshot({ path: "screenshot_element_step${s.n}.png" });`],
  screenshot_tovar: (a, s) => {
    const name = normalizeVarName(a.varName);
    const v = name ? ident(name) : `${s.el}_file`;
    const out = [`// Step ${s.n}: screenshot → variable "${name || 'screenshot'}"${s.lbl}`,
      `${name ? '' : 'const '}${v} = "screenshot_${name ? v : 'screenshot'}_step${s.n}.png";`];
    if (a.target === 'element') out.push(...s.find(), `await ${s.el}.screenshot({ path: ${v} });`);
    else out.push(`await page.screenshot({ path: ${v}${a.target === 'full' ? ', fullPage: true' : ''} });`);
    return out;
  },
  switch: (a, s) => {
    mark(s.step, 'skip', 'a Switch needs the extension to choose what plays');
    return [`// Step ${s.n}: switch [SKIPPED] — requires extension scenario routing`];
  },
  readdom: readdomLines,
  dropdown: (a, s) => {
    if (!a.pick) return [`// Step ${s.n}: open dropdown (freeze)${s.lbl}`, ...s.find(), `await ${s.el}.click();`];
    s.ctx.uses.add('pick');
    return [`// Step ${s.n}: dropdown → item #${String(a.pick.index ?? '?').replace(/\s+/g, ' ')}${s.lbl}`, ...s.find(),
      `await ${s.el}.evaluate(_pick, [${valueJS(a.pick.index)}, ${valueJS(a.pick.itemSelector || '')}, TIMEOUT]);`];
  },
  // Playwright's drag fires the HTML5 drag events, as a real mouse does.
  dragdrop: (a, s) => [`// Step ${s.n}: drag & drop${s.lbl}`, findPW(locatorsFor(a), `${s.el}_s`, inFrame(a)),
    findPW(locatorsFor(a, true), `${s.el}_t`, inFrame(a)), `await ${s.el}_s.dragTo(${s.el}_t);`],
  uploadFile: uploadLines,
};

// Lines for one step that is not a Condition; marks `step` when it is not exported as is.
function actionLines(action, step, ctx) {
  const n = step.n;
  const el = `el${n}`;
  const s = { n, el, step, ctx, lbl: action.label ? ` — ${commentText(action.label)}` : '', find: () => findLines(action, el, ctx) };
  const out = Object.hasOwn(STEP_LINES, action.type)
    ? STEP_LINES[action.type](action, s)
    : (mark(step, 'skip', 'not an action type this version knows'), [`// Step ${n}: ${commentText(action.type)}${s.lbl} — [unsupported, skipped]`]);
  // The pause after a step, as in a run: not after a wait, nor after what is left out.
  // A number, whatever an imported scenario holds: it is written into the code.
  const delay = action.delay != null ? Number(action.delay) : ctx.stepDelay;
  if (delay > 0 && action.type !== 'wait' && step.status !== 'skip') out.push(`await page.waitForTimeout(${delay});`);
  return out;
}


/**
 * The "if (…) {" opening a Condition's block: the in-page check on the element
 * found now (none for the URL types). A type this version does not know stops the
 * run there, as playback does; its name stays in the comment, never in code.
 */
function conditionHeader(action, step, ctx) {
  const type = action.conditionType;
  const head = `// Step ${step.n}: condition — ${commentText(type)}${action.label ? ` — ${commentText(action.label)}` : ''}`;
  if (!CONDITION_TYPES.has(type)) {
    mark(step, 'verify', 'unknown condition type — the exported code stops there, as a run does');
    ctx.warnings.add(`Condition step ${step.n}: type "${type}" is unknown — the exported code stops there, as a run does`);
    return [head, `throw new Error(${JSON.stringify(`Condition step ${step.n}: unknown condition type, named in the comment above`)});`, 'if (true) {'];
  }
  ctx.uses.add('check');
  let el = 'null';
  if (!type.startsWith('url')) {
    ctx.uses.add('first');
    el = `await _first(page, [${selectorsPW(locatorsFor(action)).join(', ')}])`;
  }
  // The check is a step of the report; the steps it guards are steps of their own.
  const title = JSON.stringify(head.slice('// '.length));
  return [head, `if (await test.step(${title}, async () => page.evaluate(_checkCond, [${JSON.stringify(type)}, ${el}, ${valueJS(action.expectedValue)}]))) {`];
}

// The steps, walked as playback walks them (export/walk.js).
/**
 * A step's lines as a test.step named by its comment ("Step 3: click — Sign in"):
 * the report lists each one and marks the one that failed. A skipped step has no
 * code, so no step. Its element is the step's own; a variable it writes is the
 * test's (declared outside).
 */
function asTestStep(lines, step) {
  if (step.status === 'skip') return lines;
  return [lines[0], `await test.step(${JSON.stringify(lines[0].slice('// '.length))}, async () => {`,
    ...lines.slice(1).map((l) => (l === '' ? '' : `  ${l}`)), '});'];
}

/**
 * A Switch block as if / else if / else on its variable's value now: the first
 * case whose value it is, else the default case (none: nothing runs), as a run
 * picks. The steps of the case are test.steps of their own.
 */
function switchLinesPW(action, step, branches) {
  const value = valueJS(normalizeVarRef(action.switchVar));
  const out = [`// Step ${step.n}: switch on ${commentText(normalizeVarRef(action.switchVar))}${action.label ? ` — ${commentText(action.label)}` : ''}`];
  const indent = (lines) => lines.map((l) => (l === '' ? '' : `  ${l}`));
  const cases = branches.filter((b) => !b.isDefault);
  const fallback = branches.find((b) => b.isDefault);
  cases.forEach((b, k) => out.push(`${k ? '} else if' : 'if'} (${value} === ${JSON.stringify(String(b.value ?? ''))}) {`, ...indent(b.body)));
  if (fallback) out.push(cases.length ? '} else {' : 'if (true) {', ...indent(fallback.body));
  if (cases.length || fallback) out.push('}');
  const delay = Number(action.delay) || 0;
  if (delay > 0) out.push(`await page.waitForTimeout(${delay});`);
  return out;
}

const stepLines = (ctx) => walkActions(ctx, {
  step: (action, step) => asTestStep(actionLines(action, step, ctx), step),
  conditionHead: (action, step) => conditionHeader(action, step, ctx),
  conditionBody: (lines) => [...lines.map((l) => (l === '' ? '' : `  ${l}`)), '}'],
  switchLines: switchLinesPW,
  // The spec cannot pick a case.
  skippedBlock: (start, end) => [`// Step ${start + 1}: switch block [SKIPPED] — steps ${start + 2}–${end + 1} not exported (requires extension scenario routing)`],
});

// The scenario's variables (exportVariables), declared at the top of the test, in the
// Variables tab's order — each PQA_<name> when the environment sets it, and with a
// data file the row's column of its name first, as a CSV run lets a column win:
// `let` for the ones a step writes.
function variableLines(variables, { staticVars, randomSpecs, pickSpecs, written }, csv = null) {
  const out = [];
  const declared = new Set();
  const declare = (safe, expr) => {
    if (declared.has(safe)) return;
    declared.add(safe);
    out.push(`${written.has(safe) ? 'let' : 'const'} ${safe} = ${expr};`);
  };
  for (const k of Object.keys(variables || {})) {
    const random = randomSpecs[k];
    const pick = pickSpecs[k];
    let value = JSON.stringify(staticVars[k]);
    if (random) value = `(${randomFnJS(random.type, random.length)})()`;
    else if (pick) value = `${JSON.stringify(pick)}[Math.floor(Math.random() * ${pick.length})]`;
    const env = `_var(${JSON.stringify(k)}, ${value})`;
    declare(ident(k), csv ? `_row[${JSON.stringify(k)}] ?? ${env}` : env);
  }
  // A name only the data file gives: its column, which every row must have; one a step
  // writes, seeded by the row's column when it has one.
  for (const name of csv?.fromColumns || []) declare(ident(name), `_column(_row, ${JSON.stringify(name)})`);
  for (const name of csv?.written || []) declare(ident(name), `_row[${JSON.stringify(name)}] ?? ''`);
  for (const k of written) declare(k, "''");
  return out.length ? ['// --- VARIABLES ---', ...out, ''] : [];
}

// The helpers the steps (`body`, what they `use`) and a data file call, each followed by an empty line.
function helperLines(body, uses, dataFile) {
  const used = [
    [true, ENV_HELPERS],
    [dataFile, CSV_HELPERS],
    [body.some((l) => l.includes('await _find(')), FIND_HELPER],
    [body.some((l) => l.includes('await _inFrames(')), FRAMES_HELPER],
    [uses.has('first'), FIRST_HELPER],
    ...['check', 'child', 'read', 'pick', 'drop'].map((name) => [uses.has(name), PAGE_HELPERS[name]]),
    [uses.has('input'), INPUT_HELPER],
    [uses.has('js'), JS_HELPER],
  ];
  return used.filter(([on]) => on).flatMap(([, src]) => [src, '']);
}

// The test of `lines`; with a data file, one test per row of it, named "<scenario> #<row>".
function testBlock(scenarioName, lines, dataFile) {
  const indent = (l) => (l === '' ? '' : `  ${l}`);
  const test = [
    `test(${JSON.stringify(String(scenarioName))}${dataFile ? " + ' #' + (n + 1)" : ''}, async ({ page }) => {`,
    '  // A scenario takes as long as its steps; each one waits for TIMEOUT at most.',
    '  test.setTimeout(0);',
    ...lines.map(indent),
    '});',
  ];
  return dataFile ? [`for (const [n, _row] of _rows(${JSON.stringify(dataFile)}).entries()) {`, ...test.map(indent), '}'] : test;
}

/**
 * The scenario as a Playwright test.
 *
 * @param {object} opts
 * @param {number} opts.stepDelay - ms waited after each step (default 300)
 * @param {number} opts.elTimeout - ms a step waits for its element (default 10000)
 * @param {string} opts.startUrl  - opened first when the scenario does not start with a Navigate
 * @returns {{ code: string, stats: { total, supported, skipped }, steps: object[], warnings: string[] }}
 */
export function generatePlaywright(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 300, elTimeout = 10000, startUrl = '' } = opts;
  // A CSV file of rows to run with: a test per row.
  const dataFile = String(opts.dataFile || '').trim();
  const all = actions || [];
  const enabled = all.filter((a) => a && !a.disabled);
  const warnings = new Set();
  const steps = [];
  const vars = exportVariables(variables, enabled, ident, 'JS', warnings);
  const ctx = { all, layout: getSwitchLayout(all), warnings, steps, stepDelay, uses: new Set(), frames: 'all' };
  const body = stepLines(ctx);

  // The start page, unless the scenario opens one first (waits aside).
  const first = enabled.find((a) => a.type !== 'wait');
  let start = [];
  if (first?.type !== 'navigate') {
    start = startUrl
      ? [`await page.goto(_url(${JSON.stringify(startUrl)}));`, '']
      : ['// ⚠ TODO: Set the starting URL (go to Settings tab to configure)', 'await page.goto(_url("https://your-url-here.com"));', ''];
  }

  const out = [`// SCENARIO: ${commentText(scenarioName)}`, ...runNotes(Object.keys(variables || {})), "import { test } from '@playwright/test';"];
  if (dataFile) out.push("import { readFileSync } from 'node:fs';", "import { join } from 'node:path';");
  out.push('');
  // A failed test keeps a screenshot and a trace of the page (test-results/).
  out.push('// How long a step waits for its element, as set in the export.', `const TIMEOUT = ${elTimeout};`,
    "test.use({ actionTimeout: TIMEOUT, screenshot: 'only-on-failure', trace: 'retain-on-failure' });", '');
  out.push(...helperLines(body, ctx.uses, dataFile));
  const csv = dataFile ? { fromColumns: undefinedVarNames(enabled, variables), written: enabled.flatMap((a) => writtenVarNames(a)) } : null;
  out.push(...testBlock(scenarioName, [...variableLines(variables, vars, csv), ...start, ...body], dataFile));

  warnUndefinedVars(enabled, variables, warnings, dataFile);
  const skipped = steps.filter((s) => s.status === 'skip').length;
  return {
    code: out.join('\n'),
    stats: { total: enabled.length, supported: steps.length - skipped, skipped },
    steps,
    warnings: [...warnings],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

/** Wire the Playwright export. */
export function initExportPlaywright() {
  const number = (id, fallback) => parseInt(document.getElementById(id)?.value) || fallback;
  initExportModal({
    triggerId: 'exportPlaywright',
    format: 'pw',
    badge: 'PW',
    title: 'Export Playwright',
    remember: ['exportPwStepDelay', 'exportPwElTimeout'],
    fileName: (base) => `${base}.spec.js`,
    readOptions: () => ({
      stepDelay: number('exportPwStepDelay', 300),
      elTimeout: number('exportPwElTimeout', 10000),
      startUrl: document.getElementById('exportPwStartUrl')?.value.trim() || '',
      dataFile: document.getElementById('exportPwData')?.value.trim() || '',
    }),
    generate: generatePlaywright,
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/javascript' }),
    startUrl: { field: 'exportPwStartUrl', button: 'exportPwGetUrl', badge: 'exportPwUrlFromTab' },
  });
}
