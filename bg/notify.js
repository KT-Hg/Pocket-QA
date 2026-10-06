/**
 * notify.js — notifications, each in a category the user can mute in Settings.
 */

import { ignoreLastError } from './last-error.js';

/* ── Notifications ──────────────────────────────────────────────────────────── */

const _NOTIF_ICON = chrome.runtime.getURL('icons/icon48.png');

/* Every notification belongs to exactly one category, and each category has its
 * own sync-storage toggle.
 *
 * Before this split a single `notifyOnComplete` key gated only the four
 * "run finished" notifications, while the ~18 alert and capture notifications
 * ignored it completely — so turning the toggle off in Settings did almost
 * nothing, which reads as a bug.
 *
 * Defaults preserve the behaviour each category had before the split: completion
 * was opt-in (off by default), alerts and capture results always fired. An absent
 * key therefore means `false` for complete and `true` for the other two.
 *
 * Update-lock notices deliberately have no category — see notifyLocked() in
 * bg/update-check.js. They explain why a requested action did nothing at all, so
 * muting them would leave the user with an extension that just appears broken.
 */
const NOTIFY_KEY = {
  complete: 'notifyOnComplete',
  error:    'notifyOnError',
  capture:  'notifyOnCapture',
  schedule: 'notifyOnSchedule',
};
const NOTIFY_DEFAULT = { complete: false, error: true, capture: true, schedule: true };

async function _notifyEnabled(category) {
  const key = NOTIFY_KEY[category];
  if (!key) return true;
  const res = await new Promise((r) => chrome.storage.sync.get([key], r));
  return res[key] === undefined ? NOTIFY_DEFAULT[category] : !!res[key];
}

/**
 * Raise a notification unless its category is muted in Settings.
 *
 * @param {'complete'|'error'|'capture'} category — which Settings toggle gates it
 * @param {string} title
 * @param {string} message
 * @param {string} [id] — stable id. Re-using an id REPLACES the existing
 *   notification instead of stacking a second one, so pass one for anything that
 *   can fire more than once in a single run.
 */
async function _notify(category, title, message, id) {
  if (!(await _notifyEnabled(category))) return;
  chrome.notifications.create(id || `${category}_${Date.now()}`, {
    type: 'basic', iconUrl: _NOTIF_ICON,
    title: title || 'Pocket QA',
    message: message || '',
  }, ignoreLastError);
}

/** A run reached its end normally — playback, sequence, CSV run. */
export function sendCompletionNotification(title, message, id) {
  return _notify('complete', title || 'Playback complete', message, id);
}

/**
 * Something failed, or a request was refused.
 *
 * `id` is close to mandatory here. Playback does not stop at a failed action — it
 * records the failure and continues — so a scenario where 50 actions fail used to
 * raise 50 separate notifications. A stable id collapses them into one entry that
 * updates in place.
 */
export function sendAlertNotification(title, message, id) {
  return _notify('error', title || 'Alert', message, id);
}

/**
 * Result of a capture — where the screenshot was saved, or why it wasn't.
 *
 * Split out from the alert channel because capture results are mostly successes:
 * a user who wants to mute "saved to…" chatter should not have to mute playback
 * failures at the same time.
 */
export function sendCaptureNotification(title, message, id) {
  return _notify('capture', title || 'Screenshot', message, id);
}

/**
 * An alarm-driven run started on its own.
 *
 * Its own category, defaulting to ON, rather than folding into 'complete' (which
 * defaults to OFF): a scheduled run is by definition the case where nobody is
 * watching the browser, so silence is the wrong default even for a user who has
 * muted the notifications for runs they started by hand.
 */
export function sendScheduleNotification(title, message, id) {
  return _notify('schedule', title || 'Scheduled run', message, id);
}
