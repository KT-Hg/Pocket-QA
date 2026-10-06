/**
 * content-main.js — the part that runs inside an Adminer tab.
 *
 * It does four things: settle whatever the previous page left behind, put the
 * panel up, watch the page for writes, and run a rollback when asked. This file
 * boots the integration, runs the panel and its session controls; the rest is
 * beside it: capture-record.js (pending changes), capture-edit.js,
 * capture-grid.js, capture-sql.js (the three kinds of page), rollback-commands.js,
 * snapshot-commands.js, playback-guard.js, and the shared page-state.js.
 * They sit in dbtools/ itself, which web_accessible_resources already exposes:
 * the Adminer page imports all of them.
 *
 * ── Why a change is "pending" first ───────────────────────────────────────────
 * Adminer navigates on every save, so the page that makes a change is never the
 * page that finds out whether it worked. A capture is therefore parked in storage
 * on submit and committed by whichever page loads next, once it can see whether
 * Adminer rendered an error. A change that failed is dropped instead of being
 * recorded as something to roll back — a rollback that undoes a write which never
 * happened is worse than no rollback at all.
 *
 * The one save that does not navigate is "Save and continue editing", which
 * Adminer sends over AJAX; wireAjaxSave handles it on the page it came from.
 *
 * ── Why the submit is intercepted ────────────────────────────────────────────
 * Writing to `chrome.storage` is asynchronous, and a navigation cancels it. So
 * the submit is held, the capture is written, and the form is then submitted
 * again through `requestSubmit(submitter)` so Adminer still receives the exact
 * button that was pressed. Every path out of that is wrapped: a failure to
 * capture must never stop somebody's edit from going through, and a watchdog
 * submits anyway if the capture is slow.
 */

import * as adminer from './adapters/adminer.js';
import { wireEditPage } from './capture-edit.js';
import { wireSelectPage } from './capture-grid.js';
import { settlePending } from './capture-record.js';
import { wireSqlPage } from './capture-sql.js';
import { TABLE_COPIES } from './features.js';
import { setLang, t } from './i18n.js';
import { state } from './page-state.js';
import { mountPanel } from './panel.js';
import { connKey, connLabel, parseAdminerUrl } from './params.js';
import { guardBegin, guardEnd } from './playback-guard.js';
import { exportSql, redo, rollback, undoLast } from './rollback-commands.js';
import * as store from './session.js';
import { dropBackup, promptBackup, promptSnapshot, restoreBackup, restoreSnapshots } from './snapshot-commands.js';
import { engineOf } from './sqlquote.js';
import { defaultSessionName } from './summary.js';

/* === Boot ════════════════════════════════════════════════════════════════ */

export async function boot() {
  const found = adminer.detect(document);
  if (!found.ok) return;

  const settings = await store.getSettings();
  setLang(settings.lang);
  state.panel = silentPanel();

  const info = parseAdminerUrl(location.href);
  state.info = info;
  state.settings = settings;
  state.ctx = {
    base: info.base,
    origin: info.origin,
    conn: info.conn,
    key: connKey(info.origin, info.conn),
    engine: settings.engineOverride || engineOf(info.conn.driver),
    adminerVersion: found.version,
  };

  // The switch in the popup (and in the manager's settings) has to take effect on
  // the Adminer tabs that are already open, not only on the next page load — so
  // everything below is arranged to be turned on and off, and the listeners are
  // registered whether it is on or not.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dbtoolsSessions || changes.dbtoolsActive || changes.dbtoolsFocus) refresh();
    if (changes.popupTheme && state.panel.setTheme) state.panel.setTheme(popupTheme(changes.popupTheme.newValue));
    // Settings are read once at boot; without this an Adminer tab left open would
    // keep the old row cap and drift setting until it is reloaded.
    if (changes.dbtoolsSettings) {
      store.getSettings().then((next) => {
        const was = state.settings.enabled;
        state.settings = next;
        setLang(next.lang);
        if (next.enabled && !was) start();
        else if (!next.enabled && was) stop();
        else if (next.enabled) renderPanel();
      });
    }
  });

  if (settings.enabled) await start();

  // Alt+Shift+Z: undo the last change. Adminer's own shortcuts are all Ctrl/⌘ ones
  // and none of them uses Alt, so this one does not collide; it still only opens
  // the preview, and does nothing while the cursor is in a field, where the keys
  // belong to whatever is being typed.
  const undoKey = guarded(undoLast);
  document.addEventListener('keydown', (e) => {
    if (!state.on || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyZ') return;
    const origin = (e.composedPath && e.composedPath()[0]) || e.target;
    if (origin && (origin.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(origin.tagName || ''))) return;
    if (!state.session) return;
    e.preventDefault();
    undoKey();
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = msg && MESSAGES[msg.type];
    if (!handler) return undefined;
    // The manager page and the background cannot do any of this themselves: their
    // fetches would be cross-site and Adminer's session cookie would not be sent.
    // They ask the tab instead — and only a tab on the right database may answer,
    // because every statement runs against whatever this tab is connected to.
    Promise.resolve()
      .then(async () => {
        const key = msg.key || (msg.sessionId ? (await store.getSession(msg.sessionId) || {}).key : '');
        if (key && key !== state.ctx.key) return { ok: false, wrongConn: true };
        // Switched off, this tab runs nothing: a rollback needs the preview, and
        // there is no panel to show it in.
        if (!state.on && msg.type !== 'dbtools-ping') return { ok: false, error: 'integration-off' };
        return handler(msg);
      })
      .then((answer) => sendResponse(answer))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });
}

/**
 * Put the panel up and start watching this page.
 *
 * Safe to call twice: the panel is replaced, but a page is only wired once — the
 * submit hooks would otherwise capture the same edit as many times as the switch
 * has been flipped. A page that loaded while the feature was off is wired here,
 * the first time it is turned on.
 */
/**
 * The popup's theme as the popup itself reads it (popup/theme.js): anything but
 * 'dark' — unset included — is light. Following the OS when unset put a dark
 * panel next to a popup that was showing light.
 */
function popupTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

async function start() {
  state.on = true;
  // The extension's own theme, the one the popup and the manager page use
  // (THEME_KEY in shared/storage-keys.js — not imported, see that file).
  const themed = await new Promise((resolve) => chrome.storage.local.get(['popupTheme'], resolve));
  state.panel = mountPanel({
    onStart: guarded(startSession),
    onStop: guarded(stopSession),
    onView: guarded(openManager),
    onExportSql: guarded(exportSql),
    onRollbackAll: guarded(() => rollback({})),
    onRedoAll: guarded(() => redo({})),
    onUndoLast: guarded(undoLast),
    onPick: guarded(pickSession),
    onResume: guarded(() => state.session && resumeSession(state.session.id)),
    // No handler, no button: the panel leaves out ⋯ when there is nothing behind it.
    ...(TABLE_COPIES ? { onSnapshot: guarded(promptSnapshot), onBackup: guarded(promptBackup) } : {}),
  }, { theme: popupTheme(themed && themed.popupTheme) });

  await refresh();
  await rememberConnection();

  if (state.wired) return;
  state.wired = true;
  await settlePending();
  const { info } = state;
  if (info.page === 'edit') wireEditPage(info);
  if (info.page === 'select') wireSelectPage(info);
  if (info.page === 'sql') wireSqlPage();
}

/**
 * Take the panel down and stop recording.
 *
 * The page's hooks cannot be unhooked — they are closures around forms that are
 * still on screen — so they ask `state.on` before capturing anything, and the
 * panel is replaced by one that swallows what they say instead of throwing.
 */
function stop() {
  state.on = false;
  if (state.panel && state.panel.destroy) state.panel.destroy();
  state.panel = silentPanel();
}

/**
 * A panel button must never fail silently.
 *
 * Every one of them ends in a write to `chrome.storage.local`, and a write that
 * fails — the quota is the one that happens in practice, once a long test run has
 * filled it — rejects a promise nobody was awaiting. The button then looks
 * broken: pressing "End" does nothing at all, with no way to tell why. So the
 * reason is put in the panel's own log, where the person pressing the button is
 * already looking.
 */
let running = false;

function guarded(fn) {
  return async (...args) => {
    // One at a time. The sheet refuses a second preview, but a rollback that is
    // already sending statements has no sheet open, and a second press would
    // start a second run over the same rows.
    if (running) {
      state.panel.notice(t('panel.busy'), 'warn');
      state.panel.expand();
      return;
    }
    running = true;
    try {
      await fn(...args);
    } catch (err) {
      const reason = String((err && err.message) || err);
      state.panel.log(/quota/i.test(reason) ? t('panel.storageFull') : t('panel.actionFailed', { reason }), 'err');
      state.panel.expand();
    } finally {
      running = false;
    }
  };
}

/** Stand-in for the panel while the feature is off. */
function silentPanel() {
  return {
    render() {}, log() {}, notice() {}, progress() {}, expand() {}, destroy() {}, setTheme() {},
    preview: async () => false,   // nothing may run without someone to confirm it
    ask: async () => null,
    pick: async () => null,
  };
}

/** What the manager page and the background may ask an Adminer tab to do. */
const MESSAGES = {
  'dbtools-ping': async () => ({ ok: true, key: state.ctx.key, on: state.on }),
  'dbtools-run-rollback': async (msg) => ({
    ok: true,
    report: await rollback({
      sessionId: msg.sessionId, changeIds: msg.changeIds, includeUndone: msg.includeUndone,
    }),
  }),
  'dbtools-run-redo': async (msg) => ({
    ok: true,
    report: await redo({
      sessionId: msg.sessionId, changeIds: msg.changeIds, includeApplied: msg.includeApplied,
    }),
  }),
  // Whole-table copies and the Playback guard built on them (features.js).
  ...(TABLE_COPIES ? {
    'dbtools-snapshot-restore': async (msg) => {
      const session = await store.getSession(msg.sessionId);
      return { ok: true, report: await restoreSnapshots(session, { snapIds: msg.snapIds }) };
    },
    'dbtools-backup-restore': async (msg) =>
      ({ ok: true, report: await restoreBackup(await store.getSession(msg.sessionId), msg.backupId) }),
    'dbtools-backup-drop': async (msg) =>
      ({ ok: true, report: await dropBackup(await store.getSession(msg.sessionId), msg.backupId) }),
    'dbtools-guard-begin': guardBegin,
    'dbtools-guard-end': guardEnd,
  } : {}),
};

/**
 * Keep a list of the databases this browser has opened in Adminer, for the
 * manager's "protect Playback" setting to choose from. Written once per
 * connection, not on every page load.
 */
async function rememberConnection() {
  const res = await new Promise((resolve) => chrome.storage.local.get(['dbtoolsConns'], resolve));
  const conns = (res && res.dbtoolsConns) || {};
  if (conns[state.ctx.key]) return;
  conns[state.ctx.key] = {
    key: state.ctx.key, origin: state.ctx.origin, base: state.ctx.base,
    conn: state.ctx.conn, label: `${state.ctx.origin} · ${connLabel(state.ctx.conn)}`,
  };
  await new Promise((resolve) => chrome.storage.local.set({ dbtoolsConns: conns }, resolve));
}

/**
 * Re-read which session the panel shows and draw it.
 *
 * That is the recording one if there is one — and otherwise the one last ended
 * or resumed here, not nothing: ending a session used to make it disappear from
 * the panel, and with it the way to roll it back or carry on with it.
 */
export async function refresh() {
  state.session = await store.panelSession(state.ctx.key);
  state.count = (await store.sessionsFor(state.ctx.key)).length;
  renderPanel();

  // Said once per session per page, not on every refresh: the panel refreshes on
  // every write to storage, and an ended session now stays on it.
  const pendingCount = (state.session?.changes || []).filter((c) => !c.undone).length;
  if (state.session && state.session.closedAt && pendingCount && state.warnedUnsaved !== state.session.id) {
    state.warnedUnsaved = state.session.id;
    state.panel.notice(t('panel.unsaved', { name: state.session.name, n: pendingCount }), 'warn');
  }
  return state.session;
}

function renderPanel() {
  state.panel.render({ session: state.session, engine: state.ctx.engine, count: state.count || 0 });
}

/* === Session controls ════════════════════════════════════════════════════ */

async function startSession() {
  const recording = state.session && !state.session.closedAt ? state.session : null;
  const name = await state.panel.ask({
    title: t('panel.startTitle'),
    label: t('panel.promptName'),
    // "Test session · orders · 14:05": the table on screen (or the database) and
    // the time, instead of a locale date string three times as long.
    value: defaultSessionName(t('panel.defaultName'), state.info.table || (state.ctx.conn && state.ctx.conn.db) || ''),
    // Starting one ends the one recording; the question says so before, not after.
    note: recording ? t('panel.pickNote', { name: recording.name }) : '',
    confirmLabel: t('panel.start'),
  });
  if (name === null) return;
  await store.startSession({
    name: name.trim() || t('panel.defaultName'),
    conn: state.ctx.conn,
    origin: state.ctx.origin,
    base: state.ctx.base,
    key: state.ctx.key,
  });
  await refresh();
  state.panel.expand();
}

async function stopSession() {
  if (!state.session) return;
  const { name } = state.session;
  await store.closeSession(state.session.id);
  // The session does not go anywhere, and the first End after this change is the
  // moment to say so — otherwise it reads as "End did nothing".
  state.warnedUnsaved = state.session.id;
  await refresh();
  state.panel.notice(t('panel.endedLog', { name }), 'ok');
}

/**
 * Carry on recording into a session that was ended — the one on the panel, or
 * one picked from the list. Whichever was recording is ended first: one
 * recording session per database.
 */
async function resumeSession(id) {
  const target = await store.getSession(id);
  if (!target) return;
  const was = state.session && !state.session.closedAt && state.session.id !== id ? state.session : null;
  await store.reopenSession(id);
  await refresh();
  if (was) state.panel.notice(t('panel.endedPrev', { name: was.name }), 'warn');
  state.panel.notice(t('panel.resumed', { name: target.name }), 'ok');
  state.panel.expand();
}

/** The sessions on this database, one press away from the name on the panel. */
async function pickSession() {
  const list = await store.sessionsFor(state.ctx.key);
  const recordingId = await store.activeSessionId(state.ctx.key);
  const recording = list.find((s) => s.id === recordingId && !s.closedAt) || null;
  const answer = await state.panel.pick({
    items: list.map((s) => ({
      id: s.id,
      name: s.name,
      meta: sessionLine(s),
      recording: Boolean(recording && s.id === recording.id),
      shown: Boolean(state.session && s.id === state.session.id),
    })),
    note: recording ? t('panel.pickNote', { name: recording.name }) : '',
  });
  if (!answer) return;
  if (answer.action === 'new') await startSession();
  else if (answer.action === 'manage') openManager();
  else if (answer.action === 'resume') await resumeSession(answer.id);
}

/** "3 change(s) · 1 table(s) · 22 Sep, 09:14" — enough to tell two runs of one test apart. */
function sessionLine(session) {
  const changes = session.changes || [];
  const tables = new Set(changes.map((c) => c.table)).size;
  let when = '';
  try {
    when = new Date(session.startedAt).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { when = String(session.startedAt || ''); }
  return `${t('panel.changes', { n: changes.length })} · ${t('panel.tables', { n: tables })} · ${when}`
    + (session.guard ? ` · ${t('mgr.playback')}` : '');
}

function openManager() {
  chrome.runtime.sendMessage({ type: 'dbtools-open-manager', sessionId: state.session?.id || '' });
}
