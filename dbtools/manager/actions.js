/**
 * manager/actions.js — what the manager's buttons do: ask an Adminer tab to roll
 * back or re-apply, export, rename, end / reopen, delete, clean up, settings.
 */

import { compactUndoScript } from '../compact.js';
import { TABLE_COPIES } from '../features.js';
import { t } from '../i18n.js';
import { newestId, reload, select } from '../manager.js';
import { buildUrl, connLabel } from '../params.js';
import * as store from '../session.js';
import { engineOf, joinStatements } from '../sqlquote.js';
import { cleanupCandidates } from '../summary.js';
import { sessionUndoScript } from '../undo.js';
import { askDialog, confirmDialog, openDialog, showReport, toast } from './dialogs.js';

// After turning the integration on: the Adminer tab switches itself on from storage.
const TURN_ON_SETTLE_MS = 400;
// A freshly opened Adminer tab (through its login, if any) is waited for this long,
// asked this often.
const ADMINER_READY_TIMEOUT_MS = 60_000;
const PANEL_POLL_MS = 700;
// An export's object URL is revoked this long after the click.
const REVOKE_DELAY_MS = 1000;
import { makeButton, render } from './render.js';
import { el, managerState, ui } from './state.js';

/* === Actions ═════════════════════════════════════════════════════════════ */

/**
 * Hand work to an Adminer tab on the session's origin — the one connected to the
 * session's database; a tab on another database of the same host answers
 * `wrongConn` and is passed over. Without one there is nothing that can run it,
 * and saying so beats a request that quietly comes back as the login page.
 *
 * The tab is brought to the front first: it shows the preview, and a preview in
 * a tab nobody is looking at would simply wait.
 */
export async function askTab(session, message) {
  if (!managerState.settings.autoExecute) {
    showReport(t('mgr.autoExecuteOff'), 'err', { label: t('mgr.exportSql'), onClick: exportSql });
    return null;
  }
  const tabs = await chrome.tabs.query({ url: `${session.origin}/*` });
  if (!tabs.length) {
    showReport(t('mgr.needTab', { origin: session.origin }), 'err', openAdminerAction(session, message));
    return null;
  }
  let wrong = false;
  let off = false;
  try {
    for (const tab of tabs) {
      const ping = await chrome.tabs.sendMessage(tab.id, { type: 'dbtools-ping', key: session.key }, { frameId: 0 })
        .catch(() => null);
      if (!ping) continue;
      if (ping.wrongConn) {
        wrong = true;
        continue;
      }
      // Switched off, the tab has no panel to show the preview in and will refuse.
      if (ping.on === false) {
        off = true;
        continue;
      }
      // The preview opens over there, and this page goes to the background
      // mid-click. Saying so first means the tab switch is an answer to the
      // button, not something that just happened.
      showReport(t('mgr.handedOff'), '');
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      const answer = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
      reportAnswer(answer);
      return answer;
    }
    // Every way this can fail comes with the one thing that fixes it, rather
    // than a sentence telling someone to go and do it elsewhere.
    if (off) {
      showReport(t('mgr.integrationOff'), 'err', {
        label: t('mgr.turnOn'),
        onClick: async () => {
          managerState.settings = await store.setSettings({ enabled: true });
          await new Promise((r) => setTimeout(r, TURN_ON_SETTLE_MS));   // the tab switches itself on from storage
          await askTab(session, message);
        },
      });
    } else {
      showReport(t(wrong ? 'mgr.wrongConn' : 'mgr.needTab', { origin: session.origin }), 'err',
        openAdminerAction(session, message));
    }
    return null;
  } catch (err) {
    showReport(String(err && err.message || err), 'err');
    return null;
  } finally {
    await reload();
    render();
  }
}

/**
 * "Open Adminer": a tab on the session's own database, then — once its panel
 * answers — the same request again, so the rollback that was asked for carries
 * on instead of having to be asked for twice. It still stops at the preview.
 */
function openAdminerAction(session, message) {
  if (!session.base) return null;
  return {
    label: t('mgr.openAdminer'),
    onClick: async () => {
      const tab = await chrome.tabs.create({ url: buildUrl(session.base, session.conn || {}, {}), active: true });
      showReport(t('mgr.waitingAdminer'), '');
      if (await waitForPanel(tab.id, session.key, ADMINER_READY_TIMEOUT_MS)) await askTab(session, message);
      else showReport(t('mgr.adminerNotReady'), 'err', openAdminerAction(session, message));
    },
  };
}

/** Wait for an Adminer tab's panel to answer for this database — through a login, if it asks for one. */
async function waitForPanel(tabId, key, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'dbtools-ping', key }, { frameId: 0 })
      .catch(() => null);
    if (ping && ping.ok && ping.on !== false) return true;
    if (!(await chrome.tabs.get(tabId).catch(() => null))) return false;   // closed
    await new Promise((r) => setTimeout(r, PANEL_POLL_MS));
  }
  return false;
}

/** Say how it went, whichever kind of report came back. */
function reportAnswer(answer) {
  if (!answer || !answer.ok) {
    showReport(String((answer && answer.error) || 'failed'), 'err');
    return;
  }
  const r = answer.report || {};
  // Walking away from the preview is an answer; leaving "continue in the Adminer
  // tab" on screen would read as still waiting for one.
  if (r.cancelled) {
    showReport(t('mgr.cancelled'), '');
    return;
  }
  if (r.nothing) {
    showReport(t('rollback.nothing'), '');
    return;
  }
  // A backup restore or drop answers with a plain ok flag.
  if (typeof r.ok === 'boolean') {
    showReport(r.ok ? t('rollback.done', { ok: 1, fail: 0 }) : String(r.error || 'failed'), r.ok ? 'ok' : 'err');
    return;
  }
  // A rollback carries its snapshot restore inside; a snapshot restore is one.
  const snaps = 'tables' in r ? r : (r.snapshots || { ok: 0, failed: 0 });
  const main = 'tables' in r ? { ok: 0, failed: 0 } : r;
  const ok = (main.ok || 0) + (snaps.ok || 0);
  const fail = (main.failed || 0) + (snaps.failed || 0);
  // Changes it could not undo are the half of the outcome that used to go
  // unmentioned: "2 succeeded, 0 failed" reads as done, with three rows still
  // sitting there as the test left them.
  const skipped = main.skipped || 0;
  let kind;
  if (fail) kind = 'err';
  else if (skipped) kind = 'warn';
  else kind = 'ok';
  showReport(
    t('rollback.done', { ok, fail }) + (skipped ? ` ${t('rollback.skippedDone', { n: skipped })}` : ''),
    kind,
  );
}

export async function rollbackOne(change) {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  await askTab(session, {
    type: 'dbtools-run-rollback',
    sessionId: session.id,
    changeIds: [change.id],
    includeUndone: Boolean(change.undone),
  });
}

export async function rollbackSelected() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  ui.btnRollback.disabled = true;
  const ticked = session.changes.filter((c) => managerState.selected.has(c.id));
  await askTab(session, {
    type: 'dbtools-run-rollback',
    sessionId: session.id,
    // Nothing ticked means everything: the change log and the snapshots.
    changeIds: managerState.selected.size ? [...managerState.selected] : undefined,
    // Ticking a change that was already undone is a request to run it again.
    includeUndone: ticked.some((c) => c.undone),
  });
  managerState.selected = new Set();
  render();
}

export async function redoOne(change) {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  await askTab(session, {
    type: 'dbtools-run-redo',
    sessionId: session.id,
    changeIds: [change.id],
    includeApplied: !change.undone,
  });
}

export async function redoSelected() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  ui.btnRedo.disabled = true;
  const ticked = session.changes.filter((c) => managerState.selected.has(c.id));
  await askTab(session, {
    type: 'dbtools-run-redo',
    sessionId: session.id,
    // Nothing ticked means every change that was rolled back.
    changeIds: managerState.selected.size ? [...managerState.selected] : undefined,
    // Ticking a change that is still applied is a request to write its values again.
    includeApplied: ticked.some((c) => !c.undone),
  });
  managerState.selected = new Set();
  render();
}

export function exportSql() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  // Folded per row when that is how rollbacks are run (the preview's last choice,
  // or the setting): the file is then the same statements the preview shows.
  const statements = managerState.settings.compactRun ? compactUndoScript(session) : sessionUndoScript(session, {});
  if (!statements.length) return toast(t('rollback.nothing'));
  const header = `-- ${session.name}\n-- ${connLabel(session.conn)}\n-- ${new Date().toISOString()}\n\n`;
  download(`${slug(session.name)}-undo.sql`, header + joinStatements(statements), 'text/plain');
}

export function exportJson() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  const engine = engineOf(session.conn && session.conn.driver);
  download(`${slug(session.name)}-changeset.json`, JSON.stringify({ engine, ...session }, null, 2), 'application/json');
}

export async function rename() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  const name = await askDialog({
    title: t('mgr.rename'), label: t('mgr.sessionName'), value: session.name, confirmLabel: t('mgr.rename'),
  });
  if (name === null) return;
  await store.renameSession(session.id, name.trim() || session.name);
  await reload();
  render();
}

export async function toggleOpen() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  // Resuming ends whichever session was recording on that database — one at a
  // time — and the panel in its Adminer tab follows without a reload.
  if (session.closedAt) {
    await store.reopenSession(session.id);
    showReport(t('panel.resumed', { name: session.name }), 'ok');
  } else {
    await store.closeSession(session.id);
  }
  await reload();
  render();
}

export async function removeSession() {
  const session = managerState.sessions[managerState.currentId];
  if (!session) return;
  const ok = await confirmDialog({
    title: t('mgr.delete'),
    text: `${session.name}\n${t('panel.changes', { n: session.changes.length })}`,
    confirmLabel: t('mgr.delete'),
  });
  if (!ok) return;
  await store.deleteSession(session.id);
  await reload();
  select(Object.keys(managerState.sessions)[0] || '');
}

/**
 * Delete ended sessions in one go.
 *
 * By default only the ones with nothing left to undo; the ones that still hold
 * changes are one tick away, and counted, so nobody deletes a session they
 * still needed by accident. Sessions that still own a backup table in the
 * database are never offered: this record is the only way back to it.
 */
export async function cleanup() {
  const groups = cleanupCandidates(managerState.sessions);
  if (!groups.spent.length && !groups.pending.length) {
    toast(t('mgr.cleanupNone'));
    return;
  }
  const body = document.createElement('div');
  body.className = 'cleanup';
  const line = document.createElement('p');
  line.className = 'meta';
  line.textContent = t('mgr.cleanupSpent', { n: groups.spent.length });
  body.append(line);

  let includePending = null;
  if (groups.pending.length) {
    const label = document.createElement('label');
    label.className = 'check';
    includePending = document.createElement('input');
    includePending.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = t('mgr.cleanupPending', { n: groups.pending.length });
    label.append(includePending, text);
    body.append(label);
  }
  if (groups.keptForBackups.length) {
    const kept = document.createElement('p');
    kept.className = 'meta';
    kept.textContent = t('mgr.cleanupKept', { n: groups.keptForBackups.length });
    body.append(kept);
  }

  const count = () => groups.spent.length + (includePending && includePending.checked ? groups.pending.length : 0);
  const ok = await new Promise((resolve) => {
    let go = null;
    const paint = () => {
      go.textContent = t('mgr.cleanupGo', { n: count() });
      go.disabled = !count();
    };
    openDialog({
      title: t('mgr.cleanupTitle'),
      body,
      answer: (value) => resolve(value === true),
      buttons: (close) => {
        go = makeButton('', () => close(true), 'danger');
        return [makeButton(t('rollback.cancel'), () => close(false)), go];
      },
    });
    if (includePending) includePending.addEventListener('change', paint);
    paint();
  });
  if (!ok) return;

  const doomed = cleanupCandidates(managerState.sessions, {
    includePending: Boolean(includePending && includePending.checked),
  }).chosen;
  for (const session of doomed) await store.deleteSession(session.id);
  await reload();
  if (!managerState.sessions[managerState.currentId]) select(newestId()); else render();
  toast(t('mgr.cleanupDone', { n: doomed.length }));
}

export async function openSettings() {
  el('setEnabled').checked = managerState.settings.enabled;
  el('setAutoExecute').checked = managerState.settings.autoExecute;
  el('setDrift').checked = managerState.settings.driftCheck;
  el('setCompact').checked = Boolean(managerState.settings.compactRun);
  el('setSqlPage').checked = managerState.settings.captureSqlPage;
  el('setLimit').value = managerState.settings.prefetchLimit;
  el('setSnapLimit').value = managerState.settings.snapshotLimit;
  // Held back (features.js): the fields stay in the form, so saving keeps the
  // stored values, but they are not offered.
  el('setSnapLimit').closest('label').hidden = !TABLE_COPIES;
  document.querySelector('fieldset.guard').hidden = !TABLE_COPIES;
  el('setKeyLimit').value = managerState.settings.keyScanLimit;
  el('setEngine').value = managerState.settings.engineOverride;

  // How much of chrome.storage.local the changesets take up, next to its cap.
  // Worth seeing: when this storage fills, every write fails — recording, ending
  // a session, everything — and the panel's buttons stop having any effect.
  // Snapshot rows are not counted: they live in IndexedDB (snapstore.js).
  el('storageUsed').textContent = '';
  if (chrome.storage.local.getBytesInUse) {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      void chrome.runtime.lastError;
      const quota = chrome.storage.local.QUOTA_BYTES || 5242880;
      el('storageUsed').textContent = t('mgr.storageUsed', {
        mb: (bytes / 1048576).toFixed(2),
        max: Math.round(quota / 1048576),
      });
    });
  }

  // The databases this browser has opened in Adminer: the guard works through a
  // tab on one of them, so it can only be pointed at one of them.
  const guard = { ...store.DEFAULT_SETTINGS.guard, ...(managerState.settings.guard || {}) };
  const res = await chrome.storage.local.get('dbtoolsConns');
  const conns = Object.values(res.dbtoolsConns || {});
  const pick = el('setGuardConn');
  pick.replaceChildren();
  if (!conns.length) pick.append(new Option(t('mgr.guardConnNone'), ''));
  for (const conn of conns) pick.append(new Option(conn.label, conn.key, false, conn.key === guard.key));
  el('setGuard').checked = guard.enabled;
  el('setGuardTables').value = (guard.tables || []).join(', ');
  el('setGuardAuto').checked = guard.autoRollback !== false;

  // Saved from the button, not from the dialog's `close` event: Chrome does not
  // fire that event for every way a dialog goes away, and settings that quietly
  // did not save are worse than none. `once` keeps Escape from saving twice.
  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const chosen = conns.find((c) => c.key === pick.value) || null;
    managerState.settings = await store.setSettings({
      enabled: el('setEnabled').checked,
      autoExecute: el('setAutoExecute').checked,
      driftCheck: el('setDrift').checked,
      compactRun: el('setCompact').checked,
      captureSqlPage: el('setSqlPage').checked,
      prefetchLimit: Math.max(1, Number(el('setLimit').value) || 200),
      snapshotLimit: Math.max(1, Number(el('setSnapLimit').value) || 5000),
      keyScanLimit: Math.max(1, Number(el('setKeyLimit').value) || 10000),
      engineOverride: el('setEngine').value,
      guard: {
        enabled: el('setGuard').checked && Boolean(chosen),
        key: chosen ? chosen.key : '',
        origin: chosen ? chosen.origin : '',
        label: chosen ? chosen.label : '',
        tables: el('setGuardTables').value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean),
        autoRollback: el('setGuardAuto').checked,
      },
    });
  };

  el('setOk').addEventListener('click', save, { once: true });
  ui.settingsDlg.addEventListener('close', save, { once: true });
  ui.settingsDlg.addEventListener('cancel', save, { once: true });
  ui.settingsDlg.showModal();
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
