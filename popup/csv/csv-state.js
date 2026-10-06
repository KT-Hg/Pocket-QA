/**
 * csv/csv-state.js — the CSV card's states (idle / running / done), starting and
 * stopping a run, polling its progress.
 */

import { clearCsvDoneBar, openPbPanel, setCsvDoneBar } from '../connection.js';
import { ui } from '../ui-state.js';
import { showConfirm, showToast } from '../utils.js';
import { getInputVarsFromScenario, stopCsvCountdown, updateCsvBadges } from './csv-run.js';

/* === CSV state machine: 'idle' | 'running' | 'done' === */
export function setCsvState(s) {
  const formatSel    = document.getElementById("csvExportFormat");
  const formatLocked = document.getElementById("csvFormatLocked");
  const startBtn     = document.getElementById("startCsvRun");
  const dlBtn        = document.getElementById("csvDownloadResult");
  const statusEl     = document.getElementById("csvStatus");
  const pbCsvSection = document.getElementById("pbPanelCsvSection");
  const pbStopSingle = document.getElementById("pbPanelStop");
  const pbStopSplit  = document.getElementById("pbPanelCsvStopSplit");
  const pbStopAfter  = document.getElementById("pbStopCsvAfterRow");

  // Undo the "Stopping…" latch left by a previous run's graceful stop.
  if (pbStopAfter && s !== 'done') {
    pbStopAfter.disabled = false;
    pbStopAfter.textContent = "⏸ After row";
  }

  if (s === 'idle') {
    if (formatSel)    { formatSel.disabled = false; formatSel.style.pointerEvents = ""; formatSel.style.cursor = ""; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = false; }
    if (dlBtn)        dlBtn.style.display = "none";
    if (statusEl)     statusEl.textContent = "";
    if (pbCsvSection) pbCsvSection.style.display = "none";
    if (pbStopSingle) pbStopSingle.style.display = "";
    if (pbStopSplit)  pbStopSplit.style.display = "none";
    stopCsvCountdown();
  } else if (s === 'running') {
    if (formatSel)    { formatSel.disabled = true; formatSel.style.pointerEvents = ""; formatSel.style.cursor = ""; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = true; }
    if (dlBtn)        dlBtn.style.display = "none";
    if (pbCsvSection) pbCsvSection.style.display = "";
    if (pbStopSingle) pbStopSingle.style.display = "none";
    if (pbStopSplit)  pbStopSplit.style.display = "";
    openPbPanel();
  } else if (s === 'done') {
    if (formatSel)    { formatSel.disabled = true; formatSel.style.pointerEvents = "none"; formatSel.style.cursor = "not-allowed"; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = false; }
    if (dlBtn)        dlBtn.style.display = "block";
    if (pbCsvSection) pbCsvSection.style.display = "";
    if (pbStopSingle) pbStopSingle.style.display = "none";
    if (pbStopSplit)  pbStopSplit.style.display = "none";
    stopCsvCountdown();
  }
}

export function startCsvPoll(statusEl) {
  const DONE_POLL_MS = 800; // how often the finished run's results are looked for
  const poll = setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_CSV_STATUS" }, (res) => {
      if (!res) { clearInterval(poll); return; }
      if (res.active) {
        // failRows is kept up-to-date by CSV_ROW_DONE messages; no storage read needed here
        updateCsvBadges(res.currentRow + 1, res.totalRows, 0, false);
      } else {
        chrome.runtime.sendMessage({ type: "GET_CSV_RUN_RESULTS" }, (idbData) => {
          const results  = idbData?.results || [];
          const failRows = results.filter(r => r.failures?.length > 0).length;
          updateCsvBadges(results.length, results.length, failRows, true);
        });
        setCsvState('done');
        clearInterval(poll);
      }
    });
  }, DONE_POLL_MS);
}

function _handleCsvStop(label) {
  chrome.runtime.sendMessage({ type: "STOP_CSV_PLAYBACK" }, () => {
    stopCsvCountdown();
    showToast(`CSV run ${label}`, "info");
    chrome.runtime.sendMessage({ type: "GET_CSV_RUN_RESULTS" }, (idbData) => {
      const results = idbData?.results || [];
      if (results.length > 0) {
        const failRows = results.filter(r => r.failures?.length > 0).length;
        updateCsvBadges(results.length, results.length, failRows, true);
        setCsvState('done');
        const statusEl = document.getElementById("csvStatus");
        const cardSummary = failRows > 0
          ? `Stopped · ✓ ${results.length - failRows} passed · ✗ ${failRows} failed`
          : `Stopped · ✓ ${results.length} passed`;
        if (statusEl) statusEl.textContent = cardSummary;
        const barSummary = failRows > 0
          ? `Stopped · ✓ ${results.length - failRows} · ✗ ${failRows} of ${results.length}`
          : `Stopped · ✓ ${results.length} rows`;
        setCsvDoneBar(ui._csvRunScenarioName || "CSV Run", barSummary);
      } else {
        setCsvState('idle');
      }
    });
  });
}

export function initCsvState() {
  document.getElementById("startCsvRun")?.addEventListener("click", () => {
    const scenarioId = document.getElementById("csvScenarioSelect")?.value;
    if (!scenarioId) { showToast("Select a scenario first", "error"); return; }
    if (!ui.csvParsed || !ui.csvParsed.rows.length) { showToast("Load a CSV file first", "error"); return; }
    clearCsvDoneBar();
    ui._csvRunScenarioName = document.getElementById("csvScenarioSelect")?.selectedOptions[0]?.text || "CSV Run";

    const _csvPresetEl = document.getElementById("csvDelayBetweenPreset");
    const delayVal = _csvPresetEl?.value === "custom"
      ? document.getElementById("csvDelayBetween")?.value?.trim()
      : (_csvPresetEl?.value || "500");
    const delayMs = parseInt(delayVal, 10);
    const delayBetween = !isNaN(delayMs) && delayMs >= 500 ? delayMs : 500;
    ui._csvDelayBetween = delayBetween;

    // Warn if scenario uses ${variables} not present in CSV headers
    const inputVars = getInputVarsFromScenario(scenarioId);
    const csvHeaderSet = new Set(ui.csvParsed.headers);
    const missingCols = [...inputVars].filter(v => !csvHeaderSet.has(v));
    if (missingCols.length > 0) {
      showToast(`CSV missing columns used by scenario: ${missingCols.join(", ")}`, "warn");
    }

    updateCsvBadges(0, ui.csvParsed.rows.length, 0, false);
    const status = document.getElementById("csvStatus");
    if (status) status.textContent = "";

    setCsvState('running');

    // Persist CSV data so popup can restore session after reopen
    chrome.storage.local.set({ csvSessionData: { headers: ui.csvParsed.headers, rows: ui.csvParsed.rows } });

    const exportFormat = document.getElementById("csvExportFormat")?.value || "csv";

    chrome.runtime.sendMessage({
      type: "START_CSV_PLAYBACK",
      scenarioId,
      rows: ui.csvParsed.rows,
      delayBetween,
      exportFormat,
    });
  });
  // Hard stop — the row in flight is abandoned and never recorded.
  document.getElementById("pbStopCsvNow")?.addEventListener("click", () => _handleCsvStop("aborted"));
  // Graceful stop — the worker finishes and records the current row, then ends the
  // run through the normal completion path (CSV_ROW_DONE with isLast, then
  // CSV_RUN_DONE), which is what flips the card to its 'done' state. The button
  // latches so a second click cannot be mistaken for "it didn't work".
  document.getElementById("pbStopCsvAfterRow")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    chrome.runtime.sendMessage({ type: "STOP_CSV_AFTER_ROW" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.alreadyStopped) { showToast("CSV run already finished", "info"); return; }
      btn.disabled = true;
      btn.textContent = "⏸ Stopping…";
      showToast(`Will stop after row ${(res?.currentRow ?? 0) + 1} finishes`, "info");
    });
  });
  document.getElementById("csvChangeFormat")?.addEventListener("click", () => {
    showConfirm(
      "Changing the export format will clear the current run results. You will need to run again.",
      () => {
        clearCsvDoneBar();
        chrome.runtime.sendMessage({ type: "CLEAR_CSV_SCREENSHOTS" }, () => {
          chrome.runtime.sendMessage({ type: "CLEAR_CSV_RESULTS" }, () => {
            const status = document.getElementById("csvStatus");
            if (status) status.textContent = "";
            updateCsvBadges(0, 0, 0, false);
            setCsvState('idle');
            showToast("Format unlocked — results cleared", "info");
          });
        });
      },
      { title: "Change Export Format?", danger: true, okLabel: "Clear & change" }
    );
  });
  // Persist export format selection across popup reopens
  document.getElementById("csvExportFormat")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ csvExportFormat: e.target.value });
  });
  // Show format-locked warning when user clicks the format area while in done state
  // pointer-events:none on the select lets clicks fall through to this parent div
  document.getElementById("csvFormatRow")?.addEventListener("click", () => {
    const formatSel = document.getElementById("csvExportFormat");
    const locked    = document.getElementById("csvFormatLocked");
    if (!formatSel?.disabled || !locked) return;
    locked.style.display = "";
  });
}
