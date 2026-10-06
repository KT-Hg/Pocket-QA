/**
 * playback/failure-prompt.js — what happens when an action fails: the prompt in the page
 * (retry / skip / stop), the record of the failure, the notification.
 */

import { state } from '../state.js';
import { updateBadge } from '../badge.js';
import { sendAlertNotification } from '../notify.js';
import { tabMsg, waitForTabLoad } from '../tabs.js';

// How often an open prompt checks whether the run was stopped elsewhere.
const STOP_POLL_MS = 250;
// Times the prompt is shown before playback gives up asking.
const PROMPT_ATTEMPTS = 3;
// Closing the prompt after an outside stop: how long the page gets to answer.
const PROMPT_CLOSE_TIMEOUT_MS = 2_000;
// Between attempts: how long a reloading page gets, then content.js to register.
const RELOAD_WAIT_MS = 10_000;
const CONTENT_SCRIPT_SETTLE_MS = 300;

export function notifyActionFailed(index, action, reason, { toPopup = true } = {}) {
  const r = reason || 'element not found';
  if (toPopup) chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index, action, reason: r }).catch(() => {});
  if (!state.csvPlayback.active) {
    const label = action?.label || action?.type || '';
    // Stable id: playback continues past a failed action, so without one a run
    // with many failures buries the notification centre under a separate entry
    // per action. Re-using the id keeps a single, always-current "latest failure".
    sendAlertNotification(
      `⚠ Action ${index + 1} Failed`,
      label ? `${label}: ${r}` : r,
      'action_failed',
    );
  }
}

/* ── Failed-action prompt ───────────────────────────────────────────────────────
 * A failed action pauses the run and asks, in a popup on the page being played,
 * whether to run it again, skip it or stop. The content script holds the message
 * open until a button is clicked, so the answer comes back as its response.
 * ────────────────────────────────────────────────────────────────────────────── */

export const FAIL_RETRY = 'retry';
export const FAIL_SKIP  = 'skip';
export const FAIL_STOP  = 'stop';

/** One attempt at showing the prompt: resolves to { choice } or { error }. */
function _promptInPage(tabId, info) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(res);
    };
    // A stop from the popup or a hotkey, or the tab closing, ends the run while
    // the prompt is still up; the loop must not keep waiting for a click then.
    const poll = setInterval(() => {
      if (!state.playback.active) settle({ choice: FAIL_STOP, external: true });
    }, STOP_POLL_MS);
    chrome.tabs.sendMessage(tabId, { type: 'ACTION_FAILED_PROMPT', ...info }, { frameId: 0 }, (res) => {
      const err = chrome.runtime.lastError?.message;
      settle(err || !res?.choice ? { error: err || 'no answer' } : { choice: res.choice });
    });
  });
}

/**
 * Pause on a failed action until the user picks retry / skip / stop in the page.
 * Returns null when no page could show the prompt (restricted URL, no content
 * script), and the caller falls back to notifying and moving on.
 */
async function _askOnFailure(tabId, info) {
  state.playback.failPrompt = true;
  updateBadge();
  try {
    // Several tries: the failure is often the page being between documents, and
    // a reload under an open prompt drops it — both are shown again once the new
    // document has loaded.
    for (let attempt = 0; attempt < PROMPT_ATTEMPTS && state.playback.active; attempt++) {
      const res = await _promptInPage(tabId, info);
      if (res.choice) {
        if (res.external) tabMsg(tabId, { type: 'ACTION_FAILED_PROMPT_CLOSE' }, PROMPT_CLOSE_TIMEOUT_MS);
        return res.choice;
      }
      await waitForTabLoad(tabId, RELOAD_WAIT_MS);
      await new Promise(r => setTimeout(r, CONTENT_SCRIPT_SETTLE_MS)); // let content.js register
    }
    return state.playback.active ? null : FAIL_STOP;
  } finally {
    state.playback.failPrompt = false;
    updateBadge();
  }
}

/**
 * Every failed action goes through here. Retry leaves nothing behind; skip and
 * stop record the failure, and stop ends the run the way STOP_PLAYBACK does.
 */
export async function onActionFailed({ tabId, i, actions, action, reason, failedActions, record = reason }) {
  const r = reason || 'element not found';
  chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason: r }).catch(() => {});

  const csv = state.csvPlayback.active;
  const choice = await _askOnFailure(tabId, {
    index: i, total: actions.length, reason: r,
    actionType: action?.type || '', label: action?.label || '',
    scenarioName: state.playback.scenarioName || '',
    row: csv ? state.csvPlayback.currentRow + 1 : null,
    rows: csv ? state.csvPlayback.rows?.length || 0 : null,
  });

  if (choice === FAIL_RETRY) return FAIL_RETRY;
  if (!choice) notifyActionFailed(i, action, r, { toPopup: false });
  if (failedActions) {
    failedActions.push({ index: i + 1, type: action?.type || 'unknown', label: action?.label || '', reason: record || r });
  }
  if (choice === FAIL_STOP) {
    state.playback.active         = false;
    state.sequencePlayback.active = false;
    state.csvPlayback.active      = false;
    updateBadge();
    return FAIL_STOP;
  }
  return FAIL_SKIP;
}
