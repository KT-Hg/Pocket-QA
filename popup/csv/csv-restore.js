/**
 * csv/csv-restore.js — on popup open: the chosen export format and a CSV session
 * that is still running or finished.
 */

import { setCardOpen } from '../ui/collapsible.js';
import { ui } from '../ui-state.js';
import { updateCsvBadges } from './csv-run.js';
import { setCsvState, startCsvPoll } from './csv-state.js';

export function initCsvRestore() {
  /* === Restore export format selection on every popup open === */
  chrome.storage.local.get(["csvExportFormat"], (stored) => {
    if (stored.csvExportFormat) {
      const sel = document.getElementById("csvExportFormat");
      if (sel) sel.value = stored.csvExportFormat;
    }
  });
  /* === Restore CSV session when popup reopens during/after a run === */
  (function restoreCsvSession() {
    chrome.runtime.sendMessage({ type: "GET_CSV_STATUS" }, (csvStatus) => {
      const isActive = !!csvStatus?.active;
      chrome.storage.local.get(["csvSessionData", "csvExportFormat"], (stored) => {
        const session = stored.csvSessionData;
        if (!session) return;

        // Results live in IDB; query them to decide whether to restore the "done" state.
        chrome.runtime.sendMessage({ type: "GET_CSV_RUN_RESULTS" }, (idbData) => {
          const idbResults = idbData?.results || [];
          const hasResults = idbResults.length > 0;
          if (!isActive && !hasResults) return;

          // Restore in-memory CSV data so download works without reloading file
          ui.csvParsed = session;

          if (stored.csvExportFormat) {
            const sel = document.getElementById("csvExportFormat");
            if (sel) sel.value = stored.csvExportFormat;
          }

          const previewEl = document.getElementById("csvPreview");
          const status   = document.getElementById("csvStatus");
          const csvCard  = document.getElementById("csvRunCard");

          if (previewEl) previewEl.textContent = `${session.rows.length} rows, columns: ${session.headers.join(", ")} ↩ restored`;

          setCardOpen(csvCard, true);

          if (isActive) {
            if (status) status.textContent = "";
            updateCsvBadges(csvStatus.currentRow + 1, csvStatus.totalRows, 0, false);
            setCsvState('running');
            startCsvPoll(status);
          } else if (hasResults) {
            const failRows = idbResults.filter(r => r.failures?.length > 0).length;
            updateCsvBadges(idbResults.length, idbResults.length, failRows, true);
            if (status) status.textContent = "";
            setCsvState('done');
          }
        });
      });
    });
  })();
}
