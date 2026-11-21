/**
 * bug-report.js — the bug report of a Play or Resume, as Markdown to paste into
 * an issue tracker: the failure, the page, when, the environment, the steps that
 * led to it (lastRun's first failure keeps them as `trace`), the other failures,
 * the variables those steps use, the screenshot to attach.
 *
 * Typed values (Input, Upload File, Run JS, a value check) and variable values
 * stay hidden unless `showValues`: a report gets pasted where many can read it.
 * Variable names always show — `${password}` says what was typed, not what.
 *
 * Pure — no chrome.*.
 */

import { conditionSkip } from './switch-blocks.js';
import { verdictLabel, failCountsText, partSpan } from './verdict.js';
import { normalizeVarName } from './var-name.js';
import { formatStamp } from './time-format.js';
import { waitMs } from './wait-ms.js';

const HIDDEN = '•••';
const VAR_REF = /\$\{[^}]+\}/g;
// Of a Run JS step's code, the start, on one line.
const CODE_SHOWN_MAX = 80;

/**
 * Text that Markdown would read as formatting, escaped; on one line. Not `#`: it
 * makes a heading only at a line's start, where page text never lands here, and
 * "Order \#1042" reads badly wherever the report is pasted as plain text.
 */
function _md(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

/** An inline code span that holds any text, backticks included. */
function _code(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
}

/** A typed value: quoted when shown; hidden, only its variable references stay. */
function _value(v, showValues) {
  const s = String(v ?? '');
  if (showValues) return `"${_md(s)}"`;
  const refs = s.match(VAR_REF) || [];
  const literal = s.replace(VAR_REF, '').trim() !== '';
  return (literal ? HIDDEN : '') + refs.map(_code).join('');
}

/** The element a step acts on: the text it was recorded with, and its selector. */
function _target(a) {
  const text = a.selectors?.text;
  if (!a.selector) return text ? `"${_md(text)}"` : 'the page';
  return text ? `"${_md(text)}" (${_code(a.selector)})` : _code(a.selector);
}

// A Condition's or an Assert's check, in words; `v` is its expected value.
const CHECKS = {
  elementExists:    (t) => `${t} exists`,
  elementNotExists: (t) => `${t} does not exist`,
  elementVisible:   (t) => `${t} is visible`,
  elementHidden:    (t) => `${t} is hidden`,
  textContains:     (t, v) => `the text of ${t} contains "${_md(v)}"`,
  textEquals:       (t, v) => `the text of ${t} is "${_md(v)}"`,
  // A value check names a typed value.
  valueContains:    (t, v, show) => `the value of ${t} contains ${_value(v, show)}`,
  valueEquals:      (t, v, show) => `the value of ${t} is ${_value(v, show)}`,
  urlContains:      (t, v) => `the URL contains "${_md(v)}"`,
  urlEquals:        (t, v) => `the URL is "${_md(v)}"`,
  hasClass:         (t, v) => `${t} has class "${_md(v)}"`,
  hasAttribute:     (t, v) => `${t} has attribute ${_code(v)}`,
};

function _check(a, showValues) {
  const say = CHECKS[a.conditionType || 'elementExists'];
  return say ? say(_target(a), a.expectedValue || '', showValues) : `${_code(a.conditionType)} holds for ${_target(a)}`;
}

function _pickText(pick) {
  if (!pick) return '';
  if (pick.index === 'random') return ' and choose a random item';
  return String(pick.index) === '-1' ? ' and choose the last item' : ` and choose item #${_md(pick.index)}`;
}

function _switchText(a) {
  const always = !a.switchVar && a.cases?.length === 1 && a.cases[0].value === '__default__';
  if (always) return `Run the scenario "${_md(a.cases[0].scenarioName || a.cases[0].scenarioId)}"`;
  return `Branch on ${_code(a.switchVar)}`;
}

function _uploadText(a, show) {
  const names = Array.isArray(a.fileNames) && a.fileNames.length ? a.fileNames : [a.fileName].filter(Boolean);
  const from = a.folderPath ? ` from ${_value(a.folderPath, show)}` : '';
  return `Upload ${names.map((n) => _value(n, show)).join(', ') || 'a file'}${from} into ${_target(a)}`;
}

function _scriptText(a, show) {
  if (!show) return 'Run JavaScript (code hidden)';
  const line = String(a.code || '').trim().split('\n')[0];
  return `Run JavaScript ${_code(line.length > CODE_SHOWN_MAX ? `${line.slice(0, CODE_SHOWN_MAX)}…` : line)}`;
}

// One sentence per action type the form offers (tests/bug-report.test.mjs checks them all).
const SENTENCES = {
  click:              (a) => `Click ${_target(a)}`,
  input:              (a, show) => `Type ${_value(a.value, show)} into ${_target(a)}`,
  hover:              (a) => `Hover over ${_target(a)}`,
  dropdown:           (a) => `Open the dropdown ${_target(a)}${_pickText(a.pick)}`,
  dragdrop:           (a) => `Drag ${_target(a)} onto ${_code(a.targetSelector)}`,
  navigate:           (a) => `Go to ${String(a.url || a.value || '').trim()}`,
  wait:               (a) => `Wait ${waitMs(a)} ms`,
  script:             _scriptText,
  condition:          (a, show) => {
    const n = conditionSkip(a);
    return `If ${_check(a, show)} (${n ? `otherwise skip the next ${n}` : 'guards nothing'})`;
  },
  assert:             (a, show) => `Check that ${_check(a, show)}`,
  switch:             _switchText,
  readdom:            (a) => `Read ${_target(a)} into ${_code(`\${${normalizeVarName(a.varName)}}`)}`,
  screenshot:         () => 'Take a screenshot',
  screenshot_full:    () => 'Take a full-page screenshot',
  screenshot_element: (a) => `Take a screenshot of ${_target(a)}`,
  screenshot_tovar:   (a) => `Take a screenshot into ${_code(`\${${normalizeVarName(a.varName)}}`)}`,
  uploadFile:         _uploadText,
  switchTab:          (a) => (a.tabTarget === 'back'
    ? `${a.closeTab ? 'Close this tab and go' : 'Go'} back to the tab that opened it`
    : 'Go to the new tab the page opened'),
};

/** A step in words, with its label; `showValues`: what was typed, uploaded or scripted. */
export function stepText(action, { showValues = false } = {}) {
  const say = SENTENCES[action.type];
  const text = say ? say(action, showValues) : `Unknown step "${_md(action.type)}" on ${_target(action)}`;
  return action.label ? `${text} — ${_md(action.label)}` : text;
}

const _mark = (f) => (f.kind === 'assert' ? '✗' : '⚠');
// ' in "Pay"': a step of another scenario a Switch played; its number is that one's.
const _in = (f) => (f.scenarioId ? ` in "${f.scenarioName || f.scenarioId}"` : '');

/** "2026-10-18 14:03:05", local time. */
function _when(ms) {
  return formatStamp(new Date(ms)).replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');
}

/** The action of a trace step: an index of the scenario, or { scenarioId, i } of another a Switch played. */
const _traceAction = (run, step) => (typeof step === 'number'
  ? run.actions?.[step]
  : run.otherActions?.[step?.scenarioId]?.[step?.i]);

/**
 * The numbered steps: those run up to the failure (its trace), or — with no
 * trace — the scenario's steps up to the failed one, said so. The steps of another
 * scenario a Switch played are a list under that Switch, one level per Switch
 * deep. A trace kept before those were traced ends on that Switch, which tells
 * the failure instead.
 */
function _steps(run, first, showValues) {
  const acts = run.actions || [];
  const failedAt = first.index - 1;
  let trace = first.trace;
  const lines = [];
  if (!Array.isArray(trace)) {
    lines.push('_Steps as defined in the scenario, not as run._', '');
    trace = acts.slice(0, failedAt + 1).map((a, i) => (a?.disabled ? -1 : i)).filter((i) => i >= 0);
  }
  // Per list level: its count so far, and the indent of its items (past the
  // number of the item it is under, as Markdown wants).
  const counts = [];
  const pads = [''];
  let depth = -1;
  trace.forEach((step, k) => {
    const action = _traceAction(run, step);
    if (!action) return;
    const other = typeof step === 'number' ? null : step;
    // A resume inside another scenario starts deep, with no Switch above it.
    const d = other ? Math.min(other.depth || 1, depth + 1) : 0;
    counts.length = d + 1;
    counts[d] = (counts[d] || 0) + 1;
    pads[d + 1] = pads[d] + ' '.repeat(String(counts[d]).length + 2);
    depth = d;
    let text = stepText(action, { showValues });
    if (k === trace.length - 1) {
      text = `${_mark(first)} ${text}`;
      // The Switch a trace of old ends on: flagged by the run (`nested`), else told by its index.
      if (!other && (first.nested || step !== failedAt)) text += ` — it failed at its step #${first.index}`;
    }
    lines.push(`${pads[d]}${counts[d]}. ${text}`);
  });
  return lines;
}

/** The variables the listed steps refer to, with the values the caller knows (`vars`). */
function _variables(run, first, vars, showValues) {
  const acts = Array.isArray(first.trace) ? first.trace.map((step) => _traceAction(run, step)) : run.actions || [];
  const names = [...new Set((JSON.stringify(acts).match(VAR_REF) || []).map((r) => r.slice(2, -1)))];
  return names.map((n) => {
    let value = '(not set)';
    if (vars && n in vars) value = showValues ? _code(vars[n]) : HIDDEN;
    return `- ${_code(n)} = ${value}`;
  });
}

/**
 * The report of `run` (lastRun, bg/playback.js). `env`: { browser, os, version };
 * `shotName`: the screenshot's file name, or none; `vars`: the variables' values
 * as saved now (the run did not keep them).
 */
/** The title and what the failure was: where, when, the run's result, the browser. */
function _head(run, first, env) {
  const status = run.verdict?.status || 'broken';
  const where = [
    _when(first.at ?? run.endedAt),
    run.loops > 1 && first.loop ? `loop ${first.loop} of ${run.loops}` : '',
    run.resumed ? 'resumed' : '',
    run.part ? `steps ${partSpan(run.part)} only (the steps before were not played)` : '',
  ].filter(Boolean).join(' · ');
  const counts = failCountsText(run.verdict || {});
  return [
    `## ${verdictLabel(status)} — ${_md(run.scenarioName || run.scenarioId)}, step #${first.index}${_md(_in(first))}`,
    '',
    `- **Failure:** ${_mark(first)} #${first.index}${_md(_in(first))} ${_md(first.label || first.type)} — ${_md(first.reason)}`,
    ...(first.url ? [`- **Page:** ${String(first.url).replace(/\s+/g, '')}`] : []),
    `- **When:** ${where}`,
    `- **Result:** ${verdictLabel(status)}${counts ? ` — ${counts}` : ''}`,
    `- **Environment:** ${[env.browser, env.os, env.version && `Pocket QA ${env.version}`].filter(Boolean).map(_md).join(' · ')}`,
  ];
}

export function buildBugReport(run, { showValues = false, env = {}, shotName = null, vars = null } = {}) {
  const [first, ...others] = run.failures || [];
  if (!first) return '';
  const out = [
    ..._head(run, first, env),
    '',
    '### Steps to reproduce',
    '',
    ..._steps(run, first, showValues),
  ];
  if (others.length) {
    out.push('', '### Other failures in this run', '',
      ...others.map((f) => `- ${_mark(f)} #${f.index}${_md(_in(f))} ${_md(f.label || f.type)} — ${_md(f.reason)}`));
  }
  const variables = _variables(run, first, vars, showValues);
  if (variables.length) out.push('', '### Variables', '', ...variables, '', '_Values as saved now, not necessarily those of the run._');
  out.push('', '### Screenshot', '', shotName
    ? `Attached: ${_code(shotName)} — the page when step #${first.index} failed.`
    : '_No screenshot: the tab was not in front, or the capture failed._');
  return `${out.join('\n')}\n`;
}
