/**
 * screenshot/report.js — how a capture tells the user how it went: a SCREENSHOT_RESULT
 * broadcast for the popup, and a notification when it came from a hotkey.
 */

import { sendCaptureNotification } from '../notify.js';

/* ── Capture result reporting ───────────────────────────────────────────────────
 * Every capture ends by broadcasting SCREENSHOT_RESULT, which the popup turns
 * into a toast. That works for captures started from a popup button, because the
 * popup is still open when they finish.
 *
 * It does nothing for a capture started from a hotkey: the popup is closed by
 * definition, so the toast has no window to appear in. Alt+V, Alt+H and the
 * segment hotkeys saved a file and reported absolutely nothing; a failure on any
 * hotkey path was equally silent. Element capture (Alt+E) already notified —
 * this makes the other hotkeys behave the same way.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Broadcast a capture result, and notify when the capture came from a hotkey.
 *
 * @param {{error?: string, filename?: string, cropping?: boolean}} result
 * @param {Object}  [opts]
 * @param {boolean} [opts.fromHotkey=false] — notify only when this is true
 * @param {string}  [opts.label='Screenshot'] — notification title prefix
 */
export function reportCaptureResult(result, { fromHotkey = false, label = 'Screenshot' } = {}) {
  chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
  if (!fromHotkey) return;
  const r = result || {};
  // The user dismissed the Save As dialog. They know what they did; announcing it
  // as an outcome would be noise, and announcing it as a failure would be wrong.
  if (r.cancelled) return;
  // One id for the whole hotkey family: rapid-fire captures replace each other
  // rather than stacking, and the last one is always the one still on screen.
  if (r.error) sendCaptureNotification(`${label} failed`, r.error, 'hotkey_capture');
  // `cropping` means the crop editor window just opened — that IS the feedback,
  // and the real save happens later inside the editor.
  else if (!r.cropping) sendCaptureNotification(`${label} saved`, r.filename || 'Saved', 'hotkey_capture');
}
