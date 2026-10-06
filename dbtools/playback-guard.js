/**
 * playback-guard.js — the Playback guard: snapshot tables before a run, roll
 * back after it, and ask about rows changed by someone else (drift).
 */

import { refresh } from './content-main.js';
import { t } from './i18n.js';
import { state } from './page-state.js';
import { rollback } from './rollback-commands.js';
import * as store from './session.js';
import { resumeSetAside, takeSnapshots } from './snapshot-commands.js';

/* === Playback guard ══════════════════════════════════════════════════════
 * Asked for by the background around a Record & Playback run: open a session and
 * snapshot the chosen tables before the run, then close it and — when the person
 * asked for that — roll it back once the run is over. The run itself usually
 * drives the application under test, not Adminer, so it is the snapshots that
 * catch its writes; anything it does through Adminer lands in the change log as
 * usual.
 * ═══════════════════════════════════════════════════════════════════════════ */

export async function guardBegin(msg) {
  // A session someone was recording by hand is set aside, not merged: the run is
  // rolled back as a whole afterwards, and their own changes must not go with it.
  // It is reopened when the run's session ends.
  let resumeId = '';
  if (state.session && !state.session.closedAt) {
    resumeId = state.session.id;
    await store.closeSession(resumeId);
    state.panel.log(t('panel.guardSetAside', { name: state.session.name }), 'warn');
  }
  const session = await store.startSession({
    name: msg.name || t('panel.defaultName'),
    conn: state.ctx.conn,
    origin: state.ctx.origin,
    base: state.ctx.base,
    key: state.ctx.key,
    guard: true,
    resumeId,
  });
  const snaps = await takeSnapshots(session.id, msg.tables || []);
  await refresh();
  state.panel.notice(t('panel.guardStarted', { name: msg.name || '' }), 'ok');
  return { ok: true, sessionId: session.id, taken: snaps.taken.length, errors: snaps.errors };
}

export async function guardEnd(msg) {
  const session = await store.getSession(msg.sessionId);
  if (!session) return { ok: false, error: 'no-session' };
  if (!session.closedAt) await store.closeSession(session.id);
  if (!msg.autoRollback) {
    await resumeSetAside(session);
    return { ok: true, kept: true, name: session.name };
  }
  const report = await rollback({ sessionId: session.id, auto: true });
  await resumeSetAside(session);
  const snaps = report.snapshots || { ok: 0, failed: 0, errors: [] };
  return {
    ok: true,
    name: session.name,
    changes: report.ok || 0,
    failed: (report.failed || 0) + snaps.failed,
    tables: snaps.ok,
    snapshotErrors: snaps.errors,
  };
}

/**
 * Ask what to do about rows that moved since they were recorded.
 * Asked per change, at the moment that change is about to be undone.
 */
export async function askAboutDrift(change, drifted) {
  const lines = [];
  const rows = [];
  for (const entry of drifted) {
    const where = Object.entries(entry.row.where || {})
      .map(([col, value]) => `${col}=${value === null ? 'NULL' : value}`).join(', ');
    if (entry.missing || entry.present) {
      lines.push(t('rollback.driftMissing', { table: change.table, where }));
      rows.push([where, '—', '', { text: entry.present ? t('rollback.driftBack') : t('rollback.driftGone'),
        cls: entry.present ? 'now' : 'gone' }]);
    } else if (entry.error) {
      // The row could not be read back at all: say so rather than show no diff.
      lines.push(`${change.table} ${where}: ${entry.error}`);
      rows.push([where, '—', '', { text: entry.error, cls: 'gone' }]);
    } else {
      for (const diff of entry.diffs) {
        lines.push(t('rollback.driftRow', {
          table: change.table, where, col: diff.col,
          actual: diff.actual, expected: diff.expected,
        }));
        rows.push([where, diff.col, { text: showValue(diff.expected), cls: 'was' },
          { text: showValue(diff.actual), cls: 'now' }]);
      }
    }
  }
  const force = await state.panel.preview({
    title: t('rollback.driftTitle'),
    // What Copy puts on the clipboard: the same facts as sentences.
    sql: lines.join('\n'),
    table: {
      heading: `${t('rollback.driftHeading')} · ${change.table}`,
      columns: [t('mgr.row'), t('mgr.column'), t('rollback.driftRecorded'), t('rollback.driftNow')],
      rows,
    },
    summary: [{ total: true, say: t('rollback.driftCount', { n: drifted.length, table: change.table }) }],
    note: t('rollback.driftSkip'),
    // "Cancel" here does not mean nothing happens — it means those rows are left
    // as they are and the rest is still rolled back. A button that hides that
    // behind the word "Cancel" is a button people press for the wrong reason.
    cancelLabel: t('rollback.driftSkipBtn'),
    confirmLabel: t('rollback.driftForce'),
    confirmKind: 'danger',
  });
  return force ? 'force' : 'skip';
}

/** A value as the drift table shows it: NULL as NULL, the empty string visibly empty. */
function showValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value === '') return "''";
  return String(value);
}
