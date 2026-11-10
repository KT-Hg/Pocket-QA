/**
 * scenarios/save.js — saving the current recording as a scenario, and "New".
 */

import { actionsEl, filterFolder, manualActionType, manualSelector, manualValue, newFlow, saveFlow, scenarioFolder, scenarioList, scenarioName, scenarioSearch } from '../dom.js';
import { clearEditState } from '../record/action-form.js';
import { showFieldError } from '../record/picked-selectors.js';
import { resetManualValueMemory } from '../record/value-memory.js';
import { ui } from '../ui-state.js';
import { showConfirm, showToast } from '../utils.js';
import { setFolderFilter } from './folders.js';
import { toggleScenarioActions } from './scenario-actions.js';
import { loadScenarios } from './scenario-list.js';

/** The scenario `id` just made, selected in Manage Scenarios: what is added or edited next saves into it. */
function _selectMade(id, name, folderId) {
  // A search or folder filter in Manage Scenarios could hide it, and only a
  // listed scenario can be the selected one.
  const term = (scenarioSearch?.value || "").trim().toLowerCase();
  if (term && !name.toLowerCase().includes(term)) scenarioSearch.value = "";
  if (filterFolder?.value && filterFolder.value !== (folderId || "__none__")) setFolderFilter("");
  // loadScenarios selects whatever lastSelectedScenario names.
  chrome.storage.local.set({ lastSelectedScenario: id }, () => loadScenarios());
}

/** `go()` now, or once confirmed when `name` is already used in that folder. */
function _unlessTaken(name, folderId, go, { title, okLabel, verb }) {
  const taken = Object.values(ui.scenariosCache).some(s => s.name === name && (s.folderId || null) === folderId);
  if (taken) {
    showConfirm(`A scenario named "${name}" is already in this folder. ${verb} another one with the same name?`, go, { title, okLabel });
  } else {
    go();
  }
}

function _createNamedScenario(name) {
  const folderId = scenarioFolder.value || null;
  const create = () => chrome.runtime.sendMessage({ type: "CREATE_SCENARIO", name, folderId }, (res) => {
    if (!res?.success || !res.id) { showToast("Failed to create scenario", "error"); return; }
    if (ui.editing) { clearEditState(); chrome.storage.local.remove("manualFormDraft"); }
    scenarioName.value = "";
    scenarioName.classList.remove("required-error");
    _selectMade(res.id, name, folderId);
    showToast(`Created "${name}" — what you add or edit now saves into it`, "success");
  });
  _unlessTaken(name, folderId, create, { title: 'New Scenario', okLabel: 'Create', verb: 'Create' });
}

export function initSave() {
  /* === SAVE === */

  saveFlow.addEventListener('click', () => {
    const name = scenarioName.value.trim();

    if (!name) {
      showFieldError(scenarioName, "Scenario name is required");
      scenarioName.focus();
      return;
    }

    scenarioName.classList.remove('required-error');

    const folderId = scenarioFolder.value || null;

    const existing = Object.entries(ui.scenariosCache).find(
      ([, s]) => s.name === name && (s.folderId || null) === folderId
    );
    const originalCreatedAt = existing ? existing[1].createdAt : undefined;

    // Saved, the scenario stays selected: ▶ Play runs it at once, and what is
    // recorded or edited next saves into it. It used to leave nothing selected —
    // an empty list and a greyed Play right after Save.
    const save = () => chrome.runtime.sendMessage({ type: "SAVE_SCENARIO", name, folderId, originalCreatedAt }, (res) => {
      if (!res?.success || !res.id) { showToast("Failed to save scenario", "error"); return; }
      scenarioName.value = "";
      scenarioFolder.value = "";
      _selectMade(res.id, name, folderId);
      showToast(`Saved "${name}" — press ▶ Play to run it`, "success");
    });
    _unlessTaken(name, folderId, save, { title: 'Save Scenario', okLabel: 'Save', verb: 'Save' });
  });
  // New: with a name typed, the scenario is created now and selected, so what is
  // recorded or added next saves straight into it. Without a name it clears the
  // working buffer for an unsaved draft, as before.
  newFlow.addEventListener('click', () => {
    const name = scenarioName.value.trim();
    if (name) { _createNamedScenario(name); return; }
    showConfirm("Create new empty scenario buffer? This will clear current unsaved actions.", () => {
      chrome.runtime.sendMessage({ type: "START_NEW_SCENARIO" }, () => {
      manualSelector.value = "";
      manualActionType.value = "";
      manualValue.value = "";
      resetManualValueMemory();
      manualValue.style.display = "none";
      try {
        scenarioList.value = "";
        toggleScenarioActions(false);
        chrome.storage.local.remove("lastSelectedScenario");
      } catch (e) {
        // ignore
      }
      actionsEl.innerHTML = `<li class="empty">New scenario (no actions)</li>`;
      });
    }, { title: 'New Scenario', okLabel: 'Continue' });
  });
}
