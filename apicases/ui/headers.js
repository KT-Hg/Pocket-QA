/**
 * ui/headers.js — the Headers tab: a table with a row per header (a tick to
 * send it, its name, its value), names and values suggested as you type, a
 * few one-click headers, and under the rows the headers the request gets
 * without a row (the body's Content-Type, the site's cookies). Bulk edit
 * shows the same headers as text, one "Name: value" per line, for pasting.
 *
 * The case stores the text (apicases/headers.js turns it into rows and back).
 * There is always one empty row at the end to type a new header into; typing
 * in it adds another, without redrawing the row being typed in.
 */

import { attachVarSuggest } from '../../popup/ui/var-suggest.js';
import { NAME_SUGGESTIONS, addedHeaders, parseRows, rowProblem, rowsText, valueSuggestions } from '../headers.js';
import { h } from './dom.js';
import { suggestVars } from './var-suggest.js';

// The page's own list under the field, not a <datalist>: the browser draws
// that one where it likes (off to the side at some zoom levels).
const NAME_ENTRIES = NAME_SUGGESTIONS.map((name) => ({ name }));

/** 'table' or 'bulk', kept from one case to the next. */
let mode = 'table';

const QUICK = [
  ['Accept JSON', 'Accept', 'application/json'],
  ['Bearer token', 'Authorization', 'Bearer ${token}'],
  ['No cache', 'Cache-Control', 'no-cache'],
];

const blankRow = () => ({ on: true, name: '', value: '' });

/** "Add: ＋ Accept JSON ＋ Bearer token …" — `add(name, value)` on a click. */
function quickBar(add) {
  return h('div', { class: 'ac-hdr-quick' }, h('span', { class: 'helper' }, 'Add:'),
    ...QUICK.map(([label, n, v]) => h('button', { type: 'button', class: 'pill', title: `${n}: ${v}`, onclick: () => add(n, v) }, `＋ ${label}`)));
}

/**
 * One row of the table. `p` is the table's state: { rows (the array shown, the
 * last one empty), table (its element), save(), redraw(), app }. `r` is
 * changed in place as it is typed in.
 */
function rowEl(p, r) {
  const last = r === p.rows[p.rows.length - 1];
  const note = h('div', { class: 'ac-field-error' });
  const showNote = () => { note.textContent = rowProblem(r); note.hidden = !note.textContent; };
  const parts = {};
  const grow = () => {
    // Typing in the empty last row makes it a header; a new empty row goes under it.
    if (r !== p.rows[p.rows.length - 1] || (!r.name && !r.value)) return;
    p.rows.push(blankRow());
    p.table.append(rowEl(p, p.rows[p.rows.length - 1]));
    parts.del.hidden = false;
    parts.tick.disabled = false;
  };
  const changed = () => { grow(); showNote(); p.save(); };
  parts.tick = h('input', { type: 'checkbox', checked: r.on, disabled: last, title: 'Send this header', 'aria-label': 'Send this header',
    onchange: (e) => { r.on = e.target.checked; el.classList.toggle('is-off', !r.on); p.save(); } });
  const name = h('input', { type: 'text', value: r.name, placeholder: 'Name', spellcheck: false, 'aria-label': 'Header name',
    oninput: () => { r.name = name.value; changed(); } });
  attachVarSuggest(name, { mode: 'name', getEntries: () => NAME_ENTRIES });
  const value = h('input', { type: 'text', value: r.value, placeholder: 'Value', spellcheck: false, 'aria-label': 'Header value',
    oninput: () => { r.value = value.value; changed(); } });
  suggestVars(value, p.app, 'ref', () => valueSuggestions(r.name));
  parts.del = h('button', { type: 'button', class: 't-btn t-btn-sm t-btn-ghost', hidden: last, title: 'Remove this header', 'aria-label': 'Remove this header',
    onclick: () => { p.rows.splice(p.rows.indexOf(r), 1); p.save(); p.redraw(); } }, '✕');
  const el = h('div', { class: `ac-hdr-item${r.on ? '' : ' is-off'}` },
    h('div', { class: 'ac-hdr-row' }, parts.tick, name, value, parts.del), note);
  showNote();
  return el;
}

/** "Also sent": the headers the request gets without a row of its own. */
function addedView(c) {
  const list = addedHeaders(c, parseRows(c.headers));
  return list.length ? [
    h('div', { class: 'pane-label' }, 'Also sent'),
    ...list.map(([n, v, why]) => h('div', { class: 'ac-hdr-auto' }, h('code', null, n), h('span', null, v), h('em', null, why))),
  ] : [];
}

/**
 * The pane, and `refreshAdded()` for when the body type, method or cookie
 * setting changes. `onCount(n)`: how many headers are ticked, for the tab.
 */
export function headersPane(ed, { onCount = () => {} } = {}) {
  const table = h('div', { class: 'ac-hdr-table' });
  const added = h('div', { class: 'ac-hdr-added' });
  const bulk = h('textarea', { class: 'ac-code', rows: 7, spellcheck: false, 'aria-label': 'Headers as text',
    placeholder: 'Accept: application/json\nAuthorization: Bearer ${token}\n# X-Debug: 1   ← a # line is not sent',
    oninput: () => { ed.patch({ headers: bulk.value }); refreshAdded(); } });
  suggestVars(bulk, ed.app);
  const p = {
    rows: [],
    table,
    app: ed.app,
    save: () => { ed.patch({ headers: rowsText(p.rows) }); refreshAdded(); },
    redraw: () => drawTable(),
  };

  function refreshAdded() {
    onCount(parseRows(ed.current().headers).filter((r) => r.on).length);
    added.replaceChildren(...addedView(ed.current()));
  }

  function drawTable() {
    p.rows = [...parseRows(ed.current().headers), blankRow()];
    table.replaceChildren(
      h('div', { class: 'ac-hdr-row ac-hdr-head' }, h('span'), h('span', null, 'Name'), h('span', null, 'Value'), h('span')),
      ...p.rows.map((r) => rowEl(p, r)));
  }

  const tableView = h('div', null, table, quickBar((n, v) => {
    ed.patch({ headers: rowsText([...parseRows(ed.current().headers), { on: true, name: n, value: v }]) });
    drawTable();
    refreshAdded();
  }));
  const help = h('p', { class: 'helper' });
  const toggle = h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => { mode = mode === 'table' ? 'bulk' : 'table'; show(); } });

  function show() {
    const isTable = mode === 'table';
    if (isTable) drawTable(); else bulk.value = ed.current().headers;
    tableView.hidden = !isTable;
    bulk.hidden = isTable;
    toggle.textContent = isTable ? 'Bulk edit' : 'Table';
    toggle.title = isTable ? 'Edit as text — to paste many headers at once' : 'Back to one row per header';
    help.textContent = isTable
      ? 'Untick a header to keep it without sending it. Type ${ in a value to pick a variable (from the environment or the Tools tab).'
      : 'One per line, as Name: value. A line starting with # is not sent.';
  }

  show();
  refreshAdded();
  return {
    pane: h('div', { class: 'ac-pane' }, h('div', { class: 'ac-pane-head' }, help, toggle), tableView, bulk, added),
    refreshAdded,
  };
}
