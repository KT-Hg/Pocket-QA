/**
 * screenshot/report.js — how a capture tells the user how it went: a SCREENSHOT_RESULT
 * broadcast for the popup, and a notification when no popup is open to show it.
 */

import { sendCaptureNotification } from '../notify.js';

/* ── Capture result reporting ───────────────────────────────────────────────────
 * Every capture ends by broadcasting SCREENSHOT_RESULT, which the popup turns
 * into a toast — when the popup is open. Usually it is not: a hotkey capture
 * starts with it closed, and the popup closes itself before the countdown
 * (on by default), segment capture and element pick, so most captures started
 * from popup buttons finish with it gone too.
 *
 * The notification used to be gated on a `fromHotkey` flag, a guess at whether
 * the popup was there. The popup's own countdown and segment buttons sent
 * fromHotkey: false and then closed the popup, so the most common capture —
 * Visible with the default countdown — saved its file and reported nothing.
 * Now the worker asks the browser whether a popup is actually open.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Whether the toolbar popup is open to show the SCREENSHOT_RESULT toast.
 * runtime.getContexts arrived in Chrome 116; before it, `fromHotkey` stays the guess.
 */
async function _popupOpen(fromHotkey) {
  if (!chrome.runtime.getContexts) return !fromHotkey;
  const popups = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).catch(() => []);
  return popups.length > 0;
}

/**
 * Broadcast a capture result, and notify when no popup is open to toast it.
 *
 * @param {{error?: string, filename?: string, cropping?: boolean, cancelled?: boolean, partial?: boolean}} result
 * @param {Object}  [opts]
 * @param {boolean} [opts.fromHotkey=false] — the popup is known to be closed (used only where getContexts is missing)
 * @param {string}  [opts.label='Screenshot'] — notification title prefix
 */
export async function reportCaptureResult(result, { fromHotkey = false, label = 'Screenshot' } = {}) {
  chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
  if (await _popupOpen(fromHotkey)) return;
  const r = result || {};
  // The user dismissed the Save As dialog. They know what they did; announcing it
  // as an outcome would be noise, and announcing it as a failure would be wrong.
  if (r.cancelled) return;
  // One id for the whole capture family: rapid-fire captures replace each other
  // rather than stacking, and the last one is always the one still on screen.
  if (r.error) sendCaptureNotification(`${label} failed`, r.error, 'hotkey_capture');
  // `cropping` means the crop editor window just opened — that IS the feedback,
  // and the real save happens later inside the editor.
  else if (!r.cropping) sendCaptureNotification(`${label} saved${r.partial ? ' (partial)' : ''}`, r.filename || 'Saved', 'hotkey_capture');
}
