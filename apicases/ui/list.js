/**
 * ui/list.js — the middle column: the cases of the open folder (or of all),
 * filtered by text, method and last result. A row opens its case and shows
 * how its last run went (✓ ✗ ⚠, or · not run yet); ▶ sends it from the list;
 * the checkboxes pick cases for Run / Move / Delete; rows are dragged to
 * reorder them or onto a folder. Running many: ui/run-bar.js.
 */

import { ALL, METHODS, addCase, deleteCases, findFolder, reorderCase, select, visibleCases } from '../model.js';
import { folderAuthButton } from './auth.js';
import { el, h, toast, whenText } from './dom.js';
import { exportMenu } from './exports.js';
import { importButton } from './import.js';
import { pasteCurlButton } from './paste-curl.js';
import { sendCase } from './response.js';
import { isRunning, renderRunBar, runCases } from './run-bar.js';

const MARKS = { passed: '✓', failed: '✗', broken: '⚠' };

const DRAG_TYPE = 'application/x-apicases';

/** The ids being dragged, while a drag from this list is on. */
let dragging = null;

/** The case ids a drag event carries, or null when it is not a drag of cases. */
export function draggedIds(e) {
  return dragging && e.dataTransfer?.types.includes(DRAG_TYPE) ? dragging : null;
}

export function removeCases(app, ids) {
  const prev = app.state;
  app.view.selected.clear();
  app.set(deleteCases(prev, ids));
  toast(`Deleted ${ids.length} request${ids.length === 1 ? '' : 's'}`, 'success', { action: { label: 'Undo', run: () => app.set(prev) } });
}

export function methodBadge(method) {
  return h('span', { class: `ac-method ac-m-${method.toLowerCase()}` }, method);
}

function head(app) {
  const s = app.state;
  const folder = s.folderId === ALL ? null : findFolder(s, s.folderId);
  const shown = visibleCases(s, app.view).length;
  const total = visibleCases(s).length;
  const title = h('div', { class: 'ac-head-title' },
    h('h2', { class: 'ac-title' }, folder ? folder.name : 'All requests'),
    h('span', { class: 'ac-head-count' }, shown === total ? `${total}` : `${shown} of ${total}`));
  const actions = h('div', { class: 'main-head-actions' },
    folder ? folderAuthButton(app, folder) : null,
    pasteCurlButton(app),
    importButton(app),
    exportMenu(app),
    h('button', { class: 't-btn t-btn-primary', onclick: () => app.set(addCase(app.state).state, { focus: 'url' }) }, '＋ Request'));
  return [title, actions];
}

/** The filter fields stay put (a re-render would take the caret away); only the bulk bar is rebuilt. */
function renderToolbar(app) {
  const v = app.view;
  el.listBar.hidden = !app.state.cases.length;
  el.listQuery.value = v.query;
  el.listMethod.value = v.method;
  el.listResult.value = v.result;
  // In list order, which is the order a run sends them in.
  const picked = app.state.cases.filter((c) => v.selected.has(c.id)).map((c) => c.id);
  el.listBulk.hidden = !picked.length;
  if (!picked.length) { el.listBulk.replaceChildren(); return; }
  const move = h('select', { class: 'mini-select', 'aria-label': 'Move to folder', onchange: () => { if (move.value) app.moveTo(picked, move.value); } },
    h('option', { value: '' }, 'Move to…'), ...app.state.folders.map((f) => h('option', { value: f.id }, f.name)));
  el.listBulk.replaceChildren(
    h('span', null, `${picked.length} selected`),
    h('button', { class: 't-btn t-btn-sm', disabled: isRunning(), onclick: () => runCases(app, picked, () => renderList(app)) }, '▶ Run selected'),
    move,
    h('button', { class: 't-btn t-btn-sm', onclick: () => removeCases(app, picked) }, 'Delete'),
    h('button', { class: 't-btn t-btn-sm t-btn-ghost', onclick: () => { v.selected.clear(); renderList(app); } }, 'Clear'));
}

export function initList(app) {
  el.listMethod.append(...METHODS.map((m) => h('option', { value: m }, m)));
  el.listQuery.addEventListener('input', () => { app.view.query = el.listQuery.value; renderList(app); });
  el.listMethod.addEventListener('change', () => { app.view.method = el.listMethod.value; renderList(app); });
  el.listResult.addEventListener('change', () => { app.view.result = el.listResult.value; renderList(app); });
}

function emptyState(icon, title, sub, ...buttons) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon),
    h('div', { class: 'empty-title' }, title),
    h('div', { class: 'empty-sub' }, sub),
    buttons.length ? h('div', { class: 'ac-empty-actions' }, ...buttons) : null);
}

/** Drop position on a row: before it (top half) or after it. */
function dropBefore(app, rowEl, e) {
  const r = rowEl.getBoundingClientRect();
  if (e.clientY < r.top + r.height / 2) return rowEl.dataset.id;
  // After this row: before whichever case follows it in the whole list.
  const all = app.state.cases;
  const i = all.findIndex((c) => c.id === rowEl.dataset.id);
  return all[i + 1]?.id ?? null;
}

/** "✓ 200 · 34 ms" — how the case's last run went; "·" when it has not run. */
function lastCell(last) {
  if (!last) return h('span', { class: 'ac-last', title: 'Not run yet' }, h('b', { class: 'ac-row-mark' }, '·'));
  const parts = [last.status, typeof last.ms === 'number' ? `${last.ms} ms` : null].filter((x) => x !== null && x !== undefined);
  return h('span', { class: `ac-last ac-l-${last.verdict}`, title: `Last run ${whenText(last.at)}` },
    h('b', { class: 'ac-row-mark', 'aria-label': last.verdict }, MARKS[last.verdict]), parts.join(' · '));
}

function row(app, c, n) {
  const s = app.state;
  const v = app.view;
  const showFolder = s.folderId === ALL;
  const check = h('input', {
    type: 'checkbox', checked: v.selected.has(c.id), 'aria-label': `Select ${c.name}`,
    onclick: (e) => e.stopPropagation(),
    onchange: () => { if (check.checked) v.selected.add(c.id); else v.selected.delete(c.id); renderList(app); },
  });
  const r = h('div', {
    class: `ac-row${s.caseId === c.id ? ' is-open' : ''}${v.selected.has(c.id) ? ' is-picked' : ''}`,
    dataset: { id: c.id }, draggable: true, tabIndex: 0,
    // app.state, not `s`: a value saved or an environment picked since this row was drawn stays.
    onclick: () => { if (app.state.caseId !== c.id) app.set(select(app.state, { caseId: c.id })); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === r) r.click(); },
  },
  check,
  h('span', { class: 'ac-num' }, `#${n}`),
  methodBadge(c.method),
  h('span', { class: 'ac-row-main' },
    h('span', { class: 'ac-row-name' }, c.name || '(no name)'),
    h('span', { class: 'ac-row-url' }, c.url || 'no URL yet'),
    c.last?.failures.length ? h('span', { class: `ac-row-fail ac-l-${c.last.verdict}` }, c.last.failures[0].reason) : null),
  showFolder ? h('span', { class: 'ac-chip' }, findFolder(s, c.folderId)?.name || '') : null,
  lastCell(c.last),
  h('button', { class: 't-btn t-btn-sm t-btn-ghost ac-row-run', title: 'Send', 'aria-label': `Send ${c.name}`,
    onclick: (e) => { e.stopPropagation(); sendCase(app, c.id); } }, '▶'));

  r.addEventListener('dragstart', (e) => {
    dragging = v.selected.has(c.id) ? [...v.selected] : [c.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
    e.dataTransfer.effectAllowed = 'move';
    r.classList.add('is-dragging');
  });
  r.addEventListener('dragend', () => { dragging = null; r.classList.remove('is-dragging'); });
  r.addEventListener('dragover', (e) => {
    if (!draggedIds(e) || dragging.length !== 1) return;
    e.preventDefault();
    const before = dropBefore(app, r, e) === c.id;
    r.classList.toggle('ac-drop-before', before);
    r.classList.toggle('ac-drop-after', !before);
  });
  r.addEventListener('dragleave', () => r.classList.remove('ac-drop-before', 'ac-drop-after'));
  r.addEventListener('drop', (e) => {
    r.classList.remove('ac-drop-before', 'ac-drop-after');
    const ids = draggedIds(e);
    if (!ids || ids.length !== 1) return;
    e.preventDefault();
    app.set(reorderCase(app.state, ids[0], dropBefore(app, r, e)));
  });
  return r;
}

export function renderList(app) {
  const s = app.state;
  const v = app.view;
  // A case deleted or moved away is no longer picked.
  const here = new Set(visibleCases(s).map((c) => c.id));
  for (const id of v.selected) if (!here.has(id)) v.selected.delete(id);

  el.listHead.replaceChildren(...head(app));
  renderRunBar(app, () => renderList(app));
  renderToolbar(app);
  const newRequest = () => h('button', { class: 't-btn t-btn-primary', onclick: () => app.set(addCase(app.state).state, { focus: 'url' }) }, '＋ Request');
  if (!s.cases.length && !s.folders.length) {
    el.caseList.replaceChildren(emptyState('🔌', 'No API tests yet',
      'Add a request, paste a cURL command copied from DevTools (Network → Copy → Copy as cURL (bash)), or import a Postman collection. Folders keep them in groups.',
      newRequest(), pasteCurlButton(app), importButton(app)));
    return;
  }
  const cases = visibleCases(s, v);
  if (!cases.length) {
    const filtered = v.query || v.method || v.result;
    el.caseList.replaceChildren(filtered && visibleCases(s).length
      ? emptyState('🔍', 'Nothing matches', 'No request in this view has that name, URL, method or last result.',
        h('button', { class: 't-btn', onclick: () => { v.query = ''; v.method = ''; v.result = ''; renderList(app); } }, 'Clear filters'))
      : emptyState('📭', 'No requests here yet', 'Add one, or paste a cURL command.', newRequest(), pasteCurlButton(app)));
    return;
  }
  el.caseList.replaceChildren(h('div', { class: 'ac-rows', role: 'list' }, ...cases.map((c, i) => row(app, c, i + 1))));
}
