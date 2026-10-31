/**
 * ui/extracts.js — the "Save values" tab: values taken from the response into
 * variables of the environment in use, so a later request can use them (log
 * in, save ${token}, send it with the next request). Each row is a variable
 * name, where the value comes from (a JSON path, a header, the status, the
 * body), and after a Send the value it got — hidden for names that look
 * secret, shown on 👁.
 *
 * As in the Checks tab, typing changes a row in place and loses its result;
 * adding or removing a row redraws.
 */

import { pathOf } from '../../shared/api-response.js';
import { patternVarNames } from '../../shared/text-pattern.js';
import { normalizeVarName } from '../../shared/var-name.js';
import { activeEnv, saveEnvValues } from '../model.js';
import { h, promptText, toast } from './dom.js';

const FROM = [['json', 'JSON path'], ['header', 'Header'], ['status', 'Status'], ['body', 'Body']];
const PATH_HINT = { json: 'access_token', header: 'X-Request-Id', body: 'whole body, or token=${token};' };
const SECRET = /token|secret|pass|key|auth|cookie|session/i;

/** A value as a row shows it: hidden when its name looks secret, until 👁 is pressed. */
function valueView(name, value) {
  const text = h('code', { class: 'ac-saved-value' }, value === '' ? '(empty)' : value);
  if (!SECRET.test(name)) return h('span', { class: 'ac-saved' }, '→ ', text);
  text.textContent = '••••';
  let shown = false;
  return h('span', { class: 'ac-saved' }, '→ ', text, h('button', {
    type: 'button', class: 't-btn t-btn-sm t-btn-ghost', title: 'Show / hide the value', 'aria-label': `Show the value of ${name}`,
    onclick: () => { shown = !shown; text.textContent = shown ? value : '••••'; },
  }, '👁'));
}

/** The names a row writes: its variable, or for a body pattern each ${name} in it. */
function rowNames(x) {
  if (x.from === 'body' && patternVarNames(x.path || '').length) return patternVarNames(x.path);
  const n = normalizeVarName(x.varName);
  return n ? [n] : [];
}

/** After a Send: what row `x` saved, or why it could not. */
function resultView(x, result) {
  if (!result || result.res?.error) return null;
  const names = rowNames(x);
  const problem = result.problems.find((p) => names.includes(p.varName) || p.varName === names.join(', ') || (!names.length && !p.varName));
  if (problem) return h('div', { class: 'ac-check-note ac-warn' }, `⚠ ${problem.reason}`);
  const got = names.filter((n) => Object.hasOwn(result.saved, n));
  if (!got.length) return null;
  return h('div', { class: 'ac-check-note' }, ...got.map((n) => h('div', null, h('code', null, n), ' ', valueView(n, result.saved[n]))));
}

/** The pane, and `showResults(runCaseResult)` / `addFromResponse(segs, value)` for the editor. */
export function extractsPane(ed, { onCount }) {
  const list = h('div', { class: 'ac-checks' });
  let result = null;
  const rows = () => ed.current().extracts || [];
  const save = (next, redraw = true) => {
    ed.patch({ extracts: next });
    onCount(next.length);
    if (redraw) render();
  };

  function row(x, i) {
    const note = h('div', null, resultView(x, result));
    const edit = (field) => (e) => {
      save(rows().map((r, k) => (k === i ? { ...r, [field]: e.target.value } : r)), false);
      note.replaceChildren();
    };
    const name = h('input', { type: 'text', class: 'ac-check-value', value: x.varName ?? '', placeholder: 'token', spellcheck: false,
      'aria-label': 'Variable name', oninput: edit('varName'), hidden: x.from === 'body' && patternVarNames(x.path || '').length > 0 });
    const from = h('select', { class: 'mini-select', 'aria-label': 'Where the value comes from',
      onchange: () => save(rows().map((r, k) => (k === i ? { ...r, from: from.value } : r))) },
    ...FROM.map(([v, t]) => h('option', { value: v }, t)));
    from.value = x.from || 'json';
    const path = x.from !== 'status' && h('input', { type: 'text', class: 'ac-check-path', value: x.path ?? '', placeholder: PATH_HINT[x.from || 'json'],
      spellcheck: false, 'aria-label': 'Path, header name or pattern', oninput: edit('path') });
    return h('div', { class: 'ac-check' },
      h('div', { class: 'ac-check-line' },
        name, h('span', { class: 'ac-from' }, '←'), from, path || null,
        h('button', { type: 'button', class: 't-btn t-btn-sm t-btn-ghost', title: 'Remove', 'aria-label': 'Remove this value',
          onclick: () => save(rows().filter((_, k) => k !== i)) }, '✕')),
      note);
  }

  function render() {
    list.replaceChildren(...rows().map(row));
  }

  const pane = h('div', { class: 'ac-pane' }, list,
    h('div', { class: 'ac-pane-foot' },
      h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => save([...rows(), { varName: '', from: 'json', path: '' }]) }, '＋ Save a value'),
      h('span', { class: 'helper' }, 'After each Send the values go into the environment in use. Or click a key in the response.')));
  render();

  return {
    pane,
    showResults(r) {
      result = r;
      render();
    },
    /** Ask for a name, add the row, and save the value the key holds now. */
    async addFromResponse(segs, value) {
      const last = [...segs].reverse().find((s) => typeof s === 'string') || 'value';
      const varName = await promptText({
        title: 'Save as variable', label: 'Variable name', value: last, ok: 'Save',
        check: (t) => (normalizeVarName(t) ? '' : 'Give it a name (no "}")'),
      });
      if (varName === null) return;
      const n = normalizeVarName(varName);
      save([...rows(), { varName: n, from: 'json', path: pathOf(segs) }]);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      ed.app.set(saveEnvValues(ed.app.state, { [n]: text }), { render: 'none' });
      toast(`Saved ${n} to "${activeEnv(ed.app.state).name}"`, 'success');
    },
  };
}
