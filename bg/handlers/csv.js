/**
 * handlers/csv.js — messages about CSV data-driven runs: start, resume, stop,
 * status and results.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state, restoreCsvState, clearCsvState } from '../state.js';
import { updateBadge } from '../badge.js';
import { sendAlertNotification } from '../notify.js';
import { startCsvPlayback } from '../playback.js';
import { ssReadAll, ssClear, csvResultReadAll, csvResultClear } from '../idb-screenshots.js';

/**
 * Raise the "run interrupted" notification unless this exact run has already
 * been announced in this browser session.
 *
 * @param {number} runStamp — csv_pending.timestamp, stable for one interrupted run
 */
export async function notifyCsvInterruptedOnce(runStamp) {
  if (!chrome.storage?.session) return; // < Chrome 102: no checkpoint to speak of
  try {
    const res = await chrome.storage.session.get(['csvInterruptNotified']);
    if (res?.csvInterruptNotified === runStamp) return;
    await chrome.storage.session.set({ csvInterruptNotified: runStamp });
  } catch (_) {
    return; // cannot dedupe — better silent than repeating on every wake
  }
  const resumeAt = (state.csvInterrupted.resumeRow ?? 0) + 1;
  sendAlertNotification(
    '⚠ CSV Run Interrupted',
    `Stopped at row ${resumeAt} of ${state.csvInterrupted.totalRows} — open the popup to resume`,
    'csv_interrupted',
  );
}

export const csvHandlers = {
  /* --- CSV Playback --- */
  START_CSV_PLAYBACK(request, sender, sendResponse) {
    state.csvInterrupted = null;
    startCsvPlayback(request.scenarioId, request.rows, request.delayBetween || 500, request.exportFormat || "csv");
    sendResponse({ started: true });
    return;
  },

  // Resume an interrupted CSV run from the last persisted checkpoint.
  // The full rows array is reloaded from local storage (not session) because it
  // may exceed the session-storage quota.  startRowIndex is passed to
  // startCsvPlayback so result records keep their original row indices.
  RESUME_CSV_PLAYBACK(request, sender, sendResponse) {
    restoreCsvState().then((csvPending) => {
      if (!csvPending) { sendResponse({ error: 'No pending CSV state' }); return; }
      const { scenarioId, rows, currentRow, delayBetween, exportFormat } = csvPending;
      state.csvInterrupted = null;
      startCsvPlayback(scenarioId, rows, delayBetween || 500, exportFormat || 'csv', currentRow);
      sendResponse({ started: true, resumedFrom: currentRow });
    });
    return true;
  },

  DISMISS_CSV_RESUME(request, sender, sendResponse) {
    state.csvInterrupted = null;
    clearCsvState().catch(() => {});
    sendResponse({ ok: true });
    return;
  },

  // Hard stop: abandons the row in flight, so its result is never written.
  STOP_CSV_PLAYBACK(request, sender, sendResponse) {
    state.csvPlayback.active = false;
    state.csvPlayback.stopAfterRow = false;
    state.playback.active = false;
    updateBadge();
    // Discard the checkpoint so a user-stopped run is never offered as resumable.
    clearCsvState().catch(() => {});
    sendResponse({ stopped: true });
    return;
  },

  // Graceful stop: let the current row finish and be recorded, then end the run.
  // Previously the "After row" button sent STOP_CSV_PLAYBACK too, so it behaved
  // identically to "Now" and silently dropped the row that was mid-flight.
  STOP_CSV_AFTER_ROW(request, sender, sendResponse) {
    if (!state.csvPlayback.active) { sendResponse({ pending: false, alreadyStopped: true }); return; }
    state.csvPlayback.stopAfterRow = true;
    sendResponse({ pending: true, currentRow: state.csvPlayback.currentRow });
    return;
  },

  GET_CSV_STATUS(request, sender, sendResponse) {
    sendResponse({
      active: state.csvPlayback.active,
      currentRow: state.csvPlayback.currentRow,
      totalRows: state.csvPlayback.rows.length,
    });
    return;
  },

  GET_CSV_RUN_RESULTS(request, sender, sendResponse) {
    csvResultReadAll()
      .then(results => sendResponse({ results }))
      .catch(e => { console.error('[CSV] IDB read failed:', e); sendResponse({ results: [] }); });
    return true;
  },

  GET_CSV_SCREENSHOTS(request, sender, sendResponse) {
    ssReadAll()
      .then(screenshots => {
        chrome.storage.local.get('csvSsVarOrder', res => {
          sendResponse({ screenshots, ssVarOrder: res.csvSsVarOrder || [] });
        });
      })
      .catch(e => { console.error('[CSV] IDB read failed:', e); sendResponse({ screenshots: {}, ssVarOrder: [] }); });
    return true;
  },

  CLEAR_CSV_SCREENSHOTS(request, sender, sendResponse) {
    ssClear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  },

  CLEAR_CSV_RESULTS(request, sender, sendResponse) {
    csvResultClear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  },
};
