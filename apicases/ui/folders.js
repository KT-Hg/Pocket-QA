/**
 * ui/folders.js — the left column: "All requests" and the folders, each with
 * its number of cases. A folder is renamed in place (double-click or ✎), and
 * cases dragged from the list drop onto it to move there.
 */

import { ALL, addFolder, deleteFolder, folderCounts, renameFolder, select } from '../model.js';
import { ask, el, h, toast } from './dom.js';
import { draggedIds } from './list.js';

/** The folder whose name is being edited, so a re-render keeps the field open. */
let renaming = null;

function startRename(app, id) {
  renaming = id;
  renderFolders(app);
}

function nameField(app, folder) {
  const input = h('input', { type: 'text', class: 'ac-folder-input', value: folder.name, 'aria-label': 'Folder name' });
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    if (save) app.set(renameFolder(app.state, folder.id, input.value));
    else renderFolders(app);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  queueMicrotask(() => { input.focus(); input.select(); });
  return input;
}

async function removeFolder(app, folder, count) {
  if (count && !await ask(`Delete folder "${folder.name}" and its ${count} request${count === 1 ? '' : 's'}?`, { ok: 'Delete', danger: true })) return;
  const prev = app.state;
  app.set(deleteFolder(prev, folder.id));
  toast(`Deleted folder "${folder.name}"`, 'success', { action: { label: 'Undo', run: () => app.set(prev) } });
}

/** A folder row accepts cases dragged from the list. */
function dropTarget(app, row, folderId) {
  row.addEventListener('dragover', (e) => {
    if (!draggedIds(e)) return;
    e.preventDefault();
    row.classList.add('ac-drop');
  });
  row.addEventListener('dragleave', () => row.classList.remove('ac-drop'));
  row.addEventListener('drop', (e) => {
    row.classList.remove('ac-drop');
    const ids = draggedIds(e);
    if (!ids) return;
    e.preventDefault();
    app.moveTo(ids, folderId);
  });
}

export function renderFolders(app) {
  const s = app.state;
  const counts = folderCounts(s);
  const row = (id, name, count, extra = []) => {
    const r = h('div', {
      class: `ac-folder${s.folderId === id ? ' is-open' : ''}`,
      dataset: { id },
      tabIndex: 0,
      // app.state, not `s`: what was typed since this list was drawn stays.
      onclick: () => { if (app.state.folderId !== id) app.set(select(app.state, { folderId: id, caseId: null })); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === r) r.click(); },
    }, ...[name].flat(), h('span', { class: 'rtab-n' }, count), ...extra);
    return r;
  };

  const rows = [row(ALL, h('span', { class: 'ac-folder-name' }, 'All requests'), s.cases.length)];
  for (const f of s.folders) {
    const count = counts[f.id] || 0;
    if (renaming === f.id) {
      rows.push(h('div', { class: 'ac-folder is-renaming' }, nameField(app, f)));
      continue;
    }
    const r = row(f.id, h('span', { class: 'ac-folder-name', title: f.name, ondblclick: () => startRename(app, f.id) }, f.name), count, [
      h('span', { class: 'ac-row-actions' },
        h('button', { class: 't-btn t-btn-sm t-btn-ghost', title: 'Rename', onclick: (e) => { e.stopPropagation(); startRename(app, f.id); } }, '✎'),
        h('button', { class: 't-btn t-btn-sm t-btn-ghost', title: 'Delete folder', onclick: (e) => { e.stopPropagation(); removeFolder(app, f, count); } }, '🗑')),
    ]);
    dropTarget(app, r, f.id);
    rows.push(r);
  }
  if (!s.folders.length) rows.push(h('p', { class: 'helper ac-rail-hint' }, 'No folders yet. ＋ Folder makes one; a new request makes one for you.'));
  el.folderList.replaceChildren(...rows);
}

export function initFolders(app) {
  el.addFolder.addEventListener('click', () => {
    const { state, id } = addFolder(app.state, 'New folder');
    renaming = id;
    app.set(state);
  });
}
