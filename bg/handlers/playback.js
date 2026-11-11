/**
 * handlers/playback.js — messages about starting and stopping playback and
 * sequences, resume after a reload, and the status the popup polls.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state, clearCsvState } from '../state.js';
import { updateBadge } from '../badge.js';
import { fromExtensionPage } from '../sender.js';
import { startPlayback, startPlaybackFromCheckpoint, startSequence } from '../playback.js';
import { runPanelState } from '../run-panel.js';

export const playbackHandlers = {
  // The popup was opened: the last run's verdict is on its Last run card now,
  // so the badge stops telling it (state.runVerdict, bg/badge.js).
  CLEAR_RUN_VERDICT(request, sender, sendResponse) {
    state.runVerdict = null;
    updateBadge();
    sendResponse({ ok: true });
    return;
  },

  RESUME_PLAYBACK(request, sender, sendResponse) {
    const { scenarioId, actionIndex, tabId, nested } = request;
    chrome.storage.local.remove("playbackCheckpoint");
    startPlaybackFromCheckpoint(scenarioId, actionIndex + 1, tabId, Array.isArray(nested) ? nested : null);
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
      run: runPanelState(), // the run line: in the page panel's words
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

  /**
   * The run panel's ■ Stop (content.js RUN PANEL): the whole run ends, as the
   * popup's Stop does — a scenario, a sequence or a CSV run (its checkpoint
   * dropped, as STOP_CSV_PLAYBACK does). From a web page, only the run playing
   * on that page.
   */
  STOP_RUN(request, sender, sendResponse) {
    if (!fromExtensionPage(sender) && sender.tab?.id !== state.playback.tabId) { sendResponse({ stopped: false }); return; }
    const wasCsv = state.csvPlayback.active;
    state.playback.active = false;
    state.sequencePlayback.active = false;
    state.csvPlayback.active = false;
    state.csvPlayback.stopAfterRow = false;
    if (wasCsv) clearCsvState().catch(() => {});
    updateBadge();
    sendResponse({ stopped: true });
    return;
  },
};
