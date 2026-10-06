/**
 * ui/focus.js — keeping keyboard focus inside an open modal.
 */

// Matches all interactive elements that can receive keyboard focus.
// tabindex="-1" is deliberately excluded — those elements are not in the
// natural tab order and should not be cycled through by the trap.
const FOCUSABLE_SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside `items`: Tab on the last goes to the first, Shift+Tab on the
 * first to the last. trapFocus and ui/modal.js each pass their own list of what
 * can take focus.
 */
export function wrapTab(e, items) {
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Returns a cleanup function that removes the listener and restores prior focus.
export function trapFocus(modalEl) {
  const prevActive = document.activeElement;
  const getFocusable = () => Array.from(modalEl.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.offsetParent !== null || el === document.activeElement);

  const focusable = getFocusable();
  if (focusable.length) focusable[0].focus();

  const handler = (e) => {
    if (e.key !== 'Tab') return;
    wrapTab(e, getFocusable());
  };
  modalEl.addEventListener('keydown', handler);

  return () => {
    modalEl.removeEventListener('keydown', handler);
    if (prevActive && typeof prevActive.focus === 'function') {
      try { prevActive.focus(); } catch (_) { /* opener left the page: nothing to return focus to */ }
    }
  };
}
