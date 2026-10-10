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
import { getSwitchLayout, hasBlock, blockEnd, conditionSkipTarget, conditionSkip } from '../shared/switch-blocks.js';
import { writtenVarNames } from '../shared/var-name.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';
import { locatorsOf } from '../shared/locator-order.js';
import { cssEscape } from '../shared/css-escape.js';
import { mark, newStep, blockSteps } from './export/steps.js';
import { SET_INPUT_JS } from './export/page-js.js';
import { JS_RESERVED, jsIdentifier, jsValue, randomFnJS } from './export/js-code.js';

// What the generated spec declares for itself, beside the JS reserved words.
const RESERVED = new Set(['test', 'page', 'TIMEOUT', '_find', '_input', '_setInput', '_js', '_SCRIPT_INPUT_TYPES', ...JS_RESERVED]);
const ident = jsIdentifier(RESERVED);
const valueJS = jsValue(ident);

// The locators of an action's element (of its drop target with `target`), in playback's order.
function locatorsFor(action, target = false) {
  const locs = target
    ? locatorsOf(action.targetSelectors, action.targetSelector, action.targetSelectorType)
    : locatorsOf(action.selectors, action.selector, action.selectorType);
  return locs.length ? locs : [{ type: 'css', value: '' }];
}

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

/**
 * The line that finds an element into `elVar`: a plain locator for one selector,
 * else _find over all of them in order. .first(): playback acts on the first
 * match where Playwright would refuse several.
 */
function findPW(locs, elVar) {
  const sels = [...new Set(locs.map(selectorPW))];
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

// A step this export does not write yet: said in the code and in the Actions tab.
const notYet = (a, s) => {
  mark(s.step, 'skip', 'not exported to Playwright yet');
  return [`// Step ${s.n}: ${a.type}${s.lbl} — [not exported to Playwright yet]`];
};

/**
 * Per action type: (action, s) → its lines, where s = { n, lbl, el, find, ctx,
 * step } — find() is the line that finds the step's element into `el`.
 */
const STEP_LINES = {
  navigate: (a, s) => [`// Step ${s.n}: navigate${s.lbl}`, `await page.goto(${valueJS(a.url || a.value)});`],
  click:    (a, s) => [`// Step ${s.n}: click${s.lbl}`, s.find(), `await ${s.el}.click();`],
  hover:    (a, s) => [`// Step ${s.n}: hover${s.lbl}`, s.find(), `await ${s.el}.hover();`],
  input:    (a, s) => {
    s.ctx.uses.add('input');
    return [`// Step ${s.n}: input${s.lbl}`, s.find(), `await _input(${s.el}, ${valueJS(a.value)});`];
  },
  wait:     (a, s) => [`// Step ${s.n}: wait${s.lbl}`, `await page.waitForTimeout(${a.delay != null ? a.delay : (parseInt(a.value) || 1000)});`],
  script:   (a, s) => {
    const code = String(a.code || a.value || '').trim();
    if (/\$\{[^}]+\}/.test(code)) s.ctx.uses.add('js');
    mark(s.step, 'verify', 'custom JS run through page.evaluate() — check it');
    return [`// Step ${s.n}: script${s.lbl}`, scriptPW(code)];
  },
  screenshot: pageShot,
  screenshot_full: pageShot,
  screenshot_element: (a, s) => [`// Step ${s.n}: screenshot element${s.lbl}`, s.find(), `await ${s.el}.screenshot({ path: "screenshot_element_step${s.n}.png" });`],
  screenshot_tovar: (a, s) => {
    const v = ident(a.varName || 'screenshot');
    const out = [`// Step ${s.n}: screenshot → variable "${v}"${s.lbl}`, `${v} = "screenshot_${v}_step${s.n}.png";`];
    if (a.target === 'element') out.push(s.find(), `await ${s.el}.screenshot({ path: ${v} });`);
    else out.push(`await page.screenshot({ path: ${v}${a.target === 'full' ? ', fullPage: true' : ''} });`);
    return out;
  },
  switch: (a, s) => {
    mark(s.step, 'skip', 'a Switch needs the extension to choose what plays');
    return [`// Step ${s.n}: switch [SKIPPED] — requires extension scenario routing`];
  },
  readdom: notYet,
  dropdown: notYet,
  dragdrop: notYet,
  uploadFile: notYet,
};

// Lines for one step that is not a Condition; marks `step` when it is not exported as is.
function actionLines(action, step, ctx) {
  const n = step.n;
  const el = `el${n}`;
  const s = { n, el, step, ctx, lbl: action.label ? ` — ${commentText(action.label)}` : '', find: () => findPW(locatorsFor(action), el) };
  const out = Object.hasOwn(STEP_LINES, action.type)
    ? STEP_LINES[action.type](action, s)
    : (mark(step, 'skip', 'not an action type this version knows'), [`// Step ${n}: ${commentText(action.type)}${s.lbl} — [unsupported, skipped]`]);
  // The pause after a step, as in a run: not after a wait, nor after what is left out.
  const delay = action.delay != null ? action.delay : ctx.stepDelay;
  if (delay > 0 && action.type !== 'wait' && step.status !== 'skip') out.push(`await page.waitForTimeout(${delay});`);
  return out;
}


// The steps, a Switch block skipped whole as the other exports skip it.
function processActions(actions, baseIdx, ctx) {
  const out = [];
  let i = 0;
  while (i < actions.length) {
    const action = actions[i];
    const abs = baseIdx + i;
    if (hasBlock(ctx.all[abs])) {
      const end = blockEnd(ctx.all, abs);
      out.push(`// Step ${abs + 1}: switch block [SKIPPED] — steps ${abs + 2}–${end + 1} not exported (requires extension scenario routing)`, '');
      ctx.warnings.add(`Switch block at step ${abs + 1} skipped together with its ${end - abs} action(s)`);
      ctx.steps.push(...blockSteps(ctx.all, abs, end));
      i = end - baseIdx + 1;
      continue;
    }
    if (action.disabled) { i++; continue; }
    const step = newStep(action, abs + 1);
    ctx.steps.push(step);
    if (action.type === 'condition') {
      // Not exported yet: the steps it guards are left out too, rather than run every time.
      const bodyEnd = conditionSkipTarget(ctx.all, abs, conditionSkip(action), ctx.layout) - baseIdx;
      out.push(`// Step ${abs + 1}: condition [SKIPPED] — not exported to Playwright yet, nor the steps it guards`, '');
      mark(step, 'skip', 'a Condition is not exported to Playwright yet');
      for (let j = i + 1; j < bodyEnd; j++) {
        if (actions[j] && !actions[j].disabled) {
          ctx.steps.push({ n: baseIdx + j + 1, type: actions[j].type, status: 'skip', reason: `guarded by the Condition at step ${abs + 1}` });
        }
      }
      i = Math.max(i + 1, bodyEnd);
      continue;
    }
    out.push(...actionLines(action, step, ctx), '');
    i++;
  }
  return out;
}

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
  const body = processActions(all, 0, ctx);
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
    downloadLabel: '⬇ .spec.js',
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
