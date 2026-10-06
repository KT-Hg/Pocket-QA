/**
 * snapshot-commands.js — table snapshots and backup tables from the panel:
 * take, restore, drop.
 */

import { keyColsFor } from './capture-sql.js';
import { refresh } from './content-main.js';
import { runSql, selectFull } from './executor.js';
import { t } from './i18n.js';
import { newId, state } from './page-state.js';
import * as store from './session.js';
import { backupCreateSql, backupDropSql, backupName, backupRestoreSql, diffSnapshot, restoreStatements, snapshotSelect } from './snapshot.js';
import { joinStatements } from './sqlquote.js';

/* === Snapshots and backup tables ═════════════════════════════════════════ */

function splitTables(text) {
  return String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** A snapshot failure reason in words, or the database's own message as it came. */
function snapReason(reason) {
  const key = `snap.reason.${reason}`;
  const text = t(key);
  return text === key ? reason : text;
}

export async function promptSnapshot() {
  if (!state.session || state.session.closedAt) return;
  const already = (state.session.snapshots || []).map((s) => s.table);
  const suggestion = state.info.table && !already.includes(state.info.table) ? state.info.table : '';
  const answer = await state.panel.ask({
    title: t('panel.snapshot'),
    label: t('panel.promptTables'),
    value: suggestion,
    placeholder: 'm_generic, m_config',
    confirmLabel: t('panel.snapshot'),
  });
  if (answer === null) return;
  const tables = splitTables(answer);
  if (!tables.length) return;
  state.panel.expand();
  await takeSnapshots(state.session.id, tables);
  await refresh();
}

/** Copy whole tables into the session. Each table succeeds or fails on its own. */
export async function takeSnapshots(sessionId, tables) {
  const taken = [];
  const errors = [];
  for (const table of tables) {
    try {
      const meta = await snapshotTable(sessionId, table);
      taken.push(meta);
      state.panel.log(t('panel.snapTaken', { table, n: meta.rowCount }), 'ok');
    } catch (err) {
      const reason = String(err && err.message || err);
      errors.push({ table, reason });
      state.panel.log(t('panel.snapFailed', { table, reason: snapReason(reason) }), 'err');
    }
  }
  return { taken, errors };
}

async function snapshotTable(sessionId, table) {
  const keyCols = await keyColsFor(table);
  const limit = state.settings.snapshotLimit;
  const res = await selectFull(state.ctx, snapshotSelect(table, state.ctx.engine, '', limit + 1, keyCols || []));
  if (!res.ok) throw new Error(res.errors[0] || 'read-failed');
  if (res.rows.length > limit) throw new Error('too-large');
  const meta = {
    id: newId('sn'),
    table,
    takenAt: new Date().toISOString(),
    keyCols,
    rowCount: res.rows.length,
    columns: res.columns,
    unreadable: res.unreadable,
  };
  await store.addSnapshot(sessionId, meta, { columns: res.columns, rows: res.rows, unreadable: res.unreadable });
  return meta;
}

/** What restoring one snapshot would take, without running it. */
async function planSnapshot(snap) {
  const plan = { snap, statements: [], reason: '', skippedCols: [] };
  const data = await store.getSnapshotData(snap.id);
  if (!data) { plan.reason = 'snapshot-missing'; return plan; }
  const keyCols = snap.keyCols && snap.keyCols.length ? snap.keyCols : await keyColsFor(snap.table);
  const limit = state.settings.snapshotLimit;
  const now = await selectFull(state.ctx, snapshotSelect(snap.table, state.ctx.engine, '', limit + 1, keyCols || []));
  if (!now.ok) { plan.reason = 'read-failed'; plan.error = now.errors[0] || ''; return plan; }
  if (now.rows.length > limit) { plan.reason = 'too-large'; return plan; }
  const diff = diffSnapshot({ keyCols: keyCols || [], ...data }, now);
  plan.reason = diff.reason;
  plan.skippedCols = diff.skippedCols;
  if (!diff.reason) plan.statements = restoreStatements(diff, snap.table, state.ctx.engine);
  return plan;
}

/**
 * Put snapshotted tables back as they were. Tables with nothing to do are
 * marked restored straight away; the others are shown first unless `auto`.
 */
export async function restoreSnapshots(session, { snapIds = null, auto = false, includeRestored = false } = {}) {
  const out = { tables: 0, ok: 0, failed: 0, statements: [], errors: [] };
  if (!session) return out;
  // A snapshot can be restored again: it is a copy of the table, and putting the
  // table back to it a second time is the same operation. `snapIds` names one
  // outright, which is always an explicit request.
  const snaps = (session.snapshots || [])
    .filter((s) => (includeRestored || snapIds || !s.restoredAt) && (!snapIds || snapIds.includes(s.id)));
  if (!snaps.length) return out;

  const plans = [];
  for (const snap of snaps) plans.push(await planSnapshot(snap));
  const notes = [];
  for (const plan of plans) {
    if (plan.reason) notes.push(`${plan.snap.table}: ${snapReason(plan.reason)}`);
    if (plan.skippedCols.length) {
      notes.push(t('snap.skippedCols', { table: plan.snap.table, cols: plan.skippedCols.join(', ') }));
    }
  }
  const work = plans.filter((p) => !p.reason && p.statements.length);
  for (const plan of plans.filter((p) => !p.reason && !p.statements.length)) {
    await store.updateSnapshot(session.id, plan.snap.id, { restoredAt: new Date().toISOString() });
  }
  out.errors = plans.filter((p) => p.reason).map((p) => ({ table: p.snap.table, reason: p.reason }));
  if (!work.length) {
    if (notes.length) state.panel.log(notes.join(' · '), 'warn');
    else state.panel.notice(t('snap.nothing'), 'ok');
    return out;
  }

  const statements = work.flatMap((p) => p.statements);
  const go = auto || await state.panel.preview({
    title: t('snap.title'),
    sql: joinStatements(statements),
    summary: work.map((p) => ({
      table: p.snap.table,
      say: t('snap.planLine', { n: p.statements.length }),
    })),
    note: [t('snap.note'), ...notes].join('\n'),
    confirmLabel: t('snap.confirm', { n: statements.length }),
    confirmKind: 'danger',
  });
  if (!go) {
    out.cancelled = true;
    return out;
  }

  for (const plan of work) {
    out.tables++;
    let result;
    try {
      result = await runSql(state.ctx, joinStatements(plan.statements));
    } catch (err) {
      result = { ok: false, errors: [String(err && err.message || err)] };
    }
    if (result.ok) {
      out.ok++;
      out.statements.push(...plan.statements);
      await store.updateSnapshot(session.id, plan.snap.id, { restoredAt: new Date().toISOString() });
    } else {
      out.failed++;
      out.errors.push({ table: plan.snap.table, reason: result.errors[0] || '' });
      state.panel.log(t('snap.failed', { table: plan.snap.table, reason: result.errors[0] || '' }), 'err');
      break;
    }
  }
  if (out.ok) state.panel.log(t('snap.done', { n: out.ok }), 'ok');
  return out;
}

export async function promptBackup() {
  if (!state.session) return;
  const answer = await state.panel.ask({
    title: t('panel.backup'),
    label: t('panel.promptBackup'),
    value: state.info.table || '',
    note: t('backup.createNote'),
    confirmLabel: t('backup.create'),
  });
  if (answer === null) return;
  state.panel.expand();
  for (const table of splitTables(answer)) await createBackup(state.session, table);
  await refresh();
}

async function createBackup(session, table, { auto = false } = {}) {
  const engine = state.ctx.engine;
  const name = backupName(table, new Date(), engine);
  const sql = backupCreateSql(table, name, engine);
  const go = auto || await state.panel.preview({
    title: t('backup.createTitle'),
    sql,
    note: t('backup.createNote'),
    confirmLabel: t('backup.create'),
  });
  if (!go) return null;
  const result = await runSql(state.ctx, joinStatements([sql]));
  if (!result.ok) {
    state.panel.log(t('panel.backupFailed', { reason: result.errors[0] || '' }), 'err');
    return null;
  }
  const meta = { id: newId('bk'), table, backup: name, createdAt: new Date().toISOString(), engine };
  await store.addBackup(session.id, meta);
  state.panel.log(t('panel.backupDone', { name }), 'ok');
  return meta;
}

/**
 * Restore a table from its backup table. When both fit under the snapshot limit
 * the backup is diffed against the table like a snapshot, so only the rows that
 * moved are written; otherwise it falls back to emptying the table and copying
 * the backup in, and the preview says what that implies.
 */
export async function restoreBackup(session, backupId) {
  const backup = session && (session.backups || []).find((b) => b.id === backupId);
  if (!backup) return { ok: false, error: 'no-backup' };
  const engine = state.ctx.engine;
  const keyCols = await keyColsFor(backup.table);
  const limit = state.settings.snapshotLimit;

  let statements = [];
  let note = '';
  const [saved, now] = keyCols
    ? await Promise.all([
      selectFull(state.ctx, snapshotSelect(backup.backup, engine, '', limit + 1, keyCols)),
      selectFull(state.ctx, snapshotSelect(backup.table, engine, '', limit + 1, keyCols)),
    ])
    : [null, null];
  const comparable = saved && now && saved.ok && now.ok
    && saved.rows.length <= limit && now.rows.length <= limit;
  const diff = comparable
    ? diffSnapshot({ keyCols, columns: saved.columns, rows: saved.rows, unreadable: saved.unreadable }, now)
    : null;
  if (diff && !diff.reason) {
    statements = restoreStatements(diff, backup.table, engine);
    if (diff.skippedCols.length) {
      note = t('snap.skippedCols', { table: backup.table, cols: diff.skippedCols.join(', ') });
    }
  } else {
    statements = backupRestoreSql(backup.table, backup.backup, engine);
    note = t('backup.wholesale');
  }
  if (!statements.length) {
    state.panel.notice(t('snap.nothing'), 'ok');
    await store.updateBackup(session.id, backup.id, { restoredAt: new Date().toISOString() });
    return { ok: true, statements: [] };
  }

  const go = await state.panel.preview({
    title: t('backup.restoreTitle', { table: backup.table, backup: backup.backup }),
    sql: joinStatements(statements),
    note,
    confirmLabel: t('snap.confirm', { n: statements.length }),
    confirmKind: 'danger',
  });
  if (!go) return { ok: false, cancelled: true };
  const result = await runSql(state.ctx, joinStatements(statements));
  if (!result.ok) {
    state.panel.log(t('snap.failed', { table: backup.table, reason: result.errors[0] || '' }), 'err');
    return { ok: false, error: result.errors[0] || '' };
  }
  await store.updateBackup(session.id, backup.id, { restoredAt: new Date().toISOString() });
  state.panel.log(t('backup.restored', { table: backup.table, backup: backup.backup }), 'ok');
  return { ok: true, statements };
}

export async function dropBackup(session, backupId) {
  const backup = session && (session.backups || []).find((b) => b.id === backupId);
  if (!backup) return { ok: false, error: 'no-backup' };
  const sql = backupDropSql(backup.backup, state.ctx.engine);
  const go = await state.panel.preview({
    title: t('backup.dropTitle', { backup: backup.backup }),
    sql,
    note: '',
    confirmLabel: t('mgr.drop'),
    confirmKind: 'danger',
  });
  if (!go) return { ok: false, cancelled: true };
  const result = await runSql(state.ctx, joinStatements([sql]));
  if (!result.ok) return { ok: false, error: result.errors[0] || '' };
  await store.updateBackup(session.id, backup.id, { droppedAt: new Date().toISOString() });
  state.panel.log(t('backup.dropped', { backup: backup.backup }), 'ok');
  return { ok: true };
}

/** Reopen the session a Playback run set aside, if it is still closed. */
export async function resumeSetAside(session) {
  const previous = session.resumeId ? await store.getSession(session.resumeId) : null;
  if (previous && previous.closedAt) await store.reopenSession(previous.id);
  await refresh();
}
