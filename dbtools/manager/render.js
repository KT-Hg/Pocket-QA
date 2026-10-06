/**
 * manager/render.js — drawing the manager page: the session rail, the session's
 * changes with their before / after rows, snapshots and backup tables.
 */

import { TABLE_COPIES } from '../features.js';
import { t } from '../i18n.js';
import { reload, select } from '../manager.js';
import { connLabel } from '../params.js';
import * as store from '../session.js';
import { backupRestoreSql } from '../snapshot.js';
import { engineOf, joinStatements } from '../sqlquote.js';
import { rowKeyLabel } from '../summary.js';
import { blockingReason, columnsToRestore, redoBlockingReason } from '../undo.js';
import { askTab, redoOne, rollbackOne } from './actions.js';
import { toast } from './dialogs.js';
import { managerState, ui } from './state.js';

/* === Rendering ═══════════════════════════════════════════════════════════ */

export function render() {
  renderRail();
  const session = managerState.sessions[managerState.currentId];

  ui.detailHead.hidden = !session;
  ui.changeHead.hidden = !session;
  renderExtras(session);
  if (!session) {
    // "Pick a session on the left" is only useful when there is one. With none,
    // this page is the first thing somebody opens from the popup, and what it
    // owes them is the four steps — none of which happen on this page.
    ui.changeList.replaceChildren(Object.keys(managerState.sessions).length ? para(t('mgr.noPreview')) : emptyHelp());
    return;
  }

  ui.sessName.textContent = session.name;
  ui.sessState.textContent = (session.closedAt ? t('mgr.closed') : t('mgr.open'))
    + (session.guard ? ` · ${t('mgr.playback')}` : '');
  ui.sessState.className = `pill${session.closedAt ? '' : ' open'}`;
  // The whole changeset, undone or not — it can be rolled back again.
  ui.sessMeta.textContent =
    `${connLabel(session.conn)} · ${new Date(session.startedAt).toLocaleString()} · `
    + `${t('panel.changes', { n: session.changes.length })}`;
  ui.btnToggleOpen.textContent = session.closedAt ? t('mgr.reopen') : t('mgr.close');
  ui.changeCount.textContent = t('mgr.pendingOf', {
    n: session.changes.filter((c) => !c.undone).length, total: session.changes.length,
  });
  paintRunButtons();

  const list = [...session.changes].sort((a, b) => b.seq - a.seq);
  ui.changeList.replaceChildren(...(list.length ? list.map(renderChange) : [para(t('mgr.empty'))]));
}

/**
 * Say what the buttons are about to do, not what they are called.
 *
 * With nothing ticked, rollback rolls the whole session back — it was still
 * labelled "Roll back selected", which reads as "nothing is selected, so this is
 * safe". It is the opposite: that is the widest thing this page can do.
 *
 * Re-apply counts the changes that were rolled back, because those are the ones
 * it would run; only when none were does it offer the whole session, which is
 * then a request to write the recorded values over what is there now.
 */
function paintRunButtons() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  const ticked = session.changes.filter((c) => managerState.selected.has(c.id));
  ui.btnRollback.textContent = ticked.length
    ? t(ticked.some((c) => c.undone) ? 'mgr.rollbackAgainN' : 'mgr.rollbackN', { n: ticked.length })
    : t('mgr.rollbackAllN', { n: session.changes.length });
  // A session can be rolled back more than once, so the button stays available
  // while it holds anything at all.
  ui.btnRollback.disabled = !session.changes.length && !(TABLE_COPIES && (session.snapshots || []).length);

  const rolledBack = session.changes.filter((c) => c.undone).length;
  ui.btnRedo.textContent = ticked.length
    ? t('mgr.redoN', { n: ticked.length })
    : t('mgr.redoAllN', { n: rolledBack || session.changes.length });
  ui.btnRedo.disabled = !session.changes.length;

  ui.chkAll.checked = Boolean(session.changes.length) && ticked.length === session.changes.length;
}

export function renderRail() {
  const all = Object.values(managerState.sessions)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (!all.length) {
    ui.railFilter.hidden = true;
    ui.sessionList.replaceChildren(para(t('mgr.empty')));
    return;
  }
  // A filter once there are enough sessions to lose one in; below that it is a box
  // in the way. Name or database, since two runs of one test share a name.
  ui.railFilter.hidden = all.length < 6;
  const q = ui.railFilter.hidden ? '' : ui.railFilter.value.trim().toLowerCase();
  const entries = q
    ? all.filter((s) => `${s.name} ${connLabel(s.conn)}`.toLowerCase().includes(q))
    : all;
  if (!entries.length) {
    ui.sessionList.replaceChildren(para(t('panel.pickNone')));
    return;
  }
  ui.sessionList.replaceChildren(...entries.map((session) => {
    const button = document.createElement('button');
    button.className = `sess${session.id === managerState.currentId ? ' active' : ''}`;
    button.innerHTML = '<span class="t"></span><span class="s"></span>';
    const title = button.querySelector('.t');
    title.textContent = session.name;
    // The one recording is the one somebody is usually looking for; "Closed" on
    // every other row said the same thing thirty times and marked nothing.
    if (!session.closedAt) {
      const rec = document.createElement('span');
      rec.className = 'rec';
      rec.textContent = t('mgr.recording');
      title.append(rec);
    }
    // Opened by a Playback run rather than by hand — usually rolled back already,
    // and not what someone scanning for their own test is looking for.
    if (session.guard) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t('mgr.playback');
      title.append(tag);
    }
    button.querySelector('.s').textContent =
      `${connLabel(session.conn)} · ${t('panel.changes', { n: session.changes.length })} · ${shortDate(session.startedAt)}`;
    button.addEventListener('click', () => select(session.id));
    return button;
  }));
}

function shortDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso || '');
  }
}

/**
 * Snapshots and backup tables of the selected session. Both are acted on by an
 * Adminer tab, like the rollback — this page only shows them and asks.
 */
function renderExtras(session) {
  const snaps = (session && session.snapshots) || [];
  const backups = (session && session.backups) || [];
  ui.extras.hidden = !TABLE_COPIES || !session || (!snaps.length && !backups.length);
  if (ui.extras.hidden) {
    ui.extras.replaceChildren();
    return;
  }
  const blocks = [];
  if (snaps.length) {
    blocks.push(extraBlock(t('mgr.snapshots'), snaps.map((snap) => extraRow(
      snap.table,
      `${t('mgr.rows', { n: snap.rowCount })} · ${new Date(snap.takenAt).toLocaleString()}`
        + (snap.restoredAt ? ` · ${t('mgr.restored')}` : ''),
      [
        smallButton(t('mgr.restore'), () => askTab(session,
          { type: 'dbtools-snapshot-restore', sessionId: session.id, snapIds: [snap.id] })),
        smallButton(t('mgr.remove'), async () => {
          await store.removeSnapshot(session.id, snap.id);
          await reload();
          render();
        }),
      ],
    ))));
  }
  if (backups.length) {
    const engine = engineOf(session.conn && session.conn.driver);
    blocks.push(extraBlock(t('mgr.backups'), backups.map((bk) => extraRow(
      `${bk.table} → ${bk.backup}`,
      new Date(bk.createdAt).toLocaleString()
        + (bk.restoredAt ? ` · ${t('mgr.restored')}` : '')
        + (bk.droppedAt ? ` · ${t('mgr.dropped')}` : ''),
      bk.droppedAt ? [] : [
        smallButton(t('mgr.restore'), () => askTab(session,
          { type: 'dbtools-backup-restore', sessionId: session.id, backupId: bk.id })),
        smallButton(t('mgr.copySql'), async () => {
          const sql = joinStatements(backupRestoreSql(bk.table, bk.backup, bk.engine || engine));
          try {
            await navigator.clipboard.writeText(sql);
            toast(t('rollback.copied'));
          } catch {
            toast(sql);
          }
        }),
        smallButton(t('mgr.drop'), () => askTab(session,
          { type: 'dbtools-backup-drop', sessionId: session.id, backupId: bk.id }), 'danger-outline'),
      ],
    ))));
  }
  ui.extras.replaceChildren(...blocks);
}

function extraBlock(title, rows) {
  const box = document.createElement('section');
  box.className = 'extra';
  const h = document.createElement('h3');
  h.textContent = title;
  box.append(h, ...rows);
  return box;
}

function extraRow(name, meta, actions) {
  const row = document.createElement('div');
  row.className = 'extra-row';
  const n = document.createElement('span');
  n.className = 'tbl';
  n.textContent = name;
  const m = document.createElement('span');
  m.className = 'meta grow';
  m.textContent = meta;
  row.append(n, m, ...actions.filter(Boolean));
  return row;
}

function smallButton(label, onClick, cls = '') {
  return makeButton(label, onClick, `small ${cls}`.trim());
}

export function makeButton(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderChange(change) {
  const details = document.createElement('details');
  details.className = `change${change.undone ? ' undone' : ''}`;
  details.dataset.id = change.id;
  details.open = managerState.openIds.has(change.id);
  details.addEventListener('toggle', () => {
    if (details.open) managerState.openIds.add(change.id); else managerState.openIds.delete(change.id);
  });

  const summary = document.createElement('summary');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = managerState.selected.has(change.id);
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked) managerState.selected.add(change.id); else managerState.selected.delete(change.id);
    // Only the buttons: a full re-render here would shut every diff the person has
    // opened to decide what to tick.
    paintRunButtons();
  });

  const op = document.createElement('span');
  op.className = `op ${change.op}`;
  op.textContent = t(`op.${change.op}`);

  const table = document.createElement('span');
  table.className = 'tbl';
  table.textContent = change.table || '?';

  // Which row, before how many: two UPDATEs of one table were told apart only
  // by their time until one was opened.
  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = rowKeyLabel(change);

  const meta = document.createElement('span');
  meta.className = 'meta grow';
  const rows = (change.rows || []).length;
  meta.textContent = `${t('mgr.rows', { n: rows })} · ${new Date(change.at).toLocaleTimeString()}` +
    (change.verified === false ? ` · ${t('mgr.unverified')}` : '') +
    (change.undone ? ` · ${t('mgr.undone')}` : '');

  summary.append(box, op, table);
  if (key.textContent) summary.append(key);
  summary.append(meta);

  const reason = blockingReason(change);
  if (reason) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = `⚠ ${t(`reason.${reason}`)}`;
    summary.append(warn);
  }

  // Undo just this one, without ticking it and reaching for the button at the
  // top. A change that cannot be undone gets no button to press for nothing.
  if (!reason) {
    const undo = document.createElement('button');
    undo.className = 'btn small undo-one';
    undo.textContent = change.undone ? t('mgr.againOne') : t('mgr.undoOne');
    undo.title = change.undone ? t('mgr.againOneHint') : t('mgr.undoOneHint');
    undo.addEventListener('click', (e) => {
      // Inside a <summary>: without this the click also opens or shuts the diff.
      e.preventDefault();
      e.stopPropagation();
      rollbackOne(change);
    });
    summary.append(undo);
  }

  // And put this one back the way the test had it — offered once it has been
  // rolled back, which is the only time there is anything to re-apply.
  if (change.undone && !redoBlockingReason(change)) {
    const again = document.createElement('button');
    again.className = 'btn small redo-one';
    again.textContent = t('mgr.redoOne');
    again.title = t('mgr.redoOneHint');
    again.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      redoOne(change);
    });
    summary.append(again);
  }
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'change-body';
  if (change.statement) {
    const pre = document.createElement('pre');
    pre.className = 'sql';
    pre.textContent = change.statement;
    body.append(pre);
  }
  for (const row of change.rows || []) body.append(renderRow(change, row));
  if ((change.warnings || []).length) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = `${t('mgr.warnings')}: ${change.warnings.join(', ')}`;
    body.append(warn);
  }
  details.append(body);
  return details;
}

function renderRow(change, row) {
  const table = document.createElement('table');
  table.className = 'diff';
  const head = document.createElement('tr');
  for (const label of [t('mgr.column'), t('mgr.before'), t('mgr.after')]) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  table.append(head);

  const caption = document.createElement('caption');
  caption.className = 'meta';
  caption.style.textAlign = 'left';
  caption.textContent = Object.entries(row.where || {})
    .map(([col, value]) => `${col}=${value === null ? 'NULL' : value}`).join(', ') || '—';
  table.prepend(caption);

  let cols;
  if (change.op === 'delete') cols = Object.keys(row.before || {});
  else if (change.op === 'insert') cols = Object.keys(row.after || {});
  else cols = columnsToRestore(change, row);

  for (const col of cols) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = col;
    tr.append(name, cell(row.before && row.before[col], 'before'), cell(row.after && row.after[col], 'after'));
    table.append(tr);
  }
  return table;
}

function cell(value, cls) {
  const td = document.createElement('td');
  td.className = `val ${cls}`;
  if (value === null || value === undefined) {
    const i = document.createElement('span');
    i.className = 'null';
    i.textContent = 'NULL';
    td.append(i);
  } else {
    td.textContent = value;
  }
  return td;
}

function para(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

/** How to get a first session, for a page that has none. */
function emptyHelp() {
  const box = document.createElement('div');
  box.className = 'howto';
  const h = document.createElement('h3');
  h.textContent = t('mgr.emptyTitle');
  const steps = document.createElement('ol');
  for (const key of ['mgr.emptyStep1', 'mgr.emptyStep2', 'mgr.emptyStep3', 'mgr.emptyStep4']) {
    const li = document.createElement('li');
    li.textContent = t(key);
    steps.append(li);
  }
  box.append(h, steps);
  return box;
}
