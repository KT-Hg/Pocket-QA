import { normalizeVarRef, selectorStrings, writtenVarNames } from '../shared/var-name.js';
import { pickStrings } from '../shared/dropdown-pick.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { trapFocus } from './ui/focus.js';
/* === HTML Escape === */

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* === Action Icons === */

const ACTION_ICONS = {
  click: '🖱', input: '⌨', navigate: '🔗', script: '⚡', hover: '👆',
  wait: '⏱', condition: '❓', switch: '🔀', dragdrop: '↕', readdom: '📖',
  screenshot: '📷', screenshot_full: '📄', screenshot_element: '📌', screenshot_tovar: '📸',
  dropdown: '🔽', uploadFile: '📂'
};

export function getActionIcon(type) {
  return ACTION_ICONS[type] || '';
}

/* === Toast Notification === */

let _toastTimer = null;

// How long each toast type stays up. Confirmations are read at a glance and can
// go quickly; anything the user may need to act on stays longer.
const TOAST_DURATION = {
  success: 2500,
  info:    3000,
  warn:    4000,
  error:   5000,
};

export function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  // Errors use aria-live="assertive" to interrupt screen reader announcements;
  // success/info use "polite" so they don't cut off what the user is reading.
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_DURATION[type] ?? TOAST_DURATION.info);
}

/* === Scroll Lock === */

let _savedScrollY = 0;
// Guards against re-entry: showLockOverlay locks twice (record + data panes) and
// re-runs on every tab-activation check. Without this, the second lock would
// read the already-offset body and save a bogus scroll position to restore to.
let _scrollLocked = false;

// Prevent the page from scrolling while a modal is open by positioning the
// body at a negative top offset equal to the current scroll position.
export function lockScroll() {
  if (_scrollLocked) return;
  _scrollLocked = true;
  _savedScrollY = document.body.scrollTop || window.scrollY || 0;
  document.body.style.top = `-${_savedScrollY}px`;
  document.body.classList.add('modal-open');
  document.documentElement.style.overflow = 'hidden';
}

export function unlockScroll() {
  if (!_scrollLocked) return;
  _scrollLocked = false;
  document.body.classList.remove('modal-open');
  document.documentElement.style.overflow = '';
  document.body.style.top = '';
  document.body.scrollTop = _savedScrollY;
  window.scrollTo(0, _savedScrollY);
}

/* === Confirm / Alert Modals === */

function _closeModal(modal, releaseFocus, extra) {
  if (modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.remove('show');
  releaseFocus();
  modal.setAttribute('aria-hidden', 'true');
  if (extra) extra();
  unlockScroll();
}

export function showConfirm(msg, onConfirm, { title = 'Confirm', danger = false, okLabel = '' } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  const input = document.getElementById('confirmModalInput');
  if (input) input.style.display = 'none';
  const okBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');
  okBtn.textContent = okLabel || (danger ? 'Delete' : 'Confirm');
  okBtn.className = danger ? 'danger' : '';
  cancelBtn.style.display = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  const releaseFocus = trapFocus(modal);
  const close = () => _closeModal(modal, releaseFocus);
  cancelBtn.onclick = close;
  okBtn.onclick = () => { close(); onConfirm(); };
}

export function showAlert(msg, { title = 'Notice' } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  const input = document.getElementById('confirmModalInput');
  if (input) input.style.display = 'none';
  const okBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');
  okBtn.textContent = 'OK';
  okBtn.className = '';
  cancelBtn.style.display = 'none';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  const releaseFocus = trapFocus(modal);
  const close = () => _closeModal(modal, releaseFocus, () => { cancelBtn.style.display = ''; });
  cancelBtn.onclick = close;
  okBtn.onclick = close;
}

/**
 * Modal replacement for window.prompt(). Cancelling does not call `onSubmit`,
 * so callers never need a null check the way they did with the native dialog.
 * @param {string} msg — prompt text shown above the input
 * @param {(value: string) => void} onSubmit — called with the trimmed input on confirm only
 * @param {Object} [opts]
 * @param {string} [opts.title='Enter Value'] — modal heading
 * @param {string} [opts.value=''] — initial input value, preselected for overwrite
 * @param {string} [opts.type='text'] — input type attribute, e.g. 'number'
 * @param {string} [opts.okLabel='OK'] — confirm button label
 * @returns {void}
 */
export function showPrompt(msg, onSubmit, { title = 'Enter Value', value = '', type = 'text', okLabel = 'OK' } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  const input = document.getElementById('confirmModalInput');
  const okBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');

  input.type = type;
  input.value = value;
  input.style.display = '';
  okBtn.textContent = okLabel;
  okBtn.className = '';
  cancelBtn.style.display = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();

  const releaseFocus = trapFocus(modal);
  // trapFocus focuses the first tabbable element, which is not the input —
  // put the caret where the user is about to type and preselect for overwrite.
  input.focus();
  input.select();

  const close = () => _closeModal(modal, releaseFocus, () => { input.style.display = 'none'; });
  const submit = () => { const v = input.value.trim(); close(); onSubmit(v); };

  cancelBtn.onclick = close;
  okBtn.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
}

/* === Tab Messaging === */

// Must stay identical to the content_scripts entry in manifest.json: a tab opened
// before the extension was installed gets the same script the manifest injects.
export const CONTENT_SCRIPT_FILES = ['content.js', 'content-highlight.js'];

export function safeSendTabMessage(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
}

// chrome:// and chrome-extension:// URLs reject scripting.executeScript and sendMessage.
export function isEligibleTab(tab) {
  if (!tab?.url) return false;
  const url = tab.url;
  return (
    url.startsWith('http:') ||
    url.startsWith('https:') ||
    url.startsWith('file:') ||
    url.startsWith('ftp:') ||
    url.startsWith('ws:') ||
    url.startsWith('wss:')
  );
}

/* === Debounce === */

export function debounce(fn, delay = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/* === Drag & Drop === */

/** The row the dragged `li.dragging` should be inserted before at pointer y, or undefined for the end. */
export function getDragAfterElement(container, y) {
  // Rows hidden by a collapsed Switch have no box to measure.
  const items = [...container.querySelectorAll("li:not(.dragging)")]
    .filter(el => el.getClientRects().length > 0);
  // Measure every row as if the dragged one were not in the list. The dragged
  // row sits where the last dragover put it, so the rows after it are pushed
  // down by its height; judged on those shifted boxes, a 40px row passing 30px
  // rows kept crossing the midpoint back and forth and the list jittered.
  const dragged = container.querySelector("li.dragging");
  const dBox = dragged ? dragged.getBoundingClientRect() : null;
  // Over the dragged row itself: it stays where it is. Otherwise a short row
  // right below it (a "move out of …" zone) counted as passed and the row
  // jumped past it the moment the drag began.
  if (dBox && y >= dBox.top && y <= dBox.bottom) return dragged.nextElementSibling;
  const shift = dBox ? dBox.height : 0;
  const draggedTop = dBox ? dBox.top : Infinity;
  // The pointer is moved into the same "row removed" coordinates as the rows.
  const yv = dBox && y > dBox.bottom ? y - shift : y;

  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const top = box.top > draggedTop ? box.top - shift : box.top;
      const offset = yv - top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

/* === Variable Usage Scanning === */

/**
 * Variable names a scenario actually references.
 *
 * The field list must stay in step with interpolateAction() in bg/interpolate.js: a
 * field that gets variables substituted at playback but is not scanned here is
 * dropped from the export's variable list, so the generated code references an
 * identifier it never declared (ReferenceError in JS, NameError in Python).
 * conditions.* and fileNames used to be missed — a Child Condition matching on
 * `${label}` ran fine in the extension but exported a broken script.
 *
 * Variables a step *writes* (readdom / screenshot_tovar varName) count as used
 * too, so a scenario that seeds one statically keeps that seed on export.
 */
export function getUsedVarNames(actions) {
  const used = getReadVarNames(actions);
  for (const action of (actions || [])) {
    for (const vn of writtenVarNames(action)) used.add(vn);
  }
  return used;
}

/**
 * Variable names a scenario *reads* through `${…}` — getUsedVarNames without the
 * names steps write. This is what a CSV run needs columns for.
 */
export function getReadVarNames(actions) {
  const used = new Set();
  const re   = /\$\{([^}]+)\}/g;

  const FIELDS   = [
    'selector', 'value', 'url', 'code', 'expectedValue',
    'folderPath', 'fileName',
  ];

  const scan = (v) => {
    if (typeof v !== 'string') return;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(v)) !== null) used.add(m[1]);
  };

  for (const action of (actions || [])) {
    if (!action) continue;
    for (const f of FIELDS) scan(action[f]);
    // A bare Switch name reads `${name}` at run time — see normalizeVarRef.
    scan(normalizeVarRef(action.switchVar));
    // selectors.* / targetSelectors.* and attrName get variables substituted at
    // playback too (bg/interpolate.js interpolateAction).
    selectorStrings(action).forEach(scan);
    scan(action.attrName);
    if (Array.isArray(action.fileNames)) action.fileNames.forEach(scan);
    pickStrings(action).forEach(scan);
    if (action.conditions && typeof action.conditions === 'object') {
      for (const f of CHILD_COND_KEYS) scan(action.conditions[f]);
    }
  }
  return used;
}
