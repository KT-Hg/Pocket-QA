/**
 * panel.js — the floating panel inside Adminer.
 *
 * Everything lives in a shadow root with its own reset. Adminer is usually
 * running behind somebody's theme or plugin, and this panel has to look the same
 * and keep working whichever one it is — an injected `div` inheriting a theme's
 * `table { width: 100% }` is exactly how injected UI ends up unreadable.
 *
 * The panel is deliberately small. It says whether a session is recording, how
 * much is in it, and offers the three things wanted mid-test: start/stop, the
 * preview, and roll back everything. Anything that needs reading — per-row diffs,
 * partial selection, settings — belongs on the manager page, which has room for it.
 *
 * The preview is not optional. Rollback statements are always rendered and shown
 * before anything is sent, because a rollback the user cannot read first is one
 * they cannot trust.
 */

import { t } from './i18n.js';
import { TABLE_COPIES } from './features.js';
import { STYLE } from './panel-styles.js';

const HOST_ID = 'frp-dbtools-panel';
// How long a notice stays before it fades: long enough to read twice.
const NOTICE_MS = 8000;
// A notice under the pointer is looked at again after this long.
const HOVER_RECHECK_MS = 1500;
// Just past the .notice opacity transition (0.6 s, panel-styles.js) before removal.
const FADE_OUT_MS = 650;

export function mountPanel(handlers = {}, { theme = '' } = {}) {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  setTheme(theme);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap collapsed';
  wrap.innerHTML = `
    <div class="head" role="button" tabindex="0" aria-expanded="false">
      <span class="dot" aria-hidden="true"></span><span class="title"></span>
      <span class="ended" hidden></span><span class="badge" hidden></span>
      <button class="dock" type="button"></button><span class="chev" aria-hidden="true">▲</span>
    </div>
    <div class="body">
      <div class="name"></div>
      <div class="meta"></div>
      <div class="row buttons"></div>
      <div class="row advanced" hidden></div>
      <div class="log" role="log" aria-live="polite"></div>
    </div>`;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', t('panel.title'));
  shadow.append(wrap);
  (document.body || document.documentElement).append(host);

  const els = {
    wrap,
    dot: wrap.querySelector('.dot'),
    title: wrap.querySelector('.title'),
    name: wrap.querySelector('.name'),
    meta: wrap.querySelector('.meta'),
    buttons: wrap.querySelector('.buttons'),
    advanced: wrap.querySelector('.advanced'),
    log: wrap.querySelector('.log'),
    chev: wrap.querySelector('.chev'),
    badge: wrap.querySelector('.badge'),
    ended: wrap.querySelector('.head .ended'),
    dock: wrap.querySelector('.head .dock'),
    head: wrap.querySelector('.head'),
  };

  // Snapshotting a whole table and creating a backup table are occasional,
  // heavier decisions than the four buttons above them, so they sit behind "⋯"
  // rather than in the row someone reaches for mid-test. The choice sticks, per
  // site, like the collapsed state does.
  let advancedOpen = false;
  try { advancedOpen = localStorage.getItem('frpDbtoolsAdvanced') === '1'; } catch { /* private mode */ }

  function setCollapsed(collapsed, remember = true) {
    wrap.classList.toggle('collapsed', collapsed);
    els.chev.textContent = collapsed ? '▲' : '▼';
    els.head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!collapsed) clearBadge();
    if (remember) {
      try { localStorage.setItem('frpDbtoolsCollapsed', collapsed ? '1' : '0'); } catch { /* private mode */ }
    }
  }

  // The header is the panel's one control while it is shut, so it answers the
  // keyboard as well as the mouse.
  els.head.addEventListener('click', () => setCollapsed(!wrap.classList.contains('collapsed')));
  els.head.addEventListener('keydown', (e) => {
    if (e.target !== els.head || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    setCollapsed(!wrap.classList.contains('collapsed'));
  });
  try {
    if (localStorage.getItem('frpDbtoolsCollapsed') === '0') setCollapsed(false, false);
  } catch { /* private mode */ }

  // Which corner. Remembered per site, like the collapsed state.
  function setDock(side, remember = true) {
    const left = side === 'left';
    wrap.classList.toggle('left', left);
    els.dock.textContent = left ? '⇥' : '⇤';
    els.dock.title = left ? t('panel.dockRight') : t('panel.dockLeft');
    els.dock.setAttribute('aria-label', els.dock.title);
    if (remember) {
      try { localStorage.setItem('frpDbtoolsDock', left ? 'left' : 'right'); } catch { /* private mode */ }
    }
  }
  els.dock.addEventListener('click', (e) => {
    e.stopPropagation();   // not a click on the header: the panel stays open
    setDock(wrap.classList.contains('left') ? 'right' : 'left');
  });
  let dockSide = 'right';
  try { dockSide = localStorage.getItem('frpDbtoolsDock') || 'right'; } catch { /* private mode */ }
  setDock(dockSide, false);

  // `act` names what a button does, independent of its translated label — for the
  // end-to-end test, and for anything else that has to find "the start button"
  // whichever language the panel is in.
  function button(label, onClick, cls = '', act = '') {
    const el = document.createElement('button');
    el.textContent = label;
    if (cls) el.className = cls;
    if (act) el.dataset.act = act;
    el.addEventListener('click', onClick);
    return el;
  }

  function render(state) {
    const { session, engine, count = 0 } = state;
    const recording = Boolean(session && !session.closedAt);
    els.dot.className = `dot${recording ? ' rec' : ''}`;

    els.ended.hidden = !session || recording;
    els.ended.textContent = t('panel.ended');

    if (!session) {
      els.title.textContent = t('panel.title');
      els.name.textContent = t('panel.noSession');
      els.meta.textContent = t('panel.engine', { engine });
      els.buttons.replaceChildren(button(t('panel.start'), handlers.onStart, 'primary', 'start'));
      els.advanced.replaceChildren();
      els.advanced.hidden = true;
      return;
    }

    // What the session holds, not what is left to undo. Counting only the
    // not-yet-undone changes left a rolled-back session reading "0 changes" with
    // its changes plainly listed on the manager page — and they are still there,
    // and can be rolled back again.
    const changes = session.changes || [];
    const tables = new Set(changes.map((c) => c.table)).size;
    const snaps = TABLE_COPIES ? (session.snapshots || []).length : 0;
    els.title.textContent = `${session.name} · ${changes.length}`;

    const pickBtn = document.createElement('button');
    pickBtn.className = 'switch';
    pickBtn.dataset.act = 'pick';
    pickBtn.title = t('panel.switchHint', { n: count || 1 });
    const label = document.createElement('span');
    label.textContent = session.name;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▾';
    pickBtn.append(label, caret);
    if (handlers.onPick) pickBtn.addEventListener('click', handlers.onPick);
    els.name.replaceChildren(pickBtn);

    // Whether this one is still recording has to be said in words once the panel
    // can show a session that has ended: the dot alone reads as decoration.
    const stateWord = document.createElement('span');
    stateWord.className = `state${recording ? ' rec' : ''}`;
    stateWord.textContent = recording ? t('panel.recording') : t('panel.ended');
    els.meta.replaceChildren(
      stateWord,
      ` · ${t('panel.changes', { n: changes.length })} · ${t('panel.tables', { n: tables })}`
        + (snaps ? ` · ${t('panel.snapshots', { n: snaps })}` : '')
        + ` · ${t('panel.engine', { engine })}`,
    );

    const list = [
      button(t('panel.rollbackAll'), handlers.onRollbackAll, 'danger', 'rollback'),
    ];

    // Undoing the last thing you did is the small, frequent move — noticing a typo
    // right after saving it. Sending someone to the manager page to tick one box
    // for that, while "roll back everything" sits one click away, is how a whole
    // session gets thrown out to fix one row.
    const last = changes.filter((c) => !c.undone).length;
    if (last && handlers.onUndoLast) {
      const undo = button(t('panel.undoLast'), handlers.onUndoLast, '', 'undo-last');
      undo.title = t('panel.undoLastHint');
      list.push(undo);
    }

    // A rollback is not the end of the session. Finding out afterwards that the
    // test has to run once more left only one way back: making all those edits
    // again by hand, with the changeset that holds every one of them on screen.
    const rolledBack = changes.filter((c) => c.undone).length;
    if (rolledBack && handlers.onRedoAll) {
      const again = button(t('panel.redoAll'), handlers.onRedoAll, '', 'redo');
      again.title = t('panel.redoAllHint');
      list.push(again);
    }

    list.push(
      button(t('panel.exportSql'), handlers.onExportSql, '', 'export'),
      button(t('panel.view'), handlers.onView, '', 'view'),
    );
    // An ended session is still here to be picked back up: one click to go on
    // recording into it, one to start the next one.
    if (recording) {
      list.push(button(t('panel.stop'), handlers.onStop, '', 'stop'));
    } else {
      if (handlers.onResume) list.push(button(t('panel.resume'), handlers.onResume, 'primary', 'resume'));
      list.push(button(t('panel.newSession'), handlers.onStart, '', 'start'));
    }

    // Snapshots belong at the start of a test, so they are only offered while the
    // session is recording; a backup table can be made at any time.
    const extra = [];
    if (recording && handlers.onSnapshot) extra.push(button(t('panel.snapshot'), handlers.onSnapshot, '', 'snapshot'));
    if (handlers.onBackup) extra.push(button(t('panel.backup'), handlers.onBackup, '', 'backup'));
    if (extra.length) {
      const more = button('⋯', toggleAdvanced, `more${advancedOpen ? ' on' : ''}`, 'more');
      more.title = t('panel.more');
      more.setAttribute('aria-label', t('panel.more'));
      more.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false');
      list.push(more);
    }

    els.buttons.replaceChildren(...list);
    els.advanced.replaceChildren(...extra);
    els.advanced.hidden = !extra.length || !advancedOpen;
  }

  function toggleAdvanced() {
    advancedOpen = !advancedOpen;
    els.advanced.hidden = !advancedOpen;
    const more = els.buttons.querySelector('.more');
    if (more) {
      more.classList.toggle('on', advancedOpen);
      more.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false');
    }
    try { localStorage.setItem('frpDbtoolsAdvanced', advancedOpen ? '1' : '0'); } catch { /* private mode */ }
  }

  /**
   * One line in the log, newest on top, with the time it happened — "was that
   * the save from just now, or the one before?" is the question the log gets
   * asked. `action` makes the line a link: `{title, onClick}`.
   */
  function log(message, kind = '', action = null) {
    const line = document.createElement('div');
    if (kind) line.className = kind;
    const time = document.createElement('span');
    time.className = 'time';
    const now = new Date();
    time.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join(':');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = message;
    line.append(time, ' ', text);
    if (action && action.onClick) {
      line.classList.add('link');
      line.tabIndex = 0;
      line.setAttribute('role', 'link');
      if (action.title) line.title = action.title;
      line.addEventListener('click', action.onClick);
      line.addEventListener('keydown', (e) => { if (e.key === 'Enter') action.onClick(); });
    }
    els.log.prepend(line);
    if (progressLine && progressLine.isConnected) els.log.prepend(progressLine);
    while (els.log.childElementCount > 40) els.log.lastElementChild.remove();
    // Warnings are written while the panel is usually shut — a capture that could
    // not read the old rows is exactly the thing somebody needs to know before
    // trusting the rollback, and it was being written out of sight.
    if (kind === 'warn' || kind === 'err') markBadge(kind);
  }

  /**
   * The one line that rewrites itself: progress through a run.
   * `progress(null)` takes it away, which is what finishing means.
   */
  let progressLine = null;
  function progress(message, done = 0, total = 0) {
    if (message === null || message === undefined) {
      if (progressLine) progressLine.remove();
      progressLine = null;
      return;
    }
    if (!progressLine || !progressLine.isConnected) {
      progressLine = document.createElement('div');
      progressLine.className = 'prog';
      progressLine.innerHTML = '<span class="say"></span><span class="bar"><i></i></span>';
    }
    progressLine.querySelector('.say').textContent = message;
    const bar = progressLine.querySelector('.bar');
    bar.hidden = !total;
    if (total) bar.querySelector('i').style.width = `${Math.round((done / total) * 100)}%`;
    els.log.prepend(progressLine);
  }

  let unread = 0;
  function markBadge(kind) {
    if (!wrap.classList.contains('collapsed')) return;
    unread += 1;
    els.badge.hidden = false;
    els.badge.textContent = `⚠ ${unread}`;
    if (kind === 'err') els.badge.classList.add('err');
  }

  function clearBadge() {
    unread = 0;
    els.badge.hidden = true;
    els.badge.classList.remove('err');
  }

  /**
   * A line that goes away by itself after `ttl` ms: reminders and status —
   * "still has 3 changes not rolled back", "copied", "recording into … again".
   * They are true for a moment and then only clutter the log that the records
   * (what was recorded, what a rollback did, what failed) have to be found in.
   * A notice being read — the pointer on the log — stays until it is left.
   * It never lights the badge: it will be gone before anyone opens the panel.
   */
  function notice(message, kind = '', ttl = NOTICE_MS) {
    const line = document.createElement('div');
    line.className = `notice${kind ? ` ${kind}` : ''}`;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = message;
    line.append(text);
    els.log.prepend(line);
    if (progressLine && progressLine.isConnected) els.log.prepend(progressLine);
    const fade = () => {
      if (!line.isConnected) return;
      if (els.log.matches(':hover')) { setTimeout(fade, HOVER_RECHECK_MS); return; }
      line.classList.add('fading');
      setTimeout(() => line.remove(), FADE_OUT_MS);
    };
    setTimeout(fade, ttl);
    return line;
  }

  function expand() {
    setCollapsed(false, false);
  }

  /**
   * The sheet every question in this panel is asked in: a heading, a body, a note,
   * and the buttons. Escape and a click outside answer the same as Cancel.
   *
   * Two things this has to get right, because it is the last screen before rows
   * are written. Focus moves into the sheet — Escape is delivered to whatever has
   * focus, and while it stayed on Adminer's page the key did nothing and the
   * sheet looked stuck. And only one sheet is ever open: two clicks on "Roll back
   * all" used to stack two previews over the same session, and confirming both
   * ran the undo twice.
   */
  let openSheet = null;

  function sheet({ title, note, buttons, onDismiss }) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="sheet" tabindex="-1" role="dialog" aria-modal="true">
        <h2></h2>
        <div class="body"></div>
        <div class="note"></div>
        <div class="foot"></div>
      </div>`;
    const card = modal.querySelector('.sheet');
    card.querySelector('h2').textContent = title;
    const noteEl = modal.querySelector('.note');
    noteEl.textContent = note || '';
    noteEl.hidden = !note;
    modal.querySelector('.foot').append(...buttons(close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    const headingId = `frp-sheet-${Math.random().toString(36).slice(2, 8)}`;
    card.querySelector('h2').id = headingId;
    card.setAttribute('aria-labelledby', headingId);
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      // Tab stays inside the sheet. It is modal: the Adminer page behind it is
      // dimmed and cannot be clicked, and it should not be reachable by keyboard
      // either — tabbing onto a Save button behind a rollback preview is how a
      // keystroke lands somewhere nobody meant.
      if (e.key !== 'Tab') return;
      const stops = [...card.querySelectorAll('button, input, select, textarea, [tabindex="0"]')]
        .filter((x) => !x.disabled && x.offsetParent !== null);
      if (!stops.length) { e.preventDefault(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = shadow.activeElement;
      if (e.shiftKey && (active === first || active === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    });
    shadow.append(modal);

    const returnTo = document.activeElement;
    card.focus();
    const view = { modal, card, body: modal.querySelector('.body'), note: noteEl, close, focus: () => card.focus() };
    openSheet = view;

    function close() {
      modal.remove();
      if (openSheet === view) openSheet = null;
      // Back where they were, so the next keystroke goes to Adminer and not nowhere.
      try { if (returnTo && returnTo.isConnected) returnTo.focus(); } catch { /* gone */ }
      onDismiss();
    }
    return view;
  }

  /** A second question while one is already on screen is the first one, asked twice. */
  function busy() {
    // A sheet taken off the page some other way is not an open sheet; without
    // this the panel would refuse every question from then on.
    if (openSheet && !openSheet.modal.isConnected) openSheet = null;
    if (!openSheet) return false;
    openSheet.focus();
    return true;
  }

  /**
   * Show the statements and wait for an answer.
   * Resolves true to run them, false to walk away.
   *
   * `summary` is what the statements amount to, in a line per change, above the
   * SQL — the SQL itself is still always there, because it is what will actually
   * run, but nobody decides by reading forty quoted UPDATEs. `cancelLabel` lets
   * the caller say what walking away *does*: on the drift question, cancelling is
   * not "nothing happens", it is "skip those rows and roll the rest back".
   *
   * `modes` offers the same run two ways — step by step, or folded per row —
   * as `{ value, label, options: [{ id, label, hint, sql, summary, note,
   * confirmLabel }] }`. A row of buttons above the summary switches between them
   * in place, SQL and all, so what is confirmed is what is on screen; the promise
   * then resolves to that option's id instead of `true`.
   */
  function preview({ title, sql, note, confirmLabel, cancelLabel, confirmKind = 'primary', summary, table,
    copyButton = true, modes = null }) {
    if (busy()) return Promise.resolve(false);
    const options = modes && modes.options && modes.options.length ? modes.options : null;
    let current = options
      ? (options.find((o) => o.id === modes.value) || options[0])
      : { sql, note, confirmLabel, summary };
    return new Promise((resolve) => {
      let answered = false;
      const done = (value) => { answered = true; resolve(value); };
      let confirmBtn = null;
      const view = sheet({
        title,
        note: current.note,
        onDismiss: () => { if (!answered) resolve(false); },
        buttons: (close) => {
          confirmBtn = button(current.confirmLabel, () => { done(options ? current.id : true); close(); },
            confirmKind, 'confirm');
          return [
            copyButton && button(t('rollback.copy'), async () => {
              try {
                await navigator.clipboard.writeText(current.sql);
                notice(t('rollback.copied'), 'ok');
              } catch {
                // Clipboard can be refused without a user gesture chain; the text is
                // on screen and selectable, so this is a nicety, not a failure.
              }
            }, '', 'copy'),
            button(cancelLabel || t('rollback.cancel'), () => { done(false); close(); }, '', 'cancel'),
            confirmBtn,
          ].filter(Boolean);
        },
      });

      // A table, when the content is rows of values — the drift question — rather
      // than statements: "column / recorded / now" side by side is read at a
      // glance, the same facts run together in a code block are not.
      const pre = table ? gridTable(table) : document.createElement('pre');
      const label = document.createElement('div');
      label.className = 'split';
      label.textContent = table ? (table.heading || '') : t('rollback.sqlHeading');
      let sumEl = document.createElement('div');
      const bar = options ? modeBar() : null;
      view.body.replaceWith(...[bar, sumEl, label, pre].filter(Boolean));

      function modeBar() {
        const box = document.createElement('div');
        box.className = 'modes';
        box.setAttribute('role', 'group');
        if (modes.label) box.setAttribute('aria-label', modes.label);
        for (const option of options) {
          const b = button(option.label, () => { current = option; paint(); }, 'mode', `mode-${option.id}`);
          b.dataset.mode = String(option.id);
          box.append(b);
        }
        const hint = document.createElement('span');
        hint.className = 'hint';
        box.append(hint);
        return box;
      }

      function paint() {
        if (!table) pre.textContent = current.sql;
        const lines = current.summary || [];
        const next = lines.length ? summaryBlock(lines) : document.createElement('div');
        next.hidden = !lines.length;
        sumEl.replaceWith(next);
        sumEl = next;
        label.hidden = !lines.length;
        view.note.textContent = current.note || '';
        view.note.hidden = !current.note;
        confirmBtn.textContent = current.confirmLabel;
        if (!bar) return;
        for (const b of bar.querySelectorAll('button.mode')) {
          const on = b.dataset.mode === String(current.id);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        bar.querySelector('.hint').textContent = current.hint || '';
      }
      paint();
    });
  }

  /** `{columns, rows, heading}` as a table that scrolls inside the sheet like the SQL does. */
  function gridTable({ columns, rows }) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'grid-wrap';
    const tableEl = document.createElement('table');
    tableEl.className = 'grid';
    const head = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col;
      head.append(th);
    }
    tableEl.append(head);
    for (const row of rows) {
      const tr = document.createElement('tr');
      row.forEach((cell, i) => {
        const td = document.createElement('td');
        if (cell && typeof cell === 'object') {
          td.textContent = cell.text;
          if (cell.cls) td.className = cell.cls;
        } else {
          td.textContent = cell === null || cell === undefined ? '' : String(cell);
        }
        if (i > 0) td.classList.add('val');
        tr.append(td);
      });
      tableEl.append(tr);
    }
    wrapEl.append(tableEl);
    return wrapEl;
  }

  /**
   * The lines above the SQL. Each is `{op, table, say, skipped}` — an operation
   * badge, what it touches, and what will happen to it; a skipped one says why
   * instead, in the same list, so "3 changes were skipped" is not a number the
   * person has to go and look up somewhere else.
   */
  function summaryBlock(lines) {
    const box = document.createElement('div');
    box.className = 'summary';
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = `line${line.skipped ? ' skip' : ''}`;
      if (line.total) {
        row.className = 'total';
        row.textContent = line.say;
        box.append(row);
        continue;
      }
      if (line.op) {
        const op = document.createElement('span');
        op.className = `op ${line.op}`;
        op.textContent = line.op.toUpperCase();
        row.append(op);
      }
      if (line.table) {
        const tbl = document.createElement('span');
        tbl.className = 'tbl';
        tbl.textContent = line.table;
        row.append(tbl);
      }
      const say = document.createElement('span');
      say.className = 'say';
      say.textContent = line.say || '';
      row.append(say);
      box.append(row);
    }
    return box;
  }

  /**
   * Ask for one line of text — a session name, a list of tables — in that same
   * sheet rather than through `window.prompt`, whose box belongs to the browser
   * and looks nothing like the rest of this.
   *
   * Resolves the text, or null when dismissed, exactly like `prompt` did.
   */
  function ask({ title, label, value = '', note, confirmLabel, placeholder }) {
    if (busy()) return Promise.resolve(null);
    return new Promise((resolve) => {
      let answered = false;
      const done = (text) => { answered = true; resolve(text); };
      const view = sheet({
        title,
        note,
        onDismiss: () => { if (!answered) resolve(null); },
        buttons: (close) => [
          button(t('rollback.cancel'), () => { done(null); close(); }),
          button(confirmLabel, () => { done(input.value); close(); }, 'primary'),
        ],
      });

      const field = document.createElement('label');
      field.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      if (placeholder) input.placeholder = placeholder;
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        done(input.value);
        view.close();
      });
      field.append(caption, input);
      view.body.append(field);
      input.focus();
      input.select();
    });
  }

  /**
   * The sessions recorded on this database, to pick one back up.
   *
   * `items` are `{id, name, meta, recording, shown}`. Resolves
   * `{action: 'resume', id}`, `{action: 'new'}`, `{action: 'manage'}`, or null.
   *
   * Picking up an older session used to be: open the manager page, find it, press
   * Reopen, come back to this tab. Here it is one press on the name and one on
   * the row.
   */
  function pick({ items, note }) {
    if (busy()) return Promise.resolve(null);
    return new Promise((resolve) => {
      let answered = false;
      const done = (value) => { answered = true; resolve(value); };
      const view = sheet({
        title: t('panel.pickTitle'),
        note,
        onDismiss: () => { if (!answered) resolve(null); },
        buttons: (close) => [
          button(t('panel.manageAll'), () => { done({ action: 'manage' }); close(); }, '', 'manage'),
          button(t('panel.dismiss'), () => { done(null); close(); }),
          button(t('panel.newSession'), () => { done({ action: 'new' }); close(); }, 'primary', 'new'),
        ],
      });
      view.card.classList.add('narrow');

      const box = document.createElement('div');
      box.className = 'picker';
      const list = document.createElement('div');
      list.className = 'list';

      const rows = items.map((item) => {
        const row = document.createElement('div');
        row.className = `pick-row${item.shown ? ' shown' : ''}`;
        row.dataset.id = item.id;
        const main = document.createElement('div');
        main.className = 'pick-main';
        const name = document.createElement('div');
        name.className = 'pick-name';
        name.textContent = item.name;
        const meta = document.createElement('div');
        meta.className = 'pick-meta';
        meta.textContent = item.meta;
        main.append(name, meta);
        row.append(main);
        if (item.recording) {
          const rec = document.createElement('span');
          rec.className = 'rec';
          rec.textContent = t('panel.recordingPill');
          row.append(rec);
        } else {
          row.append(button(t('panel.resume'), () => { done({ action: 'resume', id: item.id }); view.close(); },
            '', 'resume'));
        }
        return { row, text: item.name.toLowerCase() };
      });

      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = t('panel.pickNone');
      none.hidden = true;
      list.append(...rows.map((r) => r.row), none);

      // A filter only once the list is long enough to need one; for three sessions
      // it is just another box between the person and the row they want.
      let filter = null;
      if (items.length > 6) {
        filter = document.createElement('input');
        filter.type = 'text';
        filter.className = 'filter';
        filter.placeholder = t('panel.pickFilter');
        filter.addEventListener('input', () => {
          const q = filter.value.trim().toLowerCase();
          let shown = 0;
          for (const r of rows) {
            r.row.hidden = Boolean(q) && !r.text.includes(q);
            if (!r.row.hidden) shown++;
          }
          none.hidden = shown > 0;
        });
        filter.addEventListener('keydown', (e) => {
          // Enter takes the first match that can be resumed — typing part of a name
          // and pressing Enter is the fastest way back into it.
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const first = rows.find((r) => !r.row.hidden && r.row.querySelector('[data-act="resume"]'));
          if (first) first.row.querySelector('[data-act="resume"]').click();
        });
        box.append(filter);
      }
      box.append(list);
      view.body.replaceWith(box);
      if (filter) filter.focus();
      const current = rows.find((r) => r.row.classList.contains('shown'));
      if (current) current.row.scrollIntoView({ block: 'nearest' });
    });
  }

  /** 'light', 'dark', or '' to follow the operating system. */
  function setTheme(next) {
    if (next === 'light' || next === 'dark') host.dataset.theme = next;
    else delete host.dataset.theme;
  }

  return { render, log, notice, progress, preview, ask, pick, expand, setTheme, destroy: () => host.remove(), host };
}
