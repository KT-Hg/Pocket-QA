/**
 * scenarios/scenario-actions.js — enable / disable all actions, rename and delete
 * a scenario.
 */

import { actionsEl, autoSaveNotice, deleteScenario, doMoveToFolder, duplicateScenarioBtn, playScenario, renameInput, renameScenario, saveFlow, scenarioList, stopPlay } from '../dom.js';
import { showFieldError } from '../record/picked-selectors.js';
import { ui } from '../ui-state.js';
import { showConfirm, showToast } from '../utils.js';
import { loadScenarios } from './scenario-list.js';

/* === ENABLE / DISABLE === */

export function toggleScenarioActions(enabled) {
  [
    renameScenario,
    deleteScenario,
    playScenario,
    stopPlay,
    duplicateScenarioBtn,
    doMoveToFolder,
    document.getElementById("showMoveSection"),
    document.getElementById("scenarioClickThrough"),
  ].filter(Boolean).forEach((btn) => (btn.disabled = !enabled));
  _showClickThrough();

  // Hide rename/move panels when selection cleared
  if (!enabled) {
    const rs = document.getElementById("renameSection");
    const ms = document.getElementById("moveSection");
    if (rs) rs.style.display = "none";
    if (ms) ms.style.display = "none";
  }

  // Save Scenario only applies to a fresh, unsaved buffer — once an existing
  // scenario is selected, recording/manual edits save straight into it, so
  // showing Save would just invite an accidental duplicate. Hide the button
  // only (not the whole card) so Name/Folder/New stay usable to start a
  // brand-new scenario while one is selected for editing.
  if (saveFlow) saveFlow.style.display = enabled ? "none" : "";
  if (autoSaveNotice) {
    autoSaveNotice.style.display = enabled ? "" : "none";
    if (enabled) {
      const name = ui.scenariosCache[scenarioList.value]?.name;
      autoSaveNotice.textContent = name
        ? `✓ Editing "${name}" — changes save automatically`
        : "✓ Changes save automatically";
    }
  }
}

/* === CLICK THROUGH ===
 * The scenario's own "Click through" (shared/click-through.js): off, every action
 * of it fails on an element a user could not reach; back on, each action keeps
 * its own setting. Shown on the toolbar button and above the action list. */

function _showClickThrough() {
  const off = ui.scenariosCache[scenarioList.value]?.clickThrough === false;
  const btn = document.getElementById("scenarioClickThrough");
  if (btn) {
    btn.setAttribute("aria-pressed", String(off));
    btn.title = off
      ? "Click through is off: every action of this scenario fails on a disabled, read-only, hidden or covered element. Click to turn it back on — each action then keeps its own setting."
      : "Click through is on: actions act even on a disabled or covered element. Click to turn it off for the whole scenario.";
  }
  const note = document.getElementById("scenarioClickThroughNote");
  if (note) note.style.display = off ? "" : "none";
}

function _toggleClickThrough() {
  const scenarioId = scenarioList.value;
  const scenario = ui.scenariosCache[scenarioId];
  if (!scenario) return;
  const allowed = scenario.clickThrough === false;
  chrome.runtime.sendMessage({ type: "SET_SCENARIO_CLICK_THROUGH", scenarioId, allowed }, (res) => {
    if (chrome.runtime.lastError || !res?.success) { showToast("Could not change Click through", "error"); return; }
    if (allowed) delete scenario.clickThrough;
    else scenario.clickThrough = false;
    _showClickThrough();
    showToast(allowed ? "Click through on for this scenario" : "Click through off — every action of this scenario is checked", "success");
  });
}

export function initScenarioActions() {
  const clickThroughBtn = document.getElementById("scenarioClickThrough");
  if (clickThroughBtn) clickThroughBtn.onclick = _toggleClickThrough;

  /* === RENAME === */

  renameScenario.onclick = () => {
    const scenarioId = scenarioList.value;
    if (!scenarioId) return;

    const renameSection = document.getElementById("renameSection");
    const moveSection = document.getElementById("moveSection");

    // Toggle visibility
    const isOpen = renameSection && renameSection.style.display !== "none";
    if (renameSection) renameSection.style.display = isOpen ? "none" : "block";
    if (moveSection) moveSection.style.display = "none";

    // Pre-fill with current name
    if (!isOpen && renameInput) {
      renameInput.value = ui.scenariosCache[scenarioId]?.name || "";
      renameInput.focus();
      renameInput.select();
    }
  };
  // Confirm rename
  document.getElementById("confirmRename")?.addEventListener("click", () => {
    const newName = renameInput?.value.trim();
    const scenarioId = scenarioList?.value;
    if (!newName || !scenarioId) {
      if (renameInput) showFieldError(renameInput, "Scenario name is required");
      return;
    }
    chrome.runtime.sendMessage({ type: "RENAME_SCENARIO", scenarioId, newName }, () => {
      const rs = document.getElementById("renameSection");
      if (rs) rs.style.display = "none";
      if (renameInput) renameInput.value = "";
      loadScenarios();
    });
  });
  // Cancel rename
  document.getElementById("cancelRename")?.addEventListener("click", () => {
    const rs = document.getElementById("renameSection");
    if (rs) rs.style.display = "none";
    if (renameInput) renameInput.value = "";
  });
  // Toggle move section
  document.getElementById("showMoveSection")?.addEventListener("click", () => {
    const moveSection = document.getElementById("moveSection");
    const renameSection = document.getElementById("renameSection");
    if (!moveSection) return;
    const isOpen = moveSection.style.display !== "none";
    moveSection.style.display = isOpen ? "none" : "block";
    if (!isOpen && renameSection) renameSection.style.display = "none";
  });
  if (duplicateScenarioBtn) {
    duplicateScenarioBtn.onclick = () => {
      const scenarioId = scenarioList.value;
      if (!scenarioId) return;
      chrome.runtime.sendMessage({ type: "DUPLICATE_SCENARIO", scenarioId }, (res) => {
        loadScenarios();
        if (res?.success) showToast("Scenario duplicated", "success");
        else showToast("Failed to duplicate scenario", "error");
      });
    };
  }
  /* === DELETE === */

  deleteScenario.onclick = () => {
    const scenarioId = scenarioList.value;
    if (!scenarioId) return;

    showConfirm("Delete this scenario?", () => {
      chrome.runtime.sendMessage({ type: "DELETE_SCENARIO", scenarioId }, () => {
        actionsEl.innerHTML = "";
        showToast("Scenario deleted", "success");
        // If the deleted scenario was the last selected scenario, remove persisted selection
        chrome.storage.local.get(["lastSelectedScenario"], (res) => {
          if (res?.lastSelectedScenario === scenarioId) {
            chrome.storage.local.remove("lastSelectedScenario");
          }
          loadScenarios();
        });
      });
    }, { title: 'Delete Scenario', danger: true });
  };
}
