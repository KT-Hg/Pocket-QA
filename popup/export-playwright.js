/**
 * export-playwright.js — the Playwright Test export: a scenario as a
 * <name>.spec.js that `npx playwright test` runs. Unlike a bookmarklet it goes on
 * across pages, and it runs in CI as it is.
 *
 * It does what playback does: each step's locators in playback's order
 * (shared/locator-order.js), tried in turn by _find, and the extension's own
 * in-page code (popup/export/page-js.js) where Playwright's call would differ.
 */

import { getUsedVarNames, commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout } from '../shared/switch-blocks.js';
import { normalizeVarName, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs } from '../shared/wait-ms.js';
import { mark } from './export/steps.js';
import { locatorsFor, walkActions } from './export/walk.js';
import { SET_INPUT_JS, CHECK_COND_JS, CONDITION_TYPES, FIND_CHILD_JS, READ_VAL_JS, PICK_ITEM_JS } from './export/page-js.js';
import { JS_RESERVED, jsIdentifier, jsValue, jsConditions, randomFnJS } from './export/js-code.js';

// What the generated spec declares for itself, beside the JS reserved words.
const RESERVED = new Set(['test', 'page', 'TIMEOUT', '_find', '_first', '_input', '_setInput', '_js', '_SCRIPT_INPUT_TYPES',
  '_checkCond', '_findChild', '_readVal', '_pick', ...JS_RESERVED]);
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
 * match where Playwright would refuse several.
 */
function findPW(locs, elVar) {
  const sels = selectorsPW(locs);
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
  if (!action.conditions || !['click', 'input', 'hover', 'readdom'].includes(action.type)) return [findPW(locatorsFor(action), el)];
  ctx.uses.add('child');
  return [findPW(locatorsFor(action), `${el}_p`),
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
  if (a.uploadMode === 'dropzone') {
    mark(s.step, 'skip', 'an upload to a drop zone needs the extension');
    return [`// Step ${s.n}: upload to a drop zone${s.lbl} — [SKIPPED] needs the extension`];
  }
  if (!folder || !names.length) {
    mark(s.step, 'verify', 'no folder or file name — the exported code stops there, as a run does');
    return [`// Step ${s.n}: upload file${s.lbl}`, `throw new Error("Upload File (step ${s.n}): missing folder or file name(s)");`];
  }
  const sep = folder.includes('\\') ? '\\' : '/';
  return [`// Step ${s.n}: upload file${names.length > 1 ? 's' : ''}${s.lbl}`, ...s.find(),
    `await ${s.el}.setInputFiles([${names.map((nm) => valueJS(`${folder}${sep}${nm}`)).join(', ')}]);`];
}

/**
 * Per action type: (action, s) → its lines, where s = { n, lbl, el, find, ctx,
 * step } — find() is the line that finds the step's element into `el`.
 */
const STEP_LINES = {
  navigate: (a, s) => [`// Step ${s.n}: navigate${s.lbl}`, `await page.goto(${valueJS(a.url || a.value)});`],
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
  dragdrop: (a, s) => [`// Step ${s.n}: drag & drop${s.lbl}`, findPW(locatorsFor(a), `${s.el}_s`),
    findPW(locatorsFor(a, true), `${s.el}_t`), `await ${s.el}_s.dragTo(${s.el}_t);`],
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
  return [head, `if (await page.evaluate(_checkCond, [${JSON.stringify(type)}, ${el}, ${valueJS(action.expectedValue)}])) {`];
}

// The steps, walked as playback walks them (export/walk.js).
const stepLines = (ctx) => walkActions(ctx, {
  step: (action, step) => actionLines(action, step, ctx),
  conditionHead: (action, step) => conditionHeader(action, step, ctx),
  conditionBody: (lines) => [...lines.map((l) => (l === '' ? '' : `  ${l}`)), '}'],
  // The spec cannot pick a case.
  skippedBlock: (start, end) => [`// Step ${start + 1}: switch block [SKIPPED] — steps ${start + 2}–${end + 1} not exported (requires extension scenario routing)`],
});

// The scenario's variables, declared at the top of the test: `let` for the ones a step writes.
function variableLines(variables, written) {
  const out = [];
  const declared = new Set();
  const declare = (safe, expr) => {
    if (declared.has(safe)) return;
    declared.add(safe);
    out.push(`${written.has(safe) ? 'let' : 'const'} ${safe} = ${expr};`);
  };
  for (const [k, v] of Object.entries(variables || {})) {
    const str = activeValue(v);
    const random = parseRandomSpec(str);
    const pick = parsePickSpec(str);
    if (random) declare(ident(k), `(${randomFnJS(random.type, random.length)})()`);
    else if (pick) declare(ident(k), `${JSON.stringify(pick)}[Math.floor(Math.random() * ${pick.length})]`);
    else declare(ident(k), JSON.stringify(str));
  }
  for (const k of written) declare(k, "''");
  return out.length ? ['// --- VARIABLES ---', ...out, ''] : [];
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
  const all = actions || [];
  const enabled = all.filter((a) => a && !a.disabled);
  const warnings = new Set();
  const steps = [];
  const ctx = { all, layout: getSwitchLayout(all), warnings, steps, stepDelay, uses: new Set() };
  const body = stepLines(ctx);
  const written = new Set(enabled.flatMap((a) => writtenVarNames(a)).map(ident));

  // The start page, unless the scenario opens one first (waits aside).
  const first = enabled.find((a) => a.type !== 'wait');
  let start = [];
  if (first?.type !== 'navigate') {
    start = startUrl
      ? [`await page.goto(${JSON.stringify(startUrl)});`, '']
      : ['// ⚠ TODO: Set the starting URL (go to Settings tab to configure)', 'await page.goto("https://your-url-here.com");', ''];
  }

  const out = [`// SCENARIO: ${commentText(scenarioName)}`, "import { test } from '@playwright/test';", ''];
  out.push('// How long a step waits for its element, as set in the export.', `const TIMEOUT = ${elTimeout};`,
    'test.use({ actionTimeout: TIMEOUT });', '');
  if (body.some((l) => l.includes('await _find('))) out.push(FIND_HELPER, '');
  if (ctx.uses.has('first')) out.push(FIRST_HELPER, '');
  for (const name of ['check', 'child', 'read', 'pick']) if (ctx.uses.has(name)) out.push(PAGE_HELPERS[name], '');
  if (ctx.uses.has('input')) out.push(INPUT_HELPER, '');
  if (ctx.uses.has('js')) out.push(JS_HELPER, '');
  out.push(`test(${JSON.stringify(String(scenarioName))}, async ({ page }) => {`,
    '  // A scenario takes as long as its steps; each one waits for TIMEOUT at most.',
    '  test.setTimeout(0);');
  for (const line of [...variableLines(variables, written), ...start, ...body]) out.push(line === '' ? '' : `  ${line}`);
  out.push('});');

  // A ${name} with nothing behind it is a ReferenceError when the step runs.
  const known = new Set([...Object.keys(variables || {}), ...enabled.flatMap((a) => writtenVarNames(a))]);
  for (const name of getUsedVarNames(enabled)) {
    if (!known.has(name)) warnings.add(`\${${name}} is used by a step but not defined in the Variables tab`);
  }
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
    }),
    generate: generatePlaywright,
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/javascript' }),
  });
}
