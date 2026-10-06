/**
 * scenarios/scenario-list.js — loading scenarios and the lists that show them.
 */

import { renderCsvScenarioSelect, renderExportCodeSelect } from '../csv/csv-run.js';
import { filterFolder, scenarioList, scenarioSearch, scenarioSort, sequenceScenarioList } from '../dom.js';
import { switchMode } from '../record/form-fields.js';
import { previewActions } from '../record/preview.js';
import { populateSwitchScenarioSelect } from '../record/switch-case-builder.js';
import { renderScheduleScenarioSelect } from '../run/schedule.js';
import { ui } from '../ui-state.js';
import { debounce } from '../utils.js';
import { renderExportScenarioSelect, renderFolderOptions, renderFoldersManagementUI, renderMoveToFolderSelect } from './folders.js';
import { toggleScenarioActions } from './scenario-actions.js';

/* === LOAD SCENARIOS === */

function renderScenarioOptions() {
  scenarioList.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select a scenario --";
  scenarioList.appendChild(placeholder);

  const searchTerm = (scenarioSearch?.value || "").toLowerCase();
  const sort = scenarioSort?.value || "createdDesc";
  const folderFilter = filterFolder?.value || "";

  const list = Object.entries(ui.scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    tags: s.tags || [],
    createdAt: s.createdAt || 0,
    folderId: s.folderId || null,
  }));

  const filtered = list.filter((item) => {
    // Filter by search term
    if (searchTerm) {
      const haystack = `${item.name} ${(item.tags || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }

    // Filter by folder
    if (folderFilter) {
      if (folderFilter === "__none__") {
        if (item.folderId) return false;
      } else {
        if (item.folderId !== folderFilter) return false;
      }
    }

    return true;
  });

  filtered.sort((a, b) => {
    if (sort === "nameAsc") return a.name.localeCompare(b.name);
    if (sort === "nameDesc") return b.name.localeCompare(a.name);
    if (sort === "createdAsc") return (a.createdAt || 0) - (b.createdAt || 0);
    return (b.createdAt || 0) - (a.createdAt || 0); // createdDesc
  });

  // Group by folder
  const grouped = {};
  filtered.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = ui.foldersCache[a]?.name || "";
    const nameB = ui.foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId];
    const folderName = folderId === "__none__" ? "No Folder" : ui.foldersCache[folderId]?.name || "Unknown";

    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    scenarioList.appendChild(optgroup);

    items.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });

  // restore selection if still present in filtered list
  chrome.storage.local.get(["lastSelectedScenario"], (storageRes) => {
    const last = storageRes?.lastSelectedScenario;
    const isInFiltered = filtered.some(item => item.id === last);

    if (last && ui.scenariosCache[last] && isInFiltered) {
      scenarioList.value = last;
      toggleScenarioActions(true);
    } else {
      scenarioList.value = "";
      toggleScenarioActions(false);
    }
    previewActions();
  });
}

function renderSequenceScenarioList() {
  sequenceScenarioList.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select a scenario --";
  sequenceScenarioList.appendChild(placeholder);

  // Apply folder filter from filterFolder
  const folderFilter = filterFolder?.value || "";

  const list = Object.entries(ui.scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    createdAt: s.createdAt || 0,
    folderId: s.folderId || null,
  }));

  // Filter by folder (same as scenarioList)
  const filtered = list.filter((item) => {
    if (folderFilter) {
      if (folderFilter === "__none__") {
        return !item.folderId || item.folderId === null;
      }
      return item.folderId === folderFilter;
    }
    return true;
  });

  const grouped = {};
  filtered.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = ui.foldersCache[a]?.name || "";
    const nameB = ui.foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId].sort((a, b) => a.name.localeCompare(b.name));
    const folderName = folderId === "__none__" ? "No Folder" : ui.foldersCache[folderId]?.name || "Unknown";

    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    sequenceScenarioList.appendChild(optgroup);

    items.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });
}

export function loadScenarios() {
  // Fetch scenarios and folders in parallel, then render everything once
  Promise.all([
    new Promise(r => chrome.runtime.sendMessage({ type: "GET_SCENARIOS" }, r)),
    new Promise(r => chrome.runtime.sendMessage({ type: "GET_FOLDERS" }, r)),
  ]).then(([sRes, fRes]) => {
    ui.scenariosCache = sRes?.scenarios || {};
    ui.foldersCache = fRes?.folders || {};

    // Render all UI once (no double-render)
    renderFolderOptions();
    renderMoveToFolderSelect();
    renderFoldersManagementUI();
    renderScenarioOptions();
    renderSequenceScenarioList();
    renderExportScenarioSelect();
    renderScheduleScenarioSelect();
    renderCsvScenarioSelect();
    renderExportCodeSelect();
    // An Always Switch's case is the scenario its list shows: a form restored
    // before the scenarios arrived shows it now.
    if (switchMode() === "always") populateSwitchScenarioSelect();

    // Restore scenario selection if stopped recording via hotkey while popup was closed
    chrome.storage.local.get(["pendingRecordScenarioId"], (stored) => {
      const sid = stored?.pendingRecordScenarioId;
      if (sid && scenarioList) {
        scenarioList.value = sid;
        if (scenarioList.value === sid) {
          toggleScenarioActions(true);
          previewActions();
        }
        chrome.storage.local.remove("pendingRecordScenarioId");
      }
    });
  });
}

export function initScenarioList() {
  loadScenarios();
  // Debounce search input to avoid rendering on every keystroke
  if (scenarioSearch) scenarioSearch.oninput = debounce(renderScenarioOptions, 250);
  if (scenarioSort) scenarioSort.onchange = renderScenarioOptions;
  if (filterFolder) filterFolder.onchange = renderScenarioOptions;
  // Update Move to Folder select when scenario is changed
  if (scenarioList) {
    scenarioList.onchange = () => {
      renderMoveToFolderSelect();
    };
  }
}
