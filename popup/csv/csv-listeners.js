/**
 * csv/csv-listeners.js — live progress of a CSV run, from the service worker's
 * row / done / error messages.
 */

import { setCsvDoneBar } from '../connection.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';
import { startCsvCountdown, stopCsvCountdown, updateCsvBadges } from './csv-run.js';
import { setCsvState } from './csv-state.js';

export function initCsvListeners() {
  /* === CSV realtime message listeners === */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CSV_ROW_DONE") return;
    stopCsvCountdown();
    const csvRow = msg.rowIndex + 1, csvTotal = msg.total;
    updateCsvBadges(csvRow, csvTotal, msg.failRows ?? 0, false);
    if (!msg.isLast) startCsvCountdown(msg.delayBetween ?? ui._csvDelayBetween);
    const stepEl = document.getElementById('nowPlayingStep');
    if (stepEl) stepEl.textContent = `Row Done ${csvRow}/${csvTotal}`;
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CSV_RUN_DONE") return;
    const failRows = msg.failRows ?? 0;
    updateCsvBadges(msg.total, msg.total, failRows, true);
    setCsvState('done');
    const name    = msg.scenarioName || ui._csvRunScenarioName || "CSV Run";
    const summary = failRows > 0
      ? `✓ ${msg.total - failRows} · ✗ ${failRows} of ${msg.total}`
      : `✓ ${msg.total} rows done`;
    setCsvDoneBar(name, summary);
  });
  // A run that died on an exception. Without this the card would stay stuck in the
  // 'running' skin — Start disabled, Download hidden — with nothing explaining why.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CSV_RUN_ERROR") return;
    stopCsvCountdown();
    const total = msg.total ?? 0;
    // Rows written before the throw are still in IndexedDB, so offer the download.
    updateCsvBadges(total, total, msg.failRows ?? 0, true);
    setCsvState(total > 0 ? 'done' : 'idle');
    const statusEl = document.getElementById("csvStatus");
    if (statusEl) statusEl.textContent = `Run failed after ${total} row(s) — ${msg.error || 'unknown error'}`;
    showToast(`CSV run failed: ${msg.error || 'unknown error'}`, "error");
  });
}
