/**
 * ui/toast.js — the toast message.
 */

import { el } from './dom.js';

let toastTimer = null;

/**
 * `type` picks the toast's colour ('success' | 'error' | 'warn') so a failure
 * reads as a failure instead of looking identical to a confirmation — call
 * sites must pass it explicitly rather than rely on a default, since silently
 * defaulting a forgotten call to 'success' would make a real error look fine.
 */
export function toast(message, type, ms = 2200) {
  el.toast.textContent = message;
  el.toast.className = `toast toast-${type}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  // `ms` is for the rare message that has to be read rather than glanced at —
  // the first-run note, which arrives while the reader is still taking the
  // page in. Every confirmation after an action keeps the default.
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
