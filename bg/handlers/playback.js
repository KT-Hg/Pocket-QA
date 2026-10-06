/**
 * handlers/playback.js — messages about starting and stopping playback and
 * sequences, resume after a reload, and the status the popup polls.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state } from '../state.js';
import { updateBadge } from '../badge.js';
import { startPlayback, startPlaybackFromCheckpoint, startSequence } from '../playback.js';

export const playbackHandlers = {
  RESUME_PLAYBACK(request, sender, sendResponse) {
    const { scenarioId, actionIndex, tabId } = request;
    chrome.storage.local.remove("playbackCheckpoint");
    startPlaybackFromCheckpoint(scenarioId, actionIndex + 1, tabId);
    sendResponse({ started: true });
    return;
  },

  DISMISS_RESUME(request, sender, sendResponse) {
    chrome.storage.local.remove("playbackCheckpoint");
    sendResponse({ ok: true });
    return;
  },

  /* --- Extension status --- */
  GET_EXTENSION_STATUS(request, sender, sendResponse) {
    sendResponse({
      recording: state.recording,
      recordingScenarioId: state.recordingScenarioId,
      playing: state.playback.active && !state.sequencePlayback.active,
      sequencePlaying: state.sequencePlayback.active,
      csvPlaying: state.csvPlayback.active,
      csvCurrentRow: state.csvPlayback.currentRow,
      csvTotalRows: state.csvPlayback.rows.length,
      csvScenarioName: state.csvPlayback.active ? (state.playback.scenarioName || null) : null,
      actionIndex: state.playback.actionIndex,
      totalActions: state.playback.totalActions,
      loopCurrent: state.playback.loopCurrent || 1,
      loopTotal: state.playback.loopTotal || 1,
      scenarioName: state.playback.scenarioName || null,
      originalScenarioName: state.playback.originalScenarioName || null,
      currentScenarioIndex: state.sequencePlayback.currentIndex,
      totalScenarios: state.sequencePlayback.runList.length,
      csvInterrupted: state.csvInterrupted,
    });
    return;
  },

  /* --- Playback dispatch --- */
  START_PLAYBACK_SCENARIO(request, sender, sendResponse) {
    startPlayback(request.scenarioId, request.loopCount || 1, request.loopDelay || 0);
    sendResponse({ started: true });
    return;
  },

  STOP_PLAYBACK(request, sender, sendResponse) {
    state.playback.active = false;
    state.csvPlayback.active = false;
    state.sequencePlayback.active = false;
    updateBadge();
    sendResponse({ stopped: true });
    return;
  },

  START_SEQUENCE_PLAYBACK(request, sender, sendResponse) {
    startSequence(request.runList);
    sendResponse({ started: true });
    return;
  },

  STOP_SEQUENCE_PLAYBACK(request, sender, sendResponse) {
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
    sendResponse({ stopped: true });
    return;
  },
};
