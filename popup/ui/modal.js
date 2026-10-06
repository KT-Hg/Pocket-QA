/**
 * ui/modal.js — open / close a modal with focus handling (Escape, Tab trap,
 * focus returned to the opener).
 */

import { lockScroll, unlockScroll } from '../utils.js';
import { wrapTab } from './focus.js';

/* === Timing constants === */
const FOCUS_DELAY_MS   = 50;   // wait for modal DOM to paint before focusing

// Not trapFocus's list (ui/focus.js): no [href], and hidden elements count —
// kept as each has always been, since either change would move the Tab order.
function _getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

export function openModal(modalId, firstFocusSelector) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add("show");
  lockScroll();
  // Focus first focusable element
  const target = firstFocusSelector
    ? modal.querySelector(firstFocusSelector)
    : _getFocusableElements(modal)[0];
  setTimeout(() => target?.focus(), FOCUS_DELAY_MS);
}

export function closeModal(modalId, returnFocusEl) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("show");
  unlockScroll();
  returnFocusEl?.focus();
}

export function attachModalKeyHandlers(modalId, closeFn) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeFn(); return; }
    if (e.key !== "Tab") return;
    wrapTab(e, _getFocusableElements(modal));
  });
}
