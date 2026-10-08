/**
 * handlers/recording.js — messages about recording: the recorded-action stream,
 * start/stop, frame registration.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state, persistRecordingState } from '../state.js';
import { getScenarios, setScenarios, getStack, pushUndo, runExclusive } from '../storage.js';
import { updateBadge } from '../badge.js';
import { refuseRecordingIfPlaying } from '../playback.js';
import { ignoreLastError } from '../last-error.js';
import { isAnyPlaybackActive } from '../run-state.js';

// A playback checkpoint younger than this is offered for resume when its tab reloads.
const RESUME_OFFER_WINDOW_MS = 60_000;

/* === RECORDING STATE FAN-OUT === */

/**
 * Tell every content script whether a recording is running.
 *
 * The recorder's click/input listeners in content.js are attached unconditionally
 * on every page and in every frame, so they need to know when to stay quiet.
 * Broadcast to all tabs rather than only state.recordingTabId: a recorded
 * navigation can land the session on a different tab, and a stale "recording"
 * flag left behind in some other tab would keep that tab chattering after the
 * session ends. Tabs with no content script (chrome://, the Web Store) simply
 * reject the message; lastError is read to keep it out of the console.
 */
export function broadcastRecordingState(recording) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const t of tabs || []) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'RECORDING_STATE', recording },
        ignoreLastError);
    }
  });
}

export const recordingHandlers = {
  /* --- Forward recorded actions to popup --- */
  RECORDED_ACTION(request, sender, sendResponse) {
    // Both the store and the forward are gated. content.js now stays silent when
    // no session is running, but a frame injected before the gate existed (or one
    // that missed the RECORDING_STATE broadcast) can still send; re-broadcasting
    // its payload would put page input values on the message bus for no reason.
    if (!state.recording || state.pickMode) { sendResponse({ received: false }); return; }
    const snapshot = [...state.currentActions];
    const act = request.action;
    if (act.delay == null) act.delay = 500;
    state.currentActions.push(act);
    pushUndo("current", snapshot);
    persistRecordingState(); // persist across SW suspend
    chrome.runtime.sendMessage(request).catch(() => {});
    sendResponse({ received: true });
    return;
  },

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
  REGISTER_FRAME(request, sender, sendResponse) {
    // `activated`: whether the record hotkeys act on this tab (content.js keeps
    // the key from the page only there).
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["activatedTabs"], (res) => {
      sendResponse({
        frameId: sender.frameId ?? 0, recording: state.recording,
        activated: tabId != null && (res?.activatedTabs || []).includes(tabId),
      });
    });
    return true;
  },

  /* --- Recording --- */
  START_RECORD(request, sender, sendResponse) {
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
  },

  STOP_RECORD(request, sender, sendResponse) {
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
  },
};
