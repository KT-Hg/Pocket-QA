/**
 * capture-grid.js — capture on the select page: cells edited in the grid, ticked
 * rows deleted or mass-edited.
 */

import * as adminer from './adapters/adminer.js';
import { READ_BATCH, TOO_MANY_ROWS, interceptSubmit, park } from './capture-record.js';
import { captureInsertByDifference } from './capture-sql.js';
import { gridIdfs, readRowByIdf } from './executor.js';
import { t } from './i18n.js';
import { newId, state } from './page-state.js';
import { parseRowIdf } from './params.js';

/* === The select page: the grid, and the mass edit ════════════════════════ */

/**
 * The `?select=` URL shows one of two things: the data grid, or — after "Edit" or
 * "Clone" on ticked rows — an edit form that applies to all of them.
 *
 * The grid writes three ways, all through one form and one full-page submit:
 *   - a cell edited in place (Ctrl+click, double-click, or `&modify=1`), saved
 *     with "Save": an UPDATE per row, of the edited columns;
 *   - "Delete" on ticked rows, or on the whole result;
 *   - "Import" of a CSV, which is not captured and says so.
 *
 * Nothing on screen can be trusted as the old value — the grid shortens long text
 * and formats what it shows — so every affected row is read through its own edit
 * form before the submit is let go, the same way a hand-written statement's rows
 * are.
 */
export function wireSelectPage(info) {
  const editForm = adminer.findEditForm(document);
  if (editForm) {
    wireMassEdit(info, editForm);
    return;
  }
  const grid = adminer.findGridForm(document);
  if (grid) wireGrid(info, grid);
}

function wireGrid(info, form) {
  interceptSubmit(form, async (submitter) => {
    const name = (submitter && submitter.name) || '';
    if (name === 'delete') {
      const selection = adminer.readGridSelection(form);
      const change = await captureRowsDelete(info.table, selection.checked, selection.all, 'grid-delete');
      if (change) await park([change]);
      return;
    }
    if (name === 'import') {
      state.panel.log(t('panel.notUndoable', { reason: t('reason.import-not-captured') }), 'warn');
      return;
    }
    if (name) return;   // edit / clone / export: nothing is written from this page

    const edits = adminer.readGridEdits(form);
    if (!edits.length) return;
    const change = await captureGridEdits(info.table, edits);
    if (change) await park([change]);
  });
}

function wireMassEdit(info, form) {
  interceptSubmit(form, async (submitter) => {
    const target = adminer.readMassEditTarget(form);
    const name = (submitter && submitter.name) || '';
    let change = null;
    if (name === 'delete') {
      change = await captureRowsDelete(info.table, target.checked, target.all, 'mass-delete');
    } else if (target.clone) {
      change = await captureInsertByDifference(info.table, 'grid-clone', '');
    } else {
      const cols = adminer.massEditColumns(form);
      if (!cols.length) return;
      const typed = adminer.readEditForm(document, form);
      change = await captureRowsUpdate({
        table: info.table, checked: target.checked, all: target.all, cols,
        typed: typed.ok ? typed.values : {}, source: 'mass-edit',
      });
    }
    if (change) await park([change]);
  });
}

/** Which rows an action on the grid applies to: the ticked ones, or everything the search matches. */
async function targetIdfs(checked, all) {
  if (!all) return { idfs: checked, tooMany: false };
  const cap = state.settings.prefetchLimit;
  const idfs = await gridIdfs(location.href, cap + 1);
  return { idfs, tooMany: idfs.length > cap };
}

/**
 * Read rows through their edit forms, by grid identity. A hashed key column is
 * filled in from the row itself, so the predicate holds the real value.
 */
async function readRowsByIdf(table, idfs) {
  const rows = [];
  for (let i = 0; i < idfs.length; i += READ_BATCH) {
    const slice = idfs.slice(i, i + READ_BATCH);
    const read = await Promise.all(slice.map(async (idf) => {
      const ident = parseRowIdf(idf);
      try {
        const res = await readRowByIdf(state.ctx, table, idf);
        if (!res.ok) return null;
        for (const col of ident.hashed) ident.where[col] = res.values[col];
        return { idf, where: ident.where, before: res.values, unreadable: res.unreadable || [] };
      } catch {
        return null;
      }
    }));
    for (const row of read) if (row) rows.push(row);
  }
  return rows;
}

export function baseChange(op, table, source) {
  return { id: newId('ch'), at: new Date().toISOString(), op, table, source, keyCols: [], rows: [], warnings: [] };
}

async function captureRowsDelete(table, checked, all, source) {
  const change = baseChange('delete', table, source);
  const target = await targetIdfs(checked, all);
  if (target.tooMany) {
    change.warnings.push('too-many-rows');
    state.panel.log(t(TOO_MANY_ROWS, { n: state.settings.prefetchLimit }), 'err');
    return change;
  }
  if (!target.idfs.length) return null;
  state.panel.notice(t('panel.capturing'));
  const rows = await readRowsByIdf(table, target.idfs);
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.unreadableCols = [...new Set(rows.flatMap((r) => r.unreadable))];
  change.rows = rows.map((r) => ({ where: r.where, before: r.before, after: null }));
  if (rows.length < target.idfs.length) change.warnings.push('no-before');
  return change;
}

async function captureRowsUpdate({ table, checked, all, cols, typed, source }) {
  const change = baseChange('update', table, source);
  const target = await targetIdfs(checked, all);
  if (target.tooMany) {
    change.warnings.push('too-many-rows');
    state.panel.log(t(TOO_MANY_ROWS, { n: state.settings.prefetchLimit }), 'err');
    return change;
  }
  if (!target.idfs.length) return null;
  state.panel.notice(t('panel.capturing'));
  const rows = await readRowsByIdf(table, target.idfs);
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.restoreCols = cols;
  change.readAfter = true;
  change.rows = rows.map((r) => {
    const after = { ...r.before };
    for (const col of cols) if (Object.prototype.hasOwnProperty.call(typed, col)) after[col] = typed[col];
    return { where: r.where, before: r.before, after };
  });
  return change;
}

/** Cells edited in the grid, grouped into one UPDATE change with a row per grid row. */
async function captureGridEdits(table, edits) {
  const byRow = new Map();
  for (const edit of edits) {
    if (!byRow.has(edit.idf)) byRow.set(edit.idf, {});
    byRow.get(edit.idf)[edit.col] = edit.value;
  }
  const change = baseChange('update', table, 'grid-inline');
  if (byRow.size > state.settings.prefetchLimit) {
    change.warnings.push('too-many-rows');
    return change;
  }
  state.panel.notice(t('panel.capturing'));
  const idfs = [...byRow.keys()];
  const rows = await readRowsByIdf(table, idfs);
  const cols = new Set();
  change.rows = rows.map((r) => {
    const typed = byRow.get(r.idf) || {};
    Object.keys(typed).forEach((c) => cols.add(c));
    return { where: r.where, before: r.before, after: { ...r.before, ...typed } };
  });
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.restoreCols = [...cols];
  change.readAfter = true;
  return change.rows.length ? change : null;
}
