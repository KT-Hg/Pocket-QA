/**
 * manager/dialogs.js — the manager's dialogs, report line and toast.
 */

import { t } from '../i18n.js';
import { makeButton } from './render.js';
import { ui } from './state.js';

/* === Asking ══════════════════════════════════════════════════════════════
 * Renaming a session and deleting one used to go through `prompt` and `confirm`.
 * Those belong to the browser: a bar at the top of the window, in the browser's
 * own styling, disowned from the page that asked. They are asked here instead, in
 * the same dialog the settings use — and the panel inside Adminer asks its own
 * questions in the sheet its previews use, so nothing is answered in a box that
 * looks like it came from somewhere else.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Show a modal and hand back the one answer it is for.
 *
 * The dialog's own `close` event is not what settles it. Chrome does not fire
 * that event for a `close()` called from script — the dialog simply closes and
 * nothing hears about it — so every way out of this one (a button, Enter, Escape,
 * the backdrop) goes through `finish`, which closes it, takes it off the page and
 * answers exactly once.
 */
export function openDialog({ title, body, answer, buttons }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg';
  const wrap = document.createElement('div');
  wrap.className = 'dlg-body';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const foot = document.createElement('div');
  foot.className = 'dlg-foot';
  wrap.append(heading, body, foot);
  dlg.append(wrap);
  document.body.append(dlg);

  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    dlg.close();
    dlg.remove();
    answer(value);
  };

  foot.append(...buttons(finish));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(undefined); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(undefined); });
  dlg.showModal();
  return { dlg, finish };
}

/** One line of text, or null when dismissed. */
export function askDialog({ title, label, value = '', confirmLabel }) {
  return new Promise((resolve) => {
    const field = document.createElement('label');
    field.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    field.append(caption, input);

    const { finish } = openDialog({
      title,
      body: field,
      answer: (text) => resolve(text === undefined ? null : text),
      buttons: (close) => [
        makeButton(t('rollback.cancel'), () => close(undefined)),
        makeButton(confirmLabel, () => close(input.value), 'primary'),
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      finish(input.value);
    });
    input.focus();
    input.select();
  });
}

/** Yes or no. */
export function confirmDialog({ title, text, confirmLabel }) {
  return new Promise((resolve) => {
    const line = document.createElement('p');
    line.className = 'meta';
    line.style.whiteSpace = 'pre-wrap';
    line.textContent = text;
    openDialog({
      title,
      body: line,
      answer: (value) => resolve(value === true),
      buttons: (close) => [
        makeButton(t('rollback.cancel'), () => close(false)),
        makeButton(confirmLabel, () => close(true), 'danger'),
      ],
    });
  });
}

/* === Small helpers ═══════════════════════════════════════════════════════ */

export function showReport(text, kind, action) {
  ui.report.hidden = false;
  ui.report.className = `report ${kind || ''}`;
  ui.report.replaceChildren(document.createTextNode(text));
  if (action) {
    const b = makeButton(action.label, () => action.onClick(), 'small report-action');
    ui.report.append(b);
  }
}

let toastTimer = 0;
const TOAST_MS = 2600;

export function toast(text) {
  ui.toast.hidden = false;
  ui.toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, TOAST_MS);
}
