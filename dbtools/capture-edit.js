/**
 * capture-edit.js — capture on the row edit page (?edit=): the form's Save and
 * "Save and continue edit" over AJAX.
 */

import * as adminer from './adapters/adminer.js';
import { interceptSubmit, logRecorded, park } from './capture-record.js';
import { refresh } from './content-main.js';
import { readRow } from './executor.js';
import { t } from './i18n.js';
import { newId, state } from './page-state.js';
import { parseRowIdf } from './params.js';
import * as store from './session.js';
import { undoStatements } from './undo.js';

const AJAX_SAVE_TIMEOUT_MS = 30 * 1000;

/* === The row edit page ═══════════════════════════════════════════════════ */

export function wireEditPage(info) {
  const form = adminer.findEditForm(document);
  if (!form) return;

  const snapshot = adminer.readEditForm(document, form);
  if (!snapshot.ok) {
    state.panel.log(t('panel.captureFailed', { reason: snapshot.reason }), 'warn');
    return;
  }

  // The row's identity, as Adminer put it in the URL. A long text key arrives as a
  // hash, which finds the row but cannot go into an undo statement; its real value
  // is in the form, so it is taken from there.
  const ident = parseRowIdf(location.search);
  for (const col of ident.hashed) {
    if (Object.prototype.hasOwnProperty.call(snapshot.values, col)) ident.where[col] = snapshot.values[col];
  }
  info = { ...info, where: ident.where };
  const keyCols = Object.keys(info.where);
  const isInsert = keyCols.length === 0 && !ident.hashed.length;
  // What the row holds right now. It starts as what the form showed at load and
  // moves forward after every "Save and continue editing", which writes without
  // leaving the page — so a later save's "before" is the row as that save found
  // it, not as the page first did.
  const baseline = { values: snapshot.values };

  const buildChange = (submitter, { keepNoop = false } = {}) => {
    const before = baseline.values;
    const isDelete = Boolean(submitter && /delete/i.test(`${submitter.name || ''} ${submitter.value || ''}`));
    const now = adminer.readEditForm(document, form);
    const after = now.ok ? now.values : {};

    let change = null;
    if (isDelete) {
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'delete',
        table: info.table,
        keyCols,
        rows: [{ where: info.where, before, after: null }],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: snapshot.unreadable,
      };
    } else if (isInsert) {
      // The new row has no key yet. What was typed is kept, and the key is settled
      // on the next page — see finalizeInsert.
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'insert',
        table: info.table,
        keyCols: [],
        rows: [{ where: {}, before: null, after }],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: [],
        insertProbe: { strategy: 'form', typed: after, functions: now.ok ? now.functions : {} },
      };
    } else {
      const row = { where: info.where, before, after };
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'update',
        table: info.table,
        keyCols,
        rows: [row],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: snapshot.unreadable,
      };
      // Nothing actually changed — Adminer will happily "save" it, but there is
      // nothing to put back, and a no-op entry only makes the changeset harder
      // to read. The AJAX save keeps it and decides once it has read the row back,
      // since a function like now() changes the row without changing the form.
      if (!keepNoop && !undoStatements(change, state.ctx.engine).length) change = null;
    }
    return change;
  };

  interceptSubmit(form, async (submitter) => {
    const change = buildChange(submitter);
    if (change) await park([change]);
  });

  if (!isInsert) wireAjaxSave(info, form, baseline, buildChange);
}

/**
 * "Save and continue editing" — the one save on the edit page that never submits.
 *
 * Adminer sends it with XMLHttpRequest from the button's click handler and cancels
 * the submit, so the page stays where it is and interceptSubmit never hears of it.
 * What it does leave is two writes into `#ajaxstatus`: its "Saving…" line,
 * synchronously inside the click, and later whatever the server answered. So the
 * change is built at the click and committed or dropped when the answer lands.
 *
 * Whether Adminer really took that path is only known once the click has run —
 * with a file chosen it falls back to a normal submit, and behind a plugin there
 * may be no handler at all. A click that wrote nothing into `#ajaxstatus` is left
 * to interceptSubmit.
 *
 * The listeners go on the form in the capture phase: 4.x puts its handler on the
 * button and 5.x delegates it from `document`, and this has to run before either.
 */
function wireAjaxSave(info, form, baseline, buildChange) {
  const status = document.getElementById('ajaxstatus');
  if (!status) return;

  let probe = null;       // a click whose outcome is not known yet
  const inflight = [];    // saves Adminer has sent and not heard back about

  new MutationObserver(() => {
    if (probe) {
      probe.writes++;
      return;
    }
    const save = inflight[0];
    if (!save || status.innerHTML === save.saving) return;
    inflight.shift();
    const errors = adminer.readErrors(status);
    settleAjaxSave(save, errors.length
      ? { error: errors[0] }
      : { verified: adminer.readMessages(status).length > 0 });
  }).observe(status, { childList: true });

  form.addEventListener('submit', () => { probe = null; }, true);

  form.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[type="submit"]') : null;
    if (!button || button.name !== 'insert' || button.form !== form) return;
    if (!state.on) return;
    const change = buildChange(button, { keepNoop: true });
    if (!change) return;

    // Followed even with no session recording, so the baseline keeps up: a
    // session started later on this same page must not take a row that was saved
    // in the meantime for the one it replaced.
    const recording = Boolean(state.session && !state.session.closedAt);
    const current = { change, sessionId: recording ? state.session.id : null, writes: 0 };
    probe = current;
    setTimeout(() => {
      if (probe !== current) return;   // it submitted normally; interceptSubmit has it
      probe = null;
      if (!current.writes) return;     // nothing was sent
      current.saving = status.innerHTML;
      current.before = baseline.values;
      current.after = change.rows[0].after;
      // Moved now rather than when the answer arrives, so a second save sent
      // before the first one is answered does not record the first one's edit
      // again.
      baseline.values = current.after;
      current.timer = setTimeout(() => {
        const at = inflight.indexOf(current);
        if (at < 0) return;
        inflight.splice(at, 1);
        settleAjaxSave(current, { verified: false });
      }, AJAX_SAVE_TIMEOUT_MS);
      inflight.push(current);
    }, 0);
  }, true);

  async function settleAjaxSave(save, outcome) {
    clearTimeout(save.timer);
    if (outcome.error) {
      if (baseline.values === save.after) baseline.values = save.before;
      if (save.sessionId) state.panel.log(t('panel.saveFailed', { reason: outcome.error }), 'warn');
      return;
    }

    // The form shows what was typed; the row holds what the database made of it —
    // now() or md5() applied, a CHAR trimmed, a number reformatted. The page is
    // still here, so read the row back and record that as the "after": the drift
    // check compares against it, and a typed value would report drift that is not
    // there. The next save starts from it too, unless another one has moved the
    // baseline in the meantime.
    let after = save.after;
    try {
      const read = await readRow(state.ctx, info.table, info.where);
      if (read.ok && read.values) after = read.values;
    } catch { /* keep what was typed; the drift check still guards the rollback */ }
    if (baseline.values === save.after) baseline.values = after;
    if (!save.sessionId) return;

    const change = { ...save.change, rows: [{ ...save.change.rows[0], after }], verified: outcome.verified };
    if (!undoStatements(change, state.ctx.engine).length) return;
    await store.appendChange(save.sessionId, change);
    logRecorded(change);
    await refresh();
  }
}
