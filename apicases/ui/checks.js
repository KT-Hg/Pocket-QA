/**
 * ui/checks.js — the Checks tab: the case's checks as rows (what is checked,
 * how, against what), and after a Send each row's ✓ / ✗ / ⚠ with what came
 * back. A case with no status check of its own shows the default "status is
 * 2xx" row too, since that is checked all the same (shared/api-response.js).
 *
 * Typing changes a check in place; adding, removing, reordering or changing
 * what a row checks redraws the rows. A changed check loses its mark: the mark
 * belonged to the check as it was sent.
 */

import { DEFAULT_STATUS_CHECK, checkLabel, parsePath, pathOf, statusMatches } from '../../shared/api-response.js';
import { h, toast } from './dom.js';
import { suggestVars } from './var-suggest.js';

const ON = [['status', 'Status'], ['json', 'JSON'], ['header', 'Header'], ['body', 'Body'], ['time', 'Time']];
const OPS = {
  status: [['is', 'is']],
  json: [['equals', '='], ['contains', 'contains'], ['exists', 'exists'], ['notExists', 'does not exist'], ['gt', '>'], ['lt', '<']],
  header: [['exists', 'exists'], ['equals', '='], ['contains', 'contains']],
  body: [['contains', 'contains'], ['notContains', 'does not contain']],
  time: [['lt', '<']],
};
const NO_VALUE = new Set(['exists', 'notExists']);
const PATH_HINT = { json: 'data.id', header: 'Content-Type' };
const VALUE_HINT = { status: '200 · 2xx · 200,201 · not5xx', json: 'value', header: 'value', body: 'text', time: 'ms' };
const MARK = { true: ['✓', 'ac-ok'], assert: ['✗', 'ac-bad'], broken: ['⚠', 'ac-warn'] };

/** What is wrong with a check as typed, or ''. */
function problemOf(c) {
  if (c.on === 'json') return parsePath(c.path).error || '';
  if (c.on === 'header' && !String(c.path ?? '').trim()) return 'Which header?';
  if (c.on === 'status' && statusMatches(200, c.expected ?? '') === null) return 'Write 200, 2xx, 200,201 or not5xx';
  if (c.on === 'time' && !(Number(c.expected) > 0)) return 'A number of milliseconds';
  return '';
}

function select(options, value, label, onchange) {
  const s = h('select', { class: 'mini-select', 'aria-label': label, onchange: () => onchange(s.value) },
    ...options.map(([v, text]) => h('option', { value: v }, text)));
  s.value = value;
  return s;
}

function markOf(result) {
  if (!result) return h('span', { class: 'ac-mark' });
  const [sym, cls] = MARK[result.ok ? 'true' : result.kind];
  return h('span', { class: `ac-mark ${cls}`, title: result.message || 'Holds' }, sym);
}

// The row builders below take `p`, the pane's state: { checks() (as stored now),
// save(next, redraw), resultFor(check), drag: { from } }.

/** Check `i` with field `field` set; the others as they are. */
const withField = (p, i, fields) => p.checks().map((x, k) => (k === i ? { ...x, ...fields } : x));

/** Reorder by dragging the ⋮⋮ handle of one row onto another. */
function draggable(p, row, handle, i) {
  handle.addEventListener('dragstart', (e) => { p.drag.from = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
  handle.addEventListener('dragend', () => { p.drag.from = null; });
  row.addEventListener('dragover', (e) => { if (p.drag.from !== null) { e.preventDefault(); row.classList.add('ac-drop-before'); } });
  row.addEventListener('dragleave', () => row.classList.remove('ac-drop-before'));
  row.addEventListener('drop', (e) => {
    row.classList.remove('ac-drop-before');
    const from = p.drag.from;
    p.drag.from = null;
    if (from === null || from === i) return;
    e.preventDefault();
    const next = [...p.checks()];
    const [moved] = next.splice(from, 1);
    next.splice(from < i ? i - 1 : i, 0, moved);
    p.save(next);
  });
}

function checkRow(p, c, i) {
  const note = h('div', { class: 'ac-check-note' });
  const mark = markOf(p.resultFor(c));
  const showNote = () => {
    const problem = problemOf(p.checks()[i]);
    const r = p.resultFor(p.checks()[i]);
    note.textContent = problem || (r && !r.ok ? r.message : '');
    note.className = `ac-check-note${problem ? ' ac-bad' : ''}`;
    note.hidden = !note.textContent;
  };
  const edit = (field) => (e) => {
    p.save(withField(p, i, { [field]: e.target.value }), false);
    mark.replaceChildren();
    mark.className = 'ac-mark';
    showNote();
  };
  const path = PATH_HINT[c.on] && h('input', { type: 'text', class: 'ac-check-path', value: c.path ?? '', placeholder: PATH_HINT[c.on],
    spellcheck: false, 'aria-label': c.on === 'json' ? 'JSON path' : 'Header name', oninput: edit('path') });
  const value = !NO_VALUE.has(c.op) && h('input', { type: 'text', class: 'ac-check-value', value: c.expected ?? '',
    placeholder: VALUE_HINT[c.on], spellcheck: false, 'aria-label': 'Expected value', oninput: edit('expected') });
  if (value) suggestVars(value, p.app);
  const handle = h('span', { class: 'ac-handle', draggable: true, title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮');
  const changeOn = (on) => p.save(withField(p, i, {
    on, op: OPS[on][0][0], path: PATH_HINT[on] ? c.path ?? '' : '', expected: on === c.on ? c.expected : '',
  }));
  const row = h('div', { class: 'ac-check', dataset: { i } },
    h('div', { class: 'ac-check-line' },
      handle,
      select(ON, c.on, 'What to check', changeOn),
      path || null,
      select(OPS[c.on] || [[c.op, c.op]], c.op, 'How to compare', (op) => p.save(withField(p, i, { op }))),
      value || null,
      mark,
      h('button', { type: 'button', class: 't-btn t-btn-sm t-btn-ghost', title: 'Remove this check', 'aria-label': 'Remove this check',
        onclick: () => p.save(p.checks().filter((_, k) => k !== i)) }, '✕')),
    note);
  draggable(p, row, handle, i);
  showNote();
  return row;
}

/** The "status is 2xx (default)" row, shown while the case has no status check. */
function defaultRow(results) {
  const r = results.find((x) => x.check.implicit);
  return h('div', { class: 'ac-check ac-check-default' },
    h('div', { class: 'ac-check-line' },
      h('span', { class: 'ac-check-text' }, checkLabel(DEFAULT_STATUS_CHECK)),
      h('span', { class: 'helper ac-grow' }, '— add a Status check to expect something else'),
      markOf(r)),
    r && !r.ok ? h('div', { class: 'ac-check-note' }, r.message) : null);
}

/** A check on the value a key in the response holds: equals it, or exists for an object / array. */
function checkFromResponse(segs, value) {
  const path = pathOf(segs);
  return value !== null && typeof value === 'object'
    ? { on: 'json', path, op: 'exists' }
    : { on: 'json', path, op: 'equals', expected: typeof value === 'string' ? value : JSON.stringify(value) };
}

/** The pane, and `showResults(runCaseResult)` / `addFromResponse(segs, value)` for the editor. */
export function checksPane(ed, { onCount }) {
  const list = h('div', { class: 'ac-checks' });
  let results = [];
  const p = {
    checks: () => ed.current().checks || [],
    save: (next, redraw = true) => {
      ed.patch({ checks: next });
      onCount(next.length);
      if (redraw) render();
    },
    resultFor: (c) => results.find((r) => r.check === c),
    drag: { from: null },
    app: ed.app,
  };

  function render() {
    const cs = p.checks();
    const rows = cs.map((c, i) => checkRow(p, c, i));
    if (!cs.some((c) => c.on === 'status')) rows.unshift(defaultRow(results));
    list.replaceChildren(...rows);
  }

  const addOne = () => p.save([...p.checks(), p.checks().some((c) => c.on === 'status')
    ? { on: 'json', path: '', op: 'equals', expected: '' }
    : { on: 'status', op: 'is', expected: '200' }]);
  const pane = h('div', { class: 'ac-pane' }, list,
    h('div', { class: 'ac-pane-foot' },
      h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: addOne }, '＋ Add check'),
      h('span', { class: 'helper' }, 'Or click a key in the response. Type ${ in a value to pick a variable.')));
  render();

  return {
    pane,
    showResults(result) {
      results = result?.checks || [];
      render();
    },
    addFromResponse(segs, value) {
      const check = checkFromResponse(segs, value);
      p.save([...p.checks(), check]);
      toast(`Added check: ${checkLabel(check)}`, 'success');
    },
  };
}
