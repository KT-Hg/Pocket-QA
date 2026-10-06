/**
 * csv/csv-run.js — the CSV data-driven run card: picking the file and scenario,
 * progress badges and countdown, result download.
 */

import { formatStamp } from '../../shared/time-format.js';
import { downloadBlob, downloadCsvText } from '../lib/download.js';
import { ZipWriter } from '../lib/zip-writer.js';
import { ui } from '../ui-state.js';
import { getReadVarNames, showToast } from '../utils.js';
import { parseCSV } from './csv-parse.js';
import { generateResultCsv, generateResultHtml, generateResultXlsx } from './result-export.js';

/* === CSV DATA-DRIVEN RUN === */

// Same field list as playback substitutes — see getReadVarNames in popup/utils.js.
export function getInputVarsFromScenario(scenarioId) {
  const scenario = ui.scenariosCache[scenarioId];
  if (!scenario?.actions) return new Set();
  return getReadVarNames(scenario.actions);
}

export function renderCsvScenarioSelect() {
  const sel = document.getElementById("csvScenarioSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(ui.scenariosCache)
    .sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""))
    .forEach(([id, s]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
}

export function renderExportCodeSelect() {
  const sel = document.getElementById("exportCodeSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(ui.scenariosCache)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, s]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}

let _csvCountdownInterval = null;
const COUNTDOWN_TICK_MS = 1000;

export function updateCsvBadges(row, total, failRows, done) {
  const progText  = document.getElementById("pbPanelCsvProgText");
  const badgeOk   = document.getElementById("pbPanelCsvBadgeOk");
  const badgeFail = document.getElementById("pbPanelCsvBadgeFail");
  const barOk     = document.getElementById("pbPanelBarOk");
  const barFail   = document.getElementById("pbPanelBarFail");
  const statusEl  = document.getElementById("csvStatus");

  const success = row - failRows;
  const pct = total > 0 ? (v) => Math.round(v / total * 100) + "%" : () => "0%";

  if (done) {
    if (progText) progText.textContent = `${total - failRows} passed · ${failRows} failed`;
    if (barOk)    barOk.style.width    = pct(total - failRows);
    if (barFail)  barFail.style.width  = pct(failRows);
    if (statusEl) statusEl.textContent = `✓ ${total - failRows} passed · ✗ ${failRows} failed`;
  } else if (!row) {
    if (progText) progText.textContent = total > 0 ? `Row Done 0 / ${total}` : "";
    if (barOk)    barOk.style.width    = "0%";
    if (barFail)  barFail.style.width  = "0%";
  } else {
    if (progText) progText.textContent = `Row Done ${row} / ${total}`;
    if (barOk)    barOk.style.width    = pct(success);
    if (barFail)  barFail.style.width  = pct(failRows);
  }
  if (badgeOk)   badgeOk.textContent   = `✓ ${done ? total - failRows : success}`;
  if (badgeFail) {
    badgeFail.textContent = `✗ ${failRows}`;
    badgeFail.classList.toggle("has-fail", failRows > 0);
  }
}

export function startCsvCountdown(delayMs) {
  if (!delayMs || delayMs <= 0) return;
  const cdWrap = document.getElementById("pbPanelCsvCountdown");
  const cdText = document.getElementById("pbPanelCsvCdText");
  const cdBar  = document.getElementById("pbPanelCsvCdBar");
  if (!cdWrap) return;

  if (_csvCountdownInterval) clearInterval(_csvCountdownInterval);
  cdWrap.style.display = "block";

  let rem = Math.round(delayMs / 1000);
  if (cdText) cdText.textContent = `⏱ next row in ${rem}s`;
  _csvCountdownInterval = setInterval(() => {
    rem--;
    if (rem <= 0) {
      clearInterval(_csvCountdownInterval);
      if (cdText) cdText.textContent = "";
      if (cdWrap) cdWrap.style.display = "none";
    } else {
      if (cdText) cdText.textContent = `⏱ next row in ${rem}s`;
    }
  }, COUNTDOWN_TICK_MS);

  if (cdBar) {
    // Reset to full-width with no transition first, then apply the transition on the
    // next two rAF ticks so the browser has committed the reset paint before the
    // shrink animation begins. A single rAF is not always enough on Chrome.
    cdBar.style.transition = "none";
    cdBar.style.width = "100%";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cdBar.style.transition = `width ${delayMs}ms linear`;
      cdBar.style.width = "0%";
    }));
  }
}

export function stopCsvCountdown() {
  if (_csvCountdownInterval) { clearInterval(_csvCountdownInterval); _csvCountdownInterval = null; }
  const cdWrap = document.getElementById("pbPanelCsvCountdown");
  const cdBar  = document.getElementById("pbPanelCsvCdBar");
  if (cdWrap) cdWrap.style.display = "none";
  if (cdBar)  { cdBar.style.transition = "none"; cdBar.style.width = "100%"; }
}

export function initCsvRun() {
  document.getElementById("csvFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    const previewEl = document.getElementById("csvPreview");
    if (!file) { ui.csvParsed = null; if (previewEl) previewEl.textContent = ""; return; }

    const reader = new FileReader();
    reader.onload = () => {
      ui.csvParsed = parseCSV(reader.result);
      if (!ui.csvParsed) {
        if (previewEl) previewEl.textContent = "Invalid CSV (need at least 1 header row + 1 data row)";
        chrome.storage.local.remove("csvSessionData");
        return;
      }
      if (previewEl) {
        previewEl.textContent = `${ui.csvParsed.rows.length} rows, columns: ${ui.csvParsed.headers.join(", ")}`;
      }
      chrome.storage.local.set({ csvSessionData: { headers: ui.csvParsed.headers, rows: ui.csvParsed.rows } });
    };
    reader.readAsText(file);
  });
  document.getElementById("csvDownloadResult")?.addEventListener("click", () => {
    const format = document.getElementById("csvExportFormat")?.value || "csv";
    if (!ui.csvParsed) { showToast("Reload the original CSV file first", "error"); return; }

    const ts = formatStamp(new Date());

    const fetchResults = cb => chrome.runtime.sendMessage({ type: "GET_CSV_RUN_RESULTS" }, cb);
    const fetchSS      = cb => chrome.runtime.sendMessage({ type: "GET_CSV_SCREENSHOTS" }, cb);

    fetchResults(res => {
      const results = res?.results;
      if (!results?.length) { showToast("No results to download yet", "error"); return; }

      if (format === "csv") {
        const text = generateResultCsv(ui.csvParsed.headers, ui.csvParsed.rows, results);
        downloadCsvText(text, `csv_result_${ts}.csv`);
        showToast("Downloaded — results still available for re-download", "success");
      } else {
        fetchSS(ssRes => {
          const ss         = ssRes?.screenshots || {};
          const ssVarOrder = ssRes?.ssVarOrder  || [];
          if (format === "html") {
            const html = generateResultHtml(ui.csvParsed.headers, ui.csvParsed.rows, results, ss, ssVarOrder);
            downloadBlob(new Blob([html], { type: "text/html;charset=utf-8;" }), `csv_result_${ts}.html`);
          } else if (format === "xlsx") {
            const blob = generateResultXlsx(ui.csvParsed.headers, ui.csvParsed.rows, results, ss, ssVarOrder);
            downloadBlob(blob, `csv_result_${ts}.xlsx`);
          } else if (format === "zip") {
            const zip = new ZipWriter();
            const csvText = generateResultCsv(ui.csvParsed.headers, ui.csvParsed.rows, results);
            zip.add("results.csv", "﻿" + csvText);
            for (const [key, b64] of Object.entries(ss)) {
              const colonIdx = key.indexOf(":");
              const rowNum = String(Number(key.slice(0, colonIdx)) + 1).padStart(2, "0");
              const varName = key.slice(colonIdx + 1);
              const binary = atob(b64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              zip.add(`row_${rowNum}/${varName}.png`, bytes);
            }
            downloadBlob(zip.build("application/zip"), `csv_screenshots_${ts}.zip`);
          }
          showToast("Downloaded — results still available for re-download", "success");
        });
      }
    });
  });
}
