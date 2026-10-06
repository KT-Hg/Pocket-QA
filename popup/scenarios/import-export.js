/**
 * scenarios/import-export.js — export a scenario or folder to JSON and import one.
 */

import { anyBlocks } from '../../shared/switch-blocks.js';
import { exportFolder, exportFolderSelect, exportScenario, exportScenarioSelect, importFile, importScenario } from '../dom.js';
import { downloadBlob, safeFileName } from '../lib/download.js';
import { showAlert, showToast } from '../utils.js';
import { loadScenarios } from './scenario-list.js';

/**
 * Mark an export that uses Switch blocks with the version that wrote it. An
 * older extension ignores `endAt` and would play every case of the block one
 * after the other, so the file says what it needs.
 */
function _withMinVersion(data, scenarios) {
  if (!scenarios.some(sc => anyBlocks(sc?.actions))) return data;
  let version = "";
  try { version = chrome.runtime.getManifest().version; } catch (_) { /* no manifest outside the extension: export without minVersion */ }
  return version ? { ...data, minVersion: version } : data;
}

export function initImportExport() {
  /* === EXPORT === */

  // Update button state when scenario selection changes
  if (exportScenarioSelect) {
    exportScenarioSelect.onchange = () => {
      if (exportScenario) {
        exportScenario.disabled = !exportScenarioSelect.value;
      }
    };
  }
  // Update button state when folder selection changes
  if (exportFolderSelect) {
    exportFolderSelect.onchange = () => {
      if (exportFolder) {
        exportFolder.disabled = !exportFolderSelect.value;
      }
    };
  }
  exportScenario.onclick = () => {
    const scenarioId = exportScenarioSelect?.value;
    if (!scenarioId) return;

    chrome.runtime.sendMessage({ type: "EXPORT_SCENARIO", scenarioId }, (res) => {
      if (!res?.scenario) { showToast("Failed to export scenario", "error"); return; }

      const blob = new Blob([JSON.stringify(_withMinVersion(res.scenario, [res.scenario]), null, 2)], {
        type: "application/json",
      });
      // Via downloadBlob, which defers revokeObjectURL. Revoking on the line after
      // a.click() can beat the browser to reading the blob and write an empty file.
      downloadBlob(blob, `${safeFileName(res.scenario.name)}.json`);
      showToast(`Exported "${res.scenario.name}"`, "success");
    });
  };
  // Export all scenarios within a selected folder
  if (exportFolder) {
    exportFolder.onclick = () => {
      const folderId = exportFolderSelect?.value;
      if (!folderId) return;

      chrome.runtime.sendMessage({ type: 'EXPORT_FOLDER', folderId }, (res) => {
        const folderData = res?.folder;
        if (!folderData) { showToast("Failed to export folder", "error"); return; }
        const nameSafe = safeFileName(folderData.name || 'folder').replace(/\s+/g, '-');
        const blob = new Blob([JSON.stringify(_withMinVersion(folderData, Object.values(folderData.scenarios || {})), null, 2)], { type: 'application/json' });
        downloadBlob(blob, `folder-${nameSafe}.json`);
        showToast(`Exported folder "${folderData.name}"`, "success");
      });
    };
  }
  /* === IMPORT === */

  importScenario.onclick = () => {
    const file = importFile.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let json;
      try {
        json = JSON.parse(reader.result);
      } catch (e) {
        showToast("Invalid JSON file", 'error');
        return;
      }

      // Three accepted shapes:
      //   1. { name, actions: [...] }                 — Export Scenario
      //   2. [ { name, actions }, … ]                 — array of scenarios
      //   3. { name, scenarios: { id: {...}, … } }    — Export Folder
      // Shape 3 used to fall through to the single-scenario branch, which created
      // an empty entry named after the folder and dropped every scenario in it.
      const isFolderExport = json && typeof json === 'object' && !Array.isArray(json)
        && json.scenarios && typeof json.scenarios === 'object';

      if (isFolderExport) {
        chrome.runtime.sendMessage({ type: "IMPORT_FOLDER", folder: json }, (res) => {
          if (chrome.runtime.lastError || !res?.success) {
            showToast("Import failed: " + (res?.error || "unreadable folder file"), "error");
            return;
          }
          loadScenarios(); // refreshes folders too — see its GET_FOLDERS call
          const skipped = res.skipped ? ` (${res.skipped} skipped)` : "";
          showToast(`Imported folder "${res.folderName}" — ${res.count} scenario${res.count > 1 ? "s" : ""}${skipped}`, "success");
          if (res.hasScriptActions) {
            showAlert(
              "This folder contains scenarios with Run JS actions. Imported code runs with the " +
              "extension's privileges — review those actions before playing them.",
              { title: "⚠ Imported code" },
            );
          }
        });
        return;
      }

      const items = Array.isArray(json) ? json : [json];
      if (!items.length) { showToast("Empty file", "error"); return; }
      let done = 0, ok = 0, failed = 0, sawScripts = false;
      items.forEach((scenario) => {
        chrome.runtime.sendMessage({ type: "IMPORT_SCENARIO", scenario }, (res) => {
          done++;
          if (res?.success) { ok++; if (res.hasScriptActions) sawScripts = true; }
          else failed++;
          if (done !== items.length) return;
          loadScenarios();
          if (ok === 0) {
            showToast("Nothing imported — the file is not a scenario export", "error");
            return;
          }
          showToast(
            `Imported ${ok} scenario${ok > 1 ? "s" : ""}${failed ? ` · ${failed} skipped` : ""}`,
            failed ? "warn" : "success",
          );
          if (sawScripts) {
            showAlert(
              "This import contains Run JS actions. Imported code runs with the extension's " +
              "privileges — review those actions before playing them.",
              { title: "⚠ Imported code" },
            );
          }
        });
      });
    };
    reader.readAsText(file);
  };
}
