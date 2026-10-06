/**
 * screenshot/cancel.js — cancelling a full-page capture: ESC on the page, or the
 * debugger detaching under it.
 */

import { markSessionClosed } from '../cdp/session.js';
import { restorePageDom } from './page-scripts.js';

/* ── Cancellation ───────────────────────────────────────────────────────────────
 * A full-page capture can be aborted two ways, both of which must end the SAME
 * way — a clean "cancelled" result, page restored, no error toast:
 *
 *   1. ESC on the page → content script sends CANCEL_FULL_SCREENSHOT → the capture
 *      loop checks this set at safe points and throws CaptureCancelled.
 *   2. The debugger detaches mid-capture — most commonly the user pressing ESC /
 *      clicking "Cancel" on Chrome's "is debugging this browser" banner, which
 *      steals focus so ESC dismisses the banner instead of reaching the page.
 *      onDetach marks the tab cancelled too, so the in-flight CDP command's
 *      rejection is treated as a cancel rather than surfaced as an error.
 *
 * Membership is cleared at the start of every capture, so a stray mark left when
 * no capture is running is harmless.
 * ────────────────────────────────────────────────────────────────────────────── */
export const cancelledCaptures = new Set();

export class CaptureCancelled extends Error {
  constructor() { super('Capture cancelled'); this.name = 'CaptureCancelled'; }
}

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request?.type !== 'CANCEL_FULL_SCREENSHOT') return;
  const tabId = request.tabId || sender.tab?.id;
  if (tabId != null) cancelledCaptures.add(tabId);
});

/* ── Debugger detach safety net ─────────────────────────────────────────────────
 * When the debugger detaches for a reason outside our control (banner Cancel,
 * DevTools opening), the capture's cdpEval-based restore can no longer reach the
 * page — the scrollbar-hide style, documentElement transform, and hidden fixed
 * elements would stay applied, leaving the tab scaled and unscrollable. Restore via
 * chrome.scripting, which doesn't need the debugger, and mark the capture cancelled
 * so it resolves cleanly (see the Cancellation block above).
 *
 * Skipped when the tab itself is gone (nothing left to restore). Does not fire for
 * our own end-of-capture detach() calls, so it only triggers on real interruptions.
 * ────────────────────────────────────────────────────────────────────────────── */
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  markSessionClosed(source.tabId);
  if (reason === 'target_closed') return;
  cancelledCaptures.add(source.tabId);
  restorePageDom(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => { cancelledCaptures.delete(tabId); });
