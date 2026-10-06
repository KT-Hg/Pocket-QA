/**
 * run/resume-banners.js — the banners offering to resume an interrupted CSV run
 * or a playback cut short by a page reload.
 */

import { updateCsvBadges } from '../csv/csv-run.js';
import { setCsvState, startCsvPoll } from '../csv/csv-state.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';

/* === CSV Resume Banner ===
 * The service worker detects a run interrupted by a browser restart or a worker
 * suspend and reports it two ways: a CSV_RUN_INTERRUPTED push (popup already
 * open) and a csvInterrupted field on GET_EXTENSION_STATUS (popup opened later).
 * Both paths existed in the background but nothing in the popup listened, so the
 * offer never reached the user and an interrupted run had to be redone from row 1. */
let _csvPendingResume = null;

let csvResumeBanner;

function _showCsvResumeBanner(pending) {
  if (!csvResumeBanner || !pending) return;
  // Nothing to resume if the run already reached the end.
  const resumeRow = pending.resumeRow ?? 0;
  const total     = pending.totalRows ?? 0;
  if (total <= 0 || resumeRow >= total) return;
  _csvPendingResume = pending;
  const name  = ui.scenariosCache[pending.scenarioId]?.name || pending.scenarioId;
  const msgEl = document.getElementById("csvResumeBannerMsg");
  if (msgEl) {
    msgEl.textContent =
      `CSV run "${name}" was interrupted at row ${resumeRow + 1} of ${total} — resume?`;
  }
  csvResumeBanner.style.display = "flex";
}

function _hideCsvResumeBanner() {
  _csvPendingResume = null;
  if (csvResumeBanner) csvResumeBanner.style.display = "none";
}

/* === Resumable Playback Banner === */
let _resumeCheckpoint = null;

let resumeBanner;

export function initResumeBanners() {
  csvResumeBanner = document.getElementById("csvResumeBanner");
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CSV_RUN_INTERRUPTED") return;
    _showCsvResumeBanner(msg.pending);
  });
  document.getElementById("csvResumeBtn")?.addEventListener("click", () => {
    if (!_csvPendingResume) return;
    const pending = _csvPendingResume;
    _hideCsvResumeBanner();
    chrome.runtime.sendMessage({ type: "RESUME_CSV_PLAYBACK" }, (res) => {
      if (chrome.runtime.lastError || !res?.started) {
        showToast(res?.error || "Could not resume the CSV run", "error");
        return;
      }
      ui._csvRunScenarioName = ui.scenariosCache[pending.scenarioId]?.name || "CSV Run";
      ui._csvDelayBetween    = pending.delayBetween || 500;
      setCsvState('running');
      updateCsvBadges(res.resumedFrom ?? 0, pending.totalRows ?? 0, 0, false);
      startCsvPoll(document.getElementById("csvStatus"));
      showToast(`Resuming from row ${(res.resumedFrom ?? 0) + 1}`, "success");
    });
  });
  document.getElementById("csvResumeDismissBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "DISMISS_CSV_RESUME" });
    _hideCsvResumeBanner();
  });
  // Covers the popup being opened after the worker already sent CSV_RUN_INTERRUPTED.
  chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATUS" }, (status) => {
    if (chrome.runtime.lastError || !status?.csvInterrupted || status.csvPlaying) return;
    _showCsvResumeBanner(status.csvInterrupted);
  });
  resumeBanner = document.getElementById("resumeBanner");
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "OFFER_RESUME") return;
    _resumeCheckpoint = msg.checkpoint;
    const { scenarioId, actionIndex } = msg.checkpoint;
    const name = ui.scenariosCache[scenarioId]?.name || scenarioId;
    document.getElementById("resumeBannerMsg").textContent =
      `Playback interrupted at action #${actionIndex + 1} of "${name}" — resume?`;
    resumeBanner.style.display = "flex";
  });
  document.getElementById("resumeBtn")?.addEventListener("click", () => {
    if (!_resumeCheckpoint) return;
    chrome.runtime.sendMessage({ type: "RESUME_PLAYBACK", ..._resumeCheckpoint });
    resumeBanner.style.display = "none";
    _resumeCheckpoint = null;
  });
  document.getElementById("resumeDismissBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "DISMISS_RESUME" });
    resumeBanner.style.display = "none";
    _resumeCheckpoint = null;
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PLAYBACK_ALREADY_RUNNING') {
      showToast('Playback is already running — stop it before starting a new one', 'error');
    } else if (msg.type === 'PLAYBACK_NO_TAB') {
      showToast('No active tab found — open a tab and try again', 'error');
    } else if (msg.type === 'PLAYBACK_TAB_CLOSED') {
      showToast('Tab was closed — playback stopped', 'error');
    } else if (msg.type === 'PLAYBACK_BLOCKED_RECORDING') {
      showToast('Cannot start playback while recording — stop recording first', 'error');
    } else if (msg.type === 'RECORD_BLOCKED_PLAYBACK') {
      showToast('Cannot start recording while playback is running — stop it first', 'error');
    }
  });
}
