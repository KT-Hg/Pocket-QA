/**
 * scenarios/save.js — saving the current recording as a scenario, and "New".
 */

import { actionsEl, filterFolder, manualActionType, manualSelector, manualValue, newFlow, saveFlow, scenarioFolder, scenarioList, scenarioName, scenarioSearch } from '../dom.js';
import { clearEditState } from '../record/action-form.js';
import { showFieldError } from '../record/picked-selectors.js';
import { resetManualValueMemory } from '../record/value-memory.js';
import { ui } from '../ui-state.js';
import { showConfirm, showToast } from '../utils.js';
import { toggleScenarioActions } from './scenario-actions.js';
import { loadScenarios } from './scenario-list.js';

function _createNamedScenario(name) {
  const folderId = scenarioFolder.value || null;
  const create = () => chrome.runtime.sendMessage({ type: "CREATE_SCENARIO", name, folderId }, (res) => {
    if (!res?.success || !res.id) { showToast("Failed to create scenario", "error"); return; }
    if (ui.editing) { clearEditState(); chrome.storage.local.remove("manualFormDraft"); }
    scenarioName.value = "";
    scenarioName.classList.remove("required-error");
    // A search or folder filter in Manage Scenarios could hide the new one,
    // and only a listed scenario can be the selected one.
    const term = (scenarioSearch?.value || "").trim().toLowerCase();
    if (term && !name.toLowerCase().includes(term)) scenarioSearch.value = "";
    if (filterFolder?.value && filterFolder.value !== (folderId || "__none__")) filterFolder.value = "";
    // loadScenarios selects whatever lastSelectedScenario names.
    chrome.storage.local.set({ lastSelectedScenario: res.id }, () => loadScenarios());
    showToast(`Created "${name}" — what you add or edit now saves into it`, "success");
  });
  const taken = Object.values(ui.scenariosCache).some(s => s.name === name && (s.folderId || null) === folderId);
  if (taken) {
    showConfirm(`A scenario named "${name}" is already in this folder. Create another one with the same name?`, create, { title: 'New Scenario', okLabel: 'Create' });
  } else {
    create();
  }
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

    chrome.runtime.sendMessage({ type: "SAVE_SCENARIO", name, folderId, originalCreatedAt }, (res) => {
      scenarioName.value = "";
      scenarioFolder.value = "";
      loadScenarios();
      if (res?.success) showToast("Scenario saved", "success");
      else showToast("Failed to save scenario", "error");
    });
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
