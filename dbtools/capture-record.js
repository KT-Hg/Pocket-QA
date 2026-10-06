/**
 * capture-record.js — recording a change: parking it across Adminer's
 * submit-and-navigate, committing it once the next page shows whether the save
 * worked, and the shared limits of a capture.
 */

import * as adminer from './adapters/adminer.js';
import { keyColsFor } from './capture-sql.js';
import { refresh } from './content-main.js';
import { readRow, selectFull } from './executor.js';
import { TABLE_COPIES } from './features.js';
import { t } from './i18n.js';
import { state } from './page-state.js';
import * as store from './session.js';
import { keyOf, keyWhere, keysSelect, newRows, snapshotSelect } from './snapshot.js';
import { blockingReason, undoStatements, undoWhere } from './undo.js';

// "Use a backup table" is only advice while there is a backup table to make.
export const TOO_MANY_ROWS = TABLE_COPIES ? 'panel.tooManyRows' : 'panel.tooManyRowsNoCopy';

const SUBMIT_WATCHDOG_MS = 8000;

const PENDING_TTL_MS = 2 * 60 * 1000;

export const READ_BATCH = 5;

/* === Recording ═══════════════════════════════════════════════════════════ */

/** Park a capture until the next page can confirm it. */
export async function park(changes) {
  if (!changes.length) return;
  await store.setPending(state.ctx.key, { at: Date.now(), changes });
}

/**
 * Commit or drop what the previous page parked.
 *
 * An error on this page means Adminer refused the write, so the capture goes in
 * the bin. No error and no message is treated as success but flagged
 * `verified: false`, because the only other explanation — the response never
 * rendered — is indistinguishable from here.
 */
export async function settlePending() {
  const pending = await store.takePending(state.ctx.key);
  if (!pending) return;

  if (Date.now() - pending.at > PENDING_TTL_MS) {
    state.panel.log(`${t('panel.captureFailed', { reason: 'stale' })}`, 'warn');
    return;
  }

  const errors = adminer.readErrors(document);
  if (errors.length) {
    state.panel.log(`${t('panel.saveFailed', { reason: errors[0] })}`, 'warn');
    return;
  }

  // Only into a session that is recording. The panel can now show one that has
  // ended, and a change parked while recording belongs to no ended session.
  const session = await store.activeSession(state.ctx.key);
  if (!session || session.closedAt) return;
  const verified = adminer.readMessages(document).length > 0;

  for (const parked of pending.changes) {
    let change = parked;
    try {
      change = await finalizeChange(parked, pending.changes);
    } catch (err) {
      state.panel.log(t('panel.captureFailed', { reason: String(err && err.message || err) }), 'warn');
    }
    if (!change) continue;
    await store.appendChange(session.id, { ...change, verified });
    logRecorded(change);
  }
  await refresh();
}

/**
 * The part of a capture that can only be done once the write has happened.
 *
 * An edit made in the grid or through a mass edit is recorded with what was
 * typed, but what the database stored can differ — a blank number becomes NULL,
 * a function is applied — so each row is read back and that is the "after". A
 * row that did not actually change is dropped.
 *
 * An INSERT is where this matters most: the new row's key did not exist when the
 * form was submitted. It is found here — from the values that were typed, from
 * Adminer's "Item 42 has been inserted", or by comparing the table's keys with
 * the ones taken before the statement ran — and then the row is read.
 */
async function finalizeChange(change, batch = []) {
  if (change.insertProbe) return finalizeInsert(change, batch);
  if (change.readAfter) return finalizeAfter(change);
  return change;
}

async function finalizeAfter(change) {
  let allRead = true;
  const rows = [];
  for (const row of change.rows) {
    let after = row.after;
    try {
      const read = await readRow(state.ctx, change.table, undoWhere(row, change.keyCols));
      if (read.ok) after = read.values; else allRead = false;
    } catch {
      allRead = false;
    }
    rows.push({ ...row, after });
  }
  const next = { ...change, rows };
  delete next.readAfter;
  // With the rows read back, "what changed" is known exactly; the list of edited
  // columns is only kept as the fallback for rows that could not be read.
  if (allRead) delete next.restoreCols;
  next.rows = rows.filter((row) => undoStatements({ ...next, rows: [row] }, state.ctx.engine).length);
  return next.rows.length ? next : null;
}

async function finalizeInsert(change, batch = []) {
  const probe = change.insertProbe;
  const next = { ...change };
  delete next.insertProbe;
  const table = change.table;
  const engine = state.ctx.engine;

  const keyCols = change.keyCols && change.keyCols.length ? change.keyCols : await keyColsFor(table);
  let wheres = [];
  if (keyCols) {
    if (probe.strategy === 'literal') {
      wheres = probe.wheres;
    } else if (probe.strategy === 'form') {
      // Typed into the form: the key is whatever was typed, unless a key column
      // was left for the database to fill — then Adminer names it in its message.
      const typed = probe.typed || {};
      const functions = probe.functions || {};
      const complete = keyCols.every((col) => typed[col] !== undefined && typed[col] !== null
        && typed[col] !== '' && !functions[col]);
      if (complete) {
        wheres = [keyWhere(typed, keyCols)];
      } else if (keyCols.length === 1) {
        const id = adminer.insertedId(document);
        if (id) wheres = [{ [keyCols[0]]: id }];
      }
    } else if (probe.strategy === 'keys' || probe.strategy === 'rows') {
      const limit = state.settings.keyScanLimit;
      const sql = probe.strategy === 'keys'
        ? keysSelect(table, keyCols, engine, change.schema || '', limit + 1)
        : snapshotSelect(table, engine, change.schema || '', limit + 1);
      const now = await selectFull(state.ctx, sql);
      if (now.ok && now.rows.length <= limit) {
        const beforeKeys = probe.strategy === 'keys'
          ? probe.beforeKeys
          : probe.beforeRows.map((row) => JSON.stringify(row));
        const found = probe.strategy === 'keys'
          ? newRows(beforeKeys, now.rows, keyCols)
          : now.rows.filter((row) => !beforeKeys.includes(JSON.stringify(row)));
        // An INSERT in the same batch that named its keys outright owns those rows;
        // counting them here too would record them twice.
        const claimed = new Set(batch
          .filter((other) => other !== change && other.table === table && other.insertProbe
            && other.insertProbe.strategy === 'literal')
          .flatMap((other) => other.insertProbe.wheres.map((w) => keyOf(w, keyCols))));
        wheres = found.filter((row) => !claimed.has(keyOf(row, keyCols))).map((row) => keyWhere(row, keyCols));
      }
    }
  }

  if (!wheres.length) {
    next.keyCols = keyCols || [];
    next.warnings = [...(next.warnings || []), 'insert-key-unknown'];
    next.rows = [{ where: {}, before: null, after: (change.rows[0] && change.rows[0].after) || null }];
    return next;
  }

  const cap = state.settings.prefetchLimit;
  if (wheres.length > cap) next.warnings = [...(next.warnings || []), 'too-many-rows'];
  const rows = [];
  for (const where of wheres) {
    let after = null;
    if (rows.length < cap) {
      try {
        const read = await readRow(state.ctx, table, where);
        if (read.ok) after = read.values;
      } catch { /* the key is enough to undo it; the values are for reading */ }
    }
    rows.push({ where, before: null, after });
  }
  next.keyCols = keyCols;
  next.rows = rows;
  return next;
}

export function logRecorded(change) {
  const reason = blockingReason(change);
  if (reason) {
    state.panel.log(t('panel.notUndoable', { reason: t(`reason.${reason}`) }), 'warn');
  } else {
    // A click on the line opens that change on the manager page, diff open —
    // "what exactly did that save record?" answered without hunting for it.
    const sessionId = state.session && state.session.id;
    state.panel.log(
      t('panel.recorded', { op: t(`op.${change.op}`), table: change.table, n: change.rows.length }),
      'ok',
      sessionId && change.id ? {
        title: t('panel.openChange'),
        onClick: () => chrome.runtime.sendMessage({ type: 'dbtools-open-manager', sessionId, changeId: change.id }),
      } : null,
    );
  }
}

/**
 * Submit the form again after the capture has been stored.
 * `requestSubmit` is used so Adminer still sees which button was pressed.
 */
function resubmit(form, submitter) {
  form.dataset.frpDbtools = 'go';
  try {
    if (submitter && typeof form.requestSubmit === 'function') {
      form.requestSubmit(submitter);
      return;
    }
  } catch { /* fall through to the plain submit below */ }

  if (submitter && submitter.name) {
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = submitter.name;
    hidden.value = submitter.value ?? '';
    form.append(hidden);
  }
  form.submit();
}

/**
 * Wrap a form submit in an async capture, with a watchdog so a slow or broken
 * capture can never hold somebody's edit hostage.
 */
export function interceptSubmit(form, capture) {
  form.addEventListener('submit', (event) => {
    if (form.dataset.frpDbtools === 'go') return;   // our own re-submit
    const submitter = event.submitter || null;
    if (!state.on) return;
    if (!state.session || state.session.closedAt) return;

    event.preventDefault();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resubmit(form, submitter);
    };
    const watchdog = setTimeout(go, SUBMIT_WATCHDOG_MS);

    Promise.resolve()
      .then(() => capture(submitter))
      .catch((err) => state.panel.log(t('panel.captureFailed', { reason: String(err && err.message || err) }), 'err'))
      .finally(() => { clearTimeout(watchdog); go(); });
  }, true);
}
