/**
 * playback/failure-prompt.js — what happens when an action fails: the prompt in the page
 * (retry / skip / stop), the record of the failure, the notification.
 */

import { state } from '../state.js';
import { updateBadge } from '../badge.js';
import { sendAlertNotification } from '../notify.js';
import { ignoreLastError } from '../last-error.js';
import { loadOverlays, tabMsg, waitForTabLoad } from '../tabs.js';
import { markStopped } from '../run-state.js';
import { canPick, pickForRun, pickedName, savePicked, withPicked } from './run-pick.js';
import { selectorStrings } from '../../shared/var-name.js';

// How often an open prompt checks whether the run was stopped elsewhere.
const STOP_POLL_MS = 250;
// Times the prompt is shown before playback gives up asking.
const PROMPT_ATTEMPTS = 3;
// Closing the prompt after an outside stop: how long the page gets to answer.
const PROMPT_CLOSE_TIMEOUT_MS = 2_000;
// Between attempts: how long a reloading page gets, then content.js to register.
const RELOAD_WAIT_MS = 10_000;
const CONTENT_SCRIPT_SETTLE_MS = 300;

// ' in "Checkout"': a step of another scenario a Switch played; its number is that one's.
const _in = (scenarioName) => (scenarioName ? ` in "${scenarioName}"` : '');

export function notifyActionFailed(index, action, reason, { toPopup = true, scenarioName = '' } = {}) {
  const r = reason || 'element not found';
  if (toPopup) chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index, action, reason: r, ...(scenarioName ? { scenarioName } : {}) }).catch(() => {});
  if (!state.csvPlayback.active) {
    const label = action?.label || action?.type || '';
    // Stable id: playback continues past a failed action, so without one a run
    // with many failures buries the notification centre under a separate entry
    // per action. Re-using the id keeps a single, always-current "latest failure".
    sendAlertNotification(
      `⚠ Action ${index + 1}${_in(scenarioName)} Failed`,
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
// 🎯 Pick it (run-pick.js): pick the element, then use it — saved, or for this run only.
const FAIL_PICK = 'pick';
const PICK_SAVE = 'pickSave';
const PICK_ONCE = 'pickOnce';

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
    // The prompt is content-overlays.js's, which the page gets only now.
    loadOverlays(tabId).then(() => chrome.tabs.sendMessage(tabId, { type: 'ACTION_FAILED_PROMPT', ...info }, { frameId: 0 }, (res) => {
      const err = chrome.runtime.lastError?.message;
      settle(err || !res?.choice ? { error: err || 'no answer' } : { choice: res.choice });
    }));
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
 * 🎯 Pick it: the user clicks the element on the page, then answers Save & go on,
 * This run only, Pick again or Cancel. Used (either way): the run's step `i` has
 * the picked locators, the run keeps a note of it (state.playback.picks, for the
 * Last run card) — true, and the step is played again. `otherId`: the scenario a
 * Switch went into that the step belongs to; none: the one played.
 */
async function _pickAndUse(tabId, i, actions, info, otherId) {
  const scenarioId = otherId || state.playback.scenarioId || null;
  for (;;) {
    const picked = await pickForRun(tabId, i);
    if (!picked || !state.playback.active) return false;
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_ELEMENT', mode: 'flash', selectors: picked.selectors, selector: picked.selectors.css },
      { frameId: picked.frameId }, ignoreLastError);
    const hasVars = selectorStrings(actions[i]).some((s) => s.includes('${'));
    const answer = await _askOnFailure(tabId, {
      ...info,
      confirmPick: {
        picked: pickedName(picked), canSave: !!scenarioId,
        note: hasVars ? "The ${…} in the step's locators goes: the new ones are the picked element's, as they are now." : '',
      },
    });
    if (answer === FAIL_PICK) continue;
    if (answer !== PICK_SAVE && answer !== PICK_ONCE) return false;
    const was = actions[i];
    const saved = answer === PICK_SAVE && await savePicked(scenarioId, i, was, picked);
    actions[i] = withPicked(was, picked);
    (state.playback.picks ||= []).push({
      index: i + 1, type: was.type, label: was.label || '', picked: pickedName(picked), saved,
      ...(answer === PICK_SAVE && !saved ? { notSaved: true } : {}), ...(otherId ? { scenarioId: otherId } : {}),
    });
    if (answer === PICK_SAVE && !saved) {
      sendAlertNotification(`⚠ Action ${i + 1} not saved`, 'The step changed since the run started — the picked element is used for this run only', 'action_pick');
    }
    return true;
  }
}

/**
 * A failure the run goes on past without asking — a false Assert. `facts` adds
 * to the record: `kind` (shared/verdict.js), what was expected and found.
 */
export function recordFailure({ i, action, reason, failedActions, facts = {} }) {
  notifyActionFailed(i, action, reason, { scenarioName: facts.scenarioName });
  failedActions?.push({ index: i + 1, type: action?.type || 'unknown', label: action?.label || '', reason, ...facts });
}

/**
 * Every failed action goes through here. Retry leaves nothing behind; skip and
 * stop record the failure, and stop ends the run the way STOP_PLAYBACK does.
 */
export async function onActionFailed({ tabId, i, actions, action, reason, failedActions, record = reason, facts = {} }) {
  const r = reason || 'element not found';
  const scenarioName = facts.scenarioName || '';
  chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason: r, ...(scenarioName ? { scenarioName } : {}) }).catch(() => {});
  // The run now waits for a click in the page, for as long as it takes. Without
  // this, a run nobody is watching (a scheduled one, a tab in another window)
  // sat paused with no sign anywhere. Same id as the other failure notices, and
  // sent in CSV runs too: a paused run is no longer one alert per failed row.
  // Awaited, so the clear below can never overtake it (a prompt can end at once).
  const label = action?.label || action?.type || '';
  await sendAlertNotification(
    `⚠ Action ${i + 1}${_in(scenarioName)} failed — run paused`,
    `${label ? `${label}: ` : ''}${r} — Retry, Skip or Stop on the page`,
    'action_failed',
  );

  const csv = state.csvPlayback.active;
  const info = {
    index: i, total: actions.length, reason: r,
    actionType: action?.type || '', label: action?.label || '',
    scenarioName: scenarioName || state.playback.scenarioName || '',
    row: csv ? state.csvPlayback.currentRow + 1 : null,
    rows: csv ? state.csvPlayback.rows?.length || 0 : null,
    canPick: canPick(actions?.[i]),
  };
  let choice;
  for (;;) {
    choice = await _askOnFailure(tabId, info);
    if (choice !== FAIL_PICK) break;
    if (await _pickAndUse(tabId, i, actions, info, facts.scenarioId || null)) { choice = FAIL_RETRY; break; }
  }

  // "Run paused" is no longer true: answered, or no page could ask and the run
  // goes on (outside a CSV run, notifyActionFailed below says so instead).
  chrome.notifications.clear('action_failed', ignoreLastError);
  if (choice === FAIL_RETRY) return FAIL_RETRY;
  if (!choice) notifyActionFailed(i, action, r, { toPopup: false, scenarioName });
  if (failedActions) {
    failedActions.push({ index: i + 1, type: action?.type || 'unknown', label: action?.label || '', reason: record || r, ...facts });
  }
  if (choice === FAIL_STOP) {
    state.playback.active         = false;
    state.sequencePlayback.active = false;
    state.csvPlayback.active      = false;
    markStopped();
    updateBadge();
    return FAIL_STOP;
  }
  return FAIL_SKIP;
}
