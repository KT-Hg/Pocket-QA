/**
 * handlers/recording.js — messages about recording: the recorded-action stream,
 * start/stop, frame registration.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state, persistRecordingState, recordingRestored, restoreRecordingState } from '../state.js';
import { getScenarios, setScenarios, getStack, pushUndo, runExclusive } from '../storage.js';
import { updateBadge } from '../badge.js';
import { refuseRecordingIfPlaying } from '../playback.js';
import { ignoreLastError } from '../last-error.js';
import { isAnyPlaybackActive } from '../run-state.js';
import { fromExtensionPage } from '../sender.js';
import { SELECTOR_KEYS } from '../../shared/var-name.js';

// A playback checkpoint younger than this is offered for resume when its tab reloads.
const RESUME_OFFER_WINDOW_MS = 60_000;

/* === RECORDING STATE FAN-OUT === */

/**
 * Whether a recording takes actions from this tab: only from the one it was
 * started on. Playback plays a scenario in one tab, and typing in any other tab
 * (a password on another site, say) went into the scenario being recorded.
 * A recording restored from before the tab was saved has none, and takes any tab.
 */
function _recordsTab(tabId) {
  return state.recording && (state.recordingTabId == null || tabId === state.recordingTabId);
}

// What content.js records, and the fields of it a page may send.
const RECORDED_TYPES = new Set(['click', 'input']);
const RECORDED_SELECTOR_KEYS = [...SELECTOR_KEYS, 'textTag'];

/**
 * A recorded action as a web page's content script may send it: a click or an
 * input, with the fields content.js records and nothing else; null for anything
 * else. A compromised renderer could otherwise put any action into the scenario
 * being recorded — an Upload File handing a local file to the page, a Script —
 * to run on the next Play. The frame is the one Chrome says sent it.
 */
function _recordedFromPage(action, sender) {
  if (!action || !RECORDED_TYPES.has(action.type)) return null;
  const out = { type: action.type };
  if (typeof action.selector === 'string') out.selector = action.selector;
  if (action.selectors && typeof action.selectors === 'object') {
    out.selectors = {};
    for (const k of RECORDED_SELECTOR_KEYS) {
      if (typeof action.selectors[k] === 'string') out.selectors[k] = action.selectors[k];
    }
  }
  if (action.type === 'input' && typeof action.value === 'string') out.value = action.value;
  out.frameId = sender.frameId ?? 0;
  return out;
}

/**
 * Tell every content script whether to record: the recording tab that it should,
 * every other tab that it should not.
 *
 * The recorder's click/input listeners in content.js are attached unconditionally
 * on every page and in every frame, so they need to know when to stay quiet.
 * Every tab is told, so a stale "recording" flag left behind in one cannot keep it
 * chattering. Tabs with no content script (chrome://, the Web Store) simply
 * reject the message; lastError is read to keep it out of the console.
 */
export function broadcastRecordingState(recording) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const t of tabs || []) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'RECORDING_STATE', recording: recording && _recordsTab(t.id) },
        ignoreLastError);
    }
  });
}

/**
 * A handler that reads or changes the recording, run once the recording saved
 * before a worker restart is back (restoreRecordingState). The message that wakes
 * the worker — the first click after a pause, the popup's Stop — is dispatched
 * before session storage has been read: handled at once, the click was dropped,
 * and Stop saved nothing while the restore then started the recording again.
 * After start-up it runs at once and returns what the handler returns.
 */
function _afterRestore(handler) {
  return (request, sender, sendResponse) => {
    if (recordingRestored()) return handler(request, sender, sendResponse);
    restoreRecordingState().then(() => handler(request, sender, sendResponse));
    return true;
  };
}

export const recordingHandlers = {
  /* --- Forward recorded actions to popup --- */
  RECORDED_ACTION: _afterRestore((request, sender, sendResponse) => {
    // Both the store and the forward are gated. content.js now stays silent when
    // no session is running, but a frame injected before the gate existed (or one
    // that missed the RECORDING_STATE broadcast) can still send; re-broadcasting
    // its payload would put page input values on the message bus for no reason.
    if (!_recordsTab(sender.tab?.id) || state.pickMode) { sendResponse({ received: false }); return; }
    const act = fromExtensionPage(sender) ? request.action : _recordedFromPage(request.action, sender);
    if (!act) { sendResponse({ received: false }); return; }
    const snapshot = [...state.currentActions];
    if (act.delay == null) act.delay = 500;
    state.currentActions.push(act);
    pushUndo("current", snapshot);
    persistRecordingState(); // persist across SW suspend
    chrome.runtime.sendMessage({ type: 'RECORDED_ACTION', action: act }).catch(() => {});
    sendResponse({ received: true });
    return;
  }),

  CONTENT_READY(request, sender, sendResponse) {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["playbackCheckpoint"], ({ playbackCheckpoint: cp }) => {
      // If a playback checkpoint exists for this tab and is less than 60 s old,
      // the page likely reloaded mid-playback — offer to resume from the last step.
      // Do NOT offer single-scenario resume when a CSV run is active: CSV has its
      // own resume mechanism and startPlaybackFromCheckpoint would run outside CSV
      // context (forceAutoSave=false, skipDownload=false), causing screenshot
      // save-as dialogs and skipping IDB accumulation for the zip.
      // Nor while any run is still live: a page that loads mid-run (a navigate
      // action, a reload under the failed-action prompt) was not interrupted, and
      // the banner used to offer to "resume" a run that had never stopped.
      const live = isAnyPlaybackActive();
      if (cp && tabId === cp.tabId && Date.now() - cp.timestamp < RESUME_OFFER_WINDOW_MS && !live) {
        chrome.runtime.sendMessage({ type: "OFFER_RESUME", checkpoint: cp }).catch(() => {});
      }
    });
    sendResponse({ received: true });
    return;
  },

  // Content script needs its own frameId to tag recorded actions for correct
  // iframe targeting during playback.  sender.frameId is only available on the
  // background side; content scripts cannot access it directly.
  // `recording` rides along so a script injected mid-session (tab activation,
  // reconnect after a crash) starts gated correctly instead of waiting for the
  // next RECORDING_STATE broadcast.
  REGISTER_FRAME: _afterRestore((request, sender, sendResponse) => {
    // `activated`: whether the record hotkeys act on this tab (content.js keeps
    // the key from the page only there).
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["activatedTabs"], (res) => {
      sendResponse({
        frameId: sender.frameId ?? 0, recording: _recordsTab(tabId),
        activated: tabId != null && (res?.activatedTabs || []).includes(tabId),
      });
    });
    return true;
  }),

  /* --- Recording --- */
  START_RECORD: _afterRestore((request, sender, sendResponse) => {
    if (refuseRecordingIfPlaying()) {
      sendResponse({ started: false, error: 'Cannot start recording while playback is active' });
      return;
    }
    const tabId = request.tabId || sender.tab?.id || null;
    const startRecording = (scenarioId) => {
      state.recording = true;
      state.recordingTabId = tabId;
      state.recordingScenarioId = scenarioId || null;
      state.currentActions = [];
      getStack("current").undo = [];
      getStack("current").redo = [];
      // Saved now, not with the first action: the worker sleeps after 30 s with
      // nothing to do, and a user who looks at the page that long before the first
      // click came back to a worker that had forgotten the recording.
      persistRecordingState();
      updateBadge();
      broadcastRecordingState(true);
      sendResponse({ started: true });
    };
    if (request.scenarioId) {
      startRecording(request.scenarioId);
    } else {
      // Hotkey-triggered recording: no scenarioId in request, so we fall back to
      // the last selected scenario from the popup (async storage read).
      chrome.storage.local.get(["lastSelectedScenario"], (res) => {
        startRecording(res?.lastSelectedScenario || null);
      });
      return true;
    }
    return;
  }),

  STOP_RECORD: _afterRestore((request, sender, sendResponse) => {
    state.recording = false;
    const sid = state.recordingScenarioId;
    state.recordingScenarioId = null;
    updateBadge();
    broadcastRecordingState(false);
    // Remove session-storage snapshot — persisted only to survive SW suspend
    // during recording, no longer needed after stop.
    chrome.storage.session?.remove?.(['rec_recording','rec_scenarioId','rec_tabId','rec_actions','rec_timestamp'], () => {});
    if (sid) {
      const newActions = [...state.currentActions];
      state.currentActions = [];
      runExclusive(async () => {
        const scenarios = await getScenarios();
        if (scenarios[sid]) {
          const existing = scenarios[sid].actions || [];
          pushUndo(sid, [...existing]);
          scenarios[sid].actions = [...existing, ...newActions];
          await setScenarios(scenarios);
          chrome.storage.local.set({ pendingRecordScenarioId: sid });
          sendResponse({ actions: scenarios[sid].actions, scenarioId: sid });
        } else {
          sendResponse({ actions: newActions });
        }
      });
      return true;
    }
    sendResponse({ actions: state.currentActions });
    return;
  }),
};
