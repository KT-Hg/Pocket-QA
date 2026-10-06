/**
 * background.js — Service Worker (ES module entry point).
 *
 * Start-up and wiring only; the work is in bg/:
 *   - bg/router.js + bg/handlers/*  the chrome.runtime.onMessage handler
 *   - bg/schedule-alarms.js          per-schedule alarms
 *   - bg/update-check.js             the daily update check and update lock
 *
 * The imports below keep the load order the worker's modules have always had.
 * Some act when they load: bg/cdp/session.js registers a tabs.onRemoved listener,
 * bg/storage.js restores the undo stacks, bg/screenshot.js and
 * bg/screenshot/window.js register onMessage listeners — and listener order is
 * dispatch order. Imports without names are there only for that order.
 */

import { state, restoreRecordingState, restoreCsvState } from './bg/state.js';
import './bg/cdp/session.js';
import './bg/storage.js';
import { updateBadge } from './bg/badge.js';
import './bg/playback.js';
import './shared/switch-blocks.js';
import './bg/screenshot.js';
import './bg/idb-screenshots.js';
// Side-effect import: registers the window-capture listener.
import './bg/screenshot/window.js';
import { serveSnapshots } from './dbtools/snapstore.js';
import './bg/last-error.js';
import {
  UPDATE_ALARM, AUTO_APPLY_ALARM, runUpdateCheck, ensureUpdateAlarm, scheduleCatchUpCheck,
  initUpdateAvailableListener, markInstalledVersion,
  reconcileUpdateState, initLockWatcher,
  setBusyProbe, maybeAutoApply,
} from './bg/update-check.js';
import { reregisterScheduleAlarms, runScheduleAlarm } from './bg/schedule-alarms.js';
import { routeMessage } from './bg/router.js';
import { broadcastRecordingState } from './bg/handlers/recording.js';
import { notifyCsvInterruptedOnce } from './bg/handlers/csv.js';
import { openDbtoolsManager } from './bg/handlers/dbtools.js';
import { isAnyPlaybackActive, isBusy } from './bg/run-state.js';
import { KEEPALIVE_ALARM, KEEPALIVE_MS } from './bg/playback/keepalive.js';

// DB Test Session snapshots live in this origin's IndexedDB; the Adminer panel is
// a content script and reads and writes them through here.
serveSnapshots();

// Set defaults on first install only — do not overwrite user settings on extension update.
chrome.runtime.onInstalled.addListener((details) => {
  // Restart the 30-day update clock. Runs on "install" too, so a fresh install
  // isn't judged against a deadline it was never around for.
  if (details?.reason === 'install' || details?.reason === 'update') markInstalledVersion();

  chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
    const defaults = {};
    if (res.screenshotCountdownEnabled === undefined) defaults.screenshotCountdownEnabled = true;
    if (res.screenshotCountdownSeconds === undefined) defaults.screenshotCountdownSeconds = 3;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

// On SW startup: re-register alarms that were cleared when the SW was terminated.
reregisterScheduleAlarms();

// Daily Web Store version check + update-lock bookkeeping (see bg/update-check.js).
// The busy probe must be set before anything can decide to auto-apply an update:
// chrome.runtime.reload() takes the recording/playback down with the worker.
setBusyProbe(isBusy);
ensureUpdateAlarm();
scheduleCatchUpCheck();
initUpdateAvailableListener();
initLockWatcher();
reconcileUpdateState();

// Restore an in-progress recording if the SW was suspended mid-session.
// The re-broadcast covers content scripts that loaded while the worker was down
// and got `recording: false` from REGISTER_FRAME.
restoreRecordingState().then(() => {
  if (state.recording) { updateBadge(); broadcastRecordingState(true); }
});

// Detect an interrupted CSV run and cache it so the popup can offer resume.
restoreCsvState().then((csvPending) => {
  if (!csvPending) return;
  state.csvInterrupted = {
    scenarioId:   csvPending.scenarioId,
    totalRows:    csvPending.rows?.length ?? 0,
    resumeRow:    csvPending.currentRow ?? 0,
    delayBetween: csvPending.delayBetween,
    exportFormat: csvPending.exportFormat,
  };
  chrome.runtime.sendMessage({
    type: 'CSV_RUN_INTERRUPTED',
    pending: state.csvInterrupted,
  }).catch(() => {});
  // The message above only reaches an open popup, and this code runs on service
  // worker startup — i.e. the worker died mid-run, most likely while the user was
  // doing something else entirely. Without a notification the run simply stops
  // and the badge clears, which is indistinguishable from a run that finished.
  //
  // Announced once per interrupted run, not once per worker spawn: the worker is
  // torn down and revived constantly (every popup open, every hotkey), and the
  // checkpoint survives all of it, so an unguarded call would re-alert all day
  // until the user got round to resuming. The checkpoint's own timestamp
  // identifies the run, and session storage has exactly the right lifetime —
  // it is cleared when the browser closes, as is the checkpoint itself.
  notifyCsvInterruptedOnce(csvPending.timestamp);
}).catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Renew the playback keep-alive alarm while any playback is still running.
  if (alarm.name === KEEPALIVE_ALARM) {
    if (isAnyPlaybackActive()) {
      chrome.alarms.create(KEEPALIVE_ALARM, { when: Date.now() + KEEPALIVE_MS });
    }
    return;
  }
  if (alarm.name === UPDATE_ALARM) { runUpdateCheck(); return; }
  // A critical update whose install was postponed because a run was in progress.
  if (alarm.name === AUTO_APPLY_ALARM) { maybeAutoApply(); return; }
  runScheduleAlarm(alarm);
});

/* === MESSAGES (bg/router.js, bg/handlers/) === */

chrome.runtime.onMessage.addListener(routeMessage);

// DB tools: a separate listener, outside the router's lock handling (bg/handlers/dbtools.js).
chrome.runtime.onMessage.addListener(openDbtoolsManager);
