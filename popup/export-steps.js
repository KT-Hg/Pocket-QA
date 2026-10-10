/**
 * export-steps.js — the Test steps export: a scenario written out as a test
 * case, in Markdown (for a document or a bug report) or CSV (Step, Action, Data,
 * Expected — columns TestRail, Xray and Zephyr import).
 *
 * It is documentation, not code that runs, so no step is left out: each one is
 * a sentence a tester can follow. Steps are numbered as the scenario list numbers
 * them (a Switch block's 7.1.1), and what a Condition or a Switch case governs is
 * indented under it. ${name} references stay as written; the Markdown lists the
 * variables they name under "Test data".
 */

import { initExportModal } from './export-modal.js';
import { getSwitchLayout, getConditionLayout, conditionRange, isAlwaysSwitch, caseLabel, caseRange, isBlockCase, SWITCH_SELF } from '../shared/switch-blocks.js';
import { normalizeVarName } from '../shared/var-name.js';
import { patternVarNames } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';

// A step's element, as a reader finds it on the page: its text, else its id, name or selector.
function elementOf(selectors, selector) {
  const s = selectors && typeof selectors === 'object' ? selectors : {};
  if (s.text) return `"${s.text}"`;
  const sel = (s.id && `#${s.id}`) || (s.name && `[name="${s.name}"]`) || s.css || selector || s.xpath || s.fullXpath;
  return sel ? `\`${sel}\`` : 'the element';
}

// The element an action acts on: with a Child Condition, the child it picks in the parent.
function targetOf(action) {
  const parent = elementOf(action.selectors, action.selector);
  const c = action.conditions;
  if (!c || typeof c !== 'object') return parent;
  const parts = [
    c.textContains && `text contains "${c.textContains}"`,
    c.valueEquals && `value is "${c.valueEquals}"`,
    c.idContains && `id contains "${c.idContains}"`,
    c.classContains && `class contains "${c.classContains}"`,
    c.typeEquals && `type is "${c.typeEquals}"`,
  ].filter(Boolean);
  return `the element in ${parent} whose ${parts.join(c.matchMode === 'all' ? ' and ' : ' or ')}`;
}

// What a Condition checks, as a sentence; a type this version does not know, by its name.
function conditionText(action) {
  const el = elementOf(action.selectors, action.selector);
  const v = String(action.expectedValue ?? '');
  switch (action.conditionType) {
    case 'elementExists':    return `${el} is on the page`;
    case 'elementNotExists': return `${el} is not on the page`;
    case 'elementVisible':   return `${el} is visible`;
    case 'elementHidden':    return `${el} is hidden or not on the page`;
    case 'textContains':     return `the text of ${el} contains "${v}"`;
    case 'textEquals':       return `the text of ${el} is "${v}"`;
    case 'valueEquals':      return `the value of ${el} is "${v}"`;
    case 'valueContains':    return `the value of ${el} contains "${v}"`;
    case 'urlContains':      return `the page address contains "${v}"`;
    case 'urlEquals':        return `the page address is "${v}"`;
    case 'hasClass':         return `${el} has the class "${v}"`;
    case 'hasAttribute': {
      const eq = v.indexOf('=');
      return eq < 0 ? `${el} has the attribute "${v}"` : `the "${v.slice(0, eq)}" attribute of ${el} is "${v.slice(eq + 1)}"`;
    }
    default: return `${action.conditionType} (${el})`;
  }
}

const READ_FROM = { text: 'the text', visible: 'the visible text', value: 'the value' };

// "step 5" or "steps 5–6", by the numbers the scenario list shows.
const span = (ctx, start, end) => (end > start ? `steps ${ctx.numberOf(start)}–${ctx.numberOf(end)}` : `step ${ctx.numberOf(start)}`);

function describeCondition(a, ctx) {
  const check = conditionText(a);
  const r = conditionRange(ctx.all, ctx.i, ctx.layout);
  const tail = r.end >= r.start ? ` — if not, skip ${span(ctx, r.start, r.end)}` : '';
  return [`Check: ${check}`, '', `${check.charAt(0).toUpperCase()}${check.slice(1)}${tail}`];
}

function describeReaddom(a, el) {
  const what = a.readFrom === 'attr' ? `the "${a.attrName || ''}" attribute` : (READ_FROM[a.readFrom] || READ_FROM.text);
  const slots = a.pattern ? patternVarNames(a.pattern) : [];
  const into = normalizeVarName(a.varName);
  const parts = [into && `into \`\${${into}}\``, slots.length && `and take ${slots.map((n) => `\`\${${n}}\``).join(', ')} from it`];
  return [`Read ${what} of ${el} ${parts.filter(Boolean).join(' ')}`.trim(), '',
    slots.length ? `The text matches \`${String(a.pattern).trim()}\`` : ''];
}

function describeShotToVar(a, el) {
  let of = 'the visible page';
  if (a.target === 'element') of = el;
  else if (a.target === 'full') of = 'the whole page';
  return [`Take a screenshot of ${of} into \`\${${normalizeVarName(a.varName) || 'screenshot'}}\``];
}

function describeSwitch(a, ctx) {
  const cases = Array.isArray(a.cases) ? a.cases : [];
  const where = (c) => {
    if (c.empty === true) return 'nothing';
    const r = caseRange(c);
    if (r) return span(ctx, r.start, r.end);
    if (c.scenarioId === SWITCH_SELF) return `go on from step ${ctx.numberOf((parseInt(c.startAt) || 1) - 1)}`;
    return `scenario "${c.scenarioName || c.scenarioId}"`;
  };
  if (isAlwaysSwitch(a)) return [`Play ${where(cases[0])}`];
  const listed = cases.map((c) => `${caseLabel(c)} → ${where(c)}`);
  if (!cases.some((c) => c.value === '__default__')) listed.push('anything else → nothing');
  const verb = cases.some(isBlockCase) ? 'play its case' : 'go to';
  return [`Depending on \`${a.switchVar || ''}\`, ${verb}: ${listed.join('; ')}`];
}

/**
 * Per action type: (action, element, ctx) → [action, data, expected]. `ctx` has
 * all, i, layout and numberOf(i), the number of the action at 0-based index i.
 */
const DESCRIBE = {
  navigate:   (a) => [`Open ${a.url || a.value || ''}`],
  click:      (a, el) => [`Click ${el}`],
  hover:      (a, el) => [`Point at ${el}`],
  input:      (a, el) => [`Enter the value into ${el}`, String(a.value ?? '')],
  dropdown:   (a, el) => [a.pick ? `Choose item #${a.pick.index ?? '?'} in ${el}` : `Open the dropdown ${el}`],
  dragdrop:   (a, el) => [`Drag ${el} onto ${elementOf(a.targetSelectors, a.targetSelector)}`],
  wait:       (a) => [`Wait ${(a.delay ?? (parseInt(a.value) || 1000)) / 1000} s`],
  script:     (a) => {
    const first = String(a.code || a.value || '').trim().split('\n')[0];
    return ['Run the custom script', first.length > 60 ? `${first.slice(0, 60)}…` : first];
  },
  condition:  (a, el, ctx) => describeCondition(a, ctx),
  readdom:    (a, el) => describeReaddom(a, el),
  screenshot: () => ['Take a screenshot of the visible page'],
  screenshot_full:    () => ['Take a screenshot of the whole page'],
  screenshot_element: (a, el) => [`Take a screenshot of ${el}`],
  screenshot_tovar:   (a, el) => describeShotToVar(a, el),
  uploadFile: (a, el) => {
    const names = Array.isArray(a.fileNames) && a.fileNames.length ? a.fileNames : [a.fileName].filter(Boolean);
    return [`Upload ${names.join(', ')} into ${el}`, String(a.folderPath || '')];
  },
  switch:     (a, el, ctx) => describeSwitch(a, ctx),
};

// One step as { action, data, expected }; a step with a label reads as its label.
function describe(a, ctx) {
  const fn = Object.hasOwn(DESCRIBE, a.type) ? DESCRIBE[a.type] : () => [String(a.type ?? 'unknown')];
  const [action, data = '', expected = ''] = fn(a, targetOf(a), ctx);
  return { action: a.label ? String(a.label) : action, data, expected };
}


// A variable's value as a tester reads it: as set, or what a Random / Pick / Fallback gives.
function variableText(raw) {
  const v = activeValue(raw);
  const random = parseRandomSpec(v);
  if (random) {
    if (random.type === 'datetime') return 'The date and time of the run';
    const kind = { alpha: 'letters', numeric: 'digits' }[random.type] || 'letters and digits';
    return `Random: ${random.length} ${kind}`;
  }
  const blank = (x) => (x === '' ? '(blank)' : x);
  const pick = parsePickSpec(v);
  if (pick) return `One of: ${pick.map(blank).join(', ')}`;
  const fallback = v.match(/^\{fallback:(.+)\}$/);
  if (fallback) return `The first that matches: ${fallback[1].split('|').map((x) => blank(x.trim())).join(', ')}`;
  return v;
}

/** The rows of the test case: { no, action, data, expected } per step that runs. */
function stepRows(actions) {
  const all = Array.isArray(actions) ? actions : [];
  const layout = getSwitchLayout(all);
  const conds  = getConditionLayout(all, layout);
  const numberOf = (i) => layout[i]?.displayNo ?? String(i + 1);
  const rows = [];
  all.forEach((a, i) => {
    // Not run: a disabled step, and every step of a disabled Switch's block.
    if (!a || a.disabled || layout[i].chain.some((c) => all[c.switchIdx]?.disabled)) return;
    // A disabled Condition guards nothing: playback passes over it.
    const depth = layout[i].depth + conds[i].conds.filter((c) => !all[c].disabled).length;
    const { action, data, expected } = describe(a, { all, i, layout, numberOf });
    rows.push({ n: i + 1, type: a.type, no: numberOf(i), action: `${depth ? `${' '.repeat(depth - 1)}↳ ` : ''}${action}`, data, expected });
  });
  return rows;
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * The scenario as a test case.
 *
 * @param {object} opts
 * @param {string} opts.format - 'markdown' (default) or 'csv'
 * @returns {{ code: string, stats: { total, supported, skipped }, steps: object[], warnings: string[] }}
 */
export function generateTestSteps(scenarioName, actions, variables, opts = {}) {
  const rows = stepRows(actions);
  const out = [];
  if (opts.format === 'csv') {
    out.push(['Step', 'Action', 'Data', 'Expected'].map(csvCell).join(','));
    for (const r of rows) out.push([r.no, r.action, r.data, r.expected].map(csvCell).join(','));
  } else {
    out.push(`# ${String(scenarioName).replace(/\r?\n/g, ' ')}`, '');
    const vars = Object.entries(variables || {});
    if (vars.length) {
      out.push('## Test data', '', '| Variable | Value |', '|---|---|');
      for (const [k, v] of vars) out.push(`| \`\${${mdCell(k)}}\` | ${mdCell(variableText(v))} |`);
      out.push('');
    }
    out.push('## Steps', '', '| # | Action | Data | Expected result |', '|---|---|---|---|');
    for (const r of rows) out.push(`| ${[r.no, r.action, r.data, r.expected].map(mdCell).join(' | ')} |`);
  }
  return {
    code: out.join('\n'),
    stats: { total: rows.length, supported: rows.length, skipped: 0 },
    steps: rows.map((r) => ({ n: r.n, type: r.type, status: 'ok', reason: '' })),
    warnings: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

const isCsv = (o) => o?.format === 'csv';

/** Wire the Test steps export. */
export function initExportSteps() {
  initExportModal({
    triggerId: 'exportSteps',
    format: 'steps',
    badge: 'TC',
    title: 'Test steps',
    downloadLabel: (o) => (isCsv(o) ? '⬇ .csv' : '⬇ .md'),
    remember: ['exportStepsFormat'],
    fileName: (base, o) => `${base}_steps.${isCsv(o) ? 'csv' : 'md'}`,
    readOptions: () => ({ format: document.getElementById('exportStepsFormat')?.value === 'csv' ? 'csv' : 'markdown' }),
    generate: generateTestSteps,
    copyText: (code) => code,
    // A spreadsheet reads a CSV as UTF-8 only with the byte-order mark.
    file: (code, o) => (isCsv(o)
      ? { text: `﻿${code}`, type: 'text/csv;charset=utf-8' }
      : { text: code, type: 'text/markdown;charset=utf-8' }),
  });
}
