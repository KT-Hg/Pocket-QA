/**
 * screenshot/countdown.js — the countdown before a visible capture: drawn by the page
 * when it can, on the toolbar badge when it cannot.
 */

import { tabMsg } from '../tabs.js';
import { updateBadge } from '../badge.js';

/* ── Pre-capture countdown ──────────────────────────────────────────
 * The countdown pill is drawn by content.js, which manifest.json only injects
 * into http, https and file tabs. The popup used to message that script itself,
 * so on any other tab — this extension's own pages (sqlcases.html, editor.html),
 * chrome://, the Web Store — the message had no receiving end and the capture
 * never happened: with the countdown off the same button worked, with it on
 * nothing at all occurred.
 *
 * So the worker owns the countdown and only delegates the drawing. The page
 * draws the pill and fires the shot itself when it can; when it cannot, the
 * count runs on the toolbar badge — the same surface window capture already
 * counts down on, and the one piece of UI every tab has.
 * ────────────────────────────────────────────────────────────────── */

const COUNTDOWN_BADGE_COLOR = '#3b82f6';
// One count of the countdown.
const COUNTDOWN_TICK_MS = 1000;
// How long the page gets to answer START_VISIBLE_COUNTDOWN (see runCountdown).
const PAGE_PROBE_TIMEOUT_MS = 1500;

const _wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Count down on the toolbar badge, then hand the badge back to REC/playback. */
async function _badgeCountdown(seconds) {
  for (let left = seconds; left > 0; left--) {
    chrome.action.setBadgeText({ text: String(left) });
    chrome.action.setBadgeBackgroundColor({ color: COUNTDOWN_BADGE_COLOR });
    await _wait(COUNTDOWN_TICK_MS);
  }
  // Never clear the badge directly: a running recording's REC badge has to come
  // back, and only the worker's own state knows what belongs there.
  updateBadge();
}

/**
 * Run the countdown before a visible capture.
 *
 * @returns {Promise<boolean>} true when the caller still owes the shot; false
 *   when the page took the countdown over and will fire its own TAKE_SCREENSHOT.
 */
export async function runCountdown(tabId, seconds, crop) {
  // A short timeout, because this is a liveness probe as much as a request:
  // content.js answers immediately, and a tab without it fails immediately too.
  // Only a page that is present but wedged waits out the timeout, and falling
  // back to the badge is the right answer there as well.
  const res = await tabMsg(tabId, { type: 'START_VISIBLE_COUNTDOWN', seconds, crop }, PAGE_PROBE_TIMEOUT_MS);
  if (res && res.ok) return false;
  await _badgeCountdown(seconds);
  return true;
}
