/**
 * record/draft.js — keeps an unsaved Add Manual Action form across popup close /
 * reopen.
 */

import { addManualAction, cancelEdit, manualActionType } from '../dom.js';
import { ui } from '../ui-state.js';
import { debounce } from '../utils.js';
import { applyManualFormState, collectManualFormState } from './form-state.js';

/* === DRAFT: persist Add Manual Action card across popup close/reopen === */

export function saveDraft() {
  // Don't overwrite pick-mode saves (those use pendingEdit)
  if (ui.pickerMode) return;

  const card = document.getElementById("addManualActionCard");
  const cardOpen = card && !card.classList.contains("collapsed");
  const type = manualActionType.value;

  // Only save if card is open or we're in edit mode
  if (!cardOpen && !ui.editing) return;
  // Don't save if nothing meaningful is in the form
  if (!type && !ui.editing) return;

  const draft = {
    ...collectManualFormState(),
    cardOpen,
    // editing state
    editing: ui.editing ? { scenarioId: ui.editing.scenarioId, index: ui.editing.index } : null,
    scenarioId: document.getElementById("scenarioList")?.value || null,
  };

  chrome.storage.local.set({ manualFormDraft: draft });
}

export function restoreDraft(draft) {
  if (!draft) return;

  // Restore editing state
  if (draft.editing) {
    ui.editing = draft.editing;
    addManualAction.textContent = "Save Edit";
    cancelEdit.style.display = "inline-block";
  }

  // Restore scenario
  if (draft.scenarioId) {
    const sl = document.getElementById("scenarioList");
    if (sl) sl.value = draft.scenarioId;
  }

  applyManualFormState(draft);

  // Open card
  if (draft.cardOpen || draft.editing) {
    const card = document.getElementById("addManualActionCard");
    if (card?.classList.contains("collapsed")) card.classList.remove("collapsed");
  }
}

// Save draft continuously (debounced) so Chrome popup close doesn't lose async writes
export const debouncedSaveDraft = debounce(saveDraft, 600);

export function initDraft() {
  [
    "manualActionType", "selectorType", "manualSelector",
    "manualValue", "manualDelayPreset", "manualDelay", "manualLabel",
    "dragdropTarget", "dragdropTargetSelectorType",
    "conditionType", "conditionExpectedValue", "conditionSkipCount",
    "condChildValueEquals", "condChildTextContains", "condChildIdContains",
    "condChildClassContains", "condChildType",
    "readdomVarName", "readdomReadFrom", "readdomAttrName",
    "readdomPattern", "readdomMatchCase", "readdomTryText",
    "screenshotTovarVarName", "screenshotTovarTarget",
    "switchVar",
    "uploadMode", "uploadFolderPath", "uploadFileNames",
    "dropdownPickMode", "dropdownPickIndex", "dropdownItemSelector",
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", debouncedSaveDraft);
      el.addEventListener("change", debouncedSaveDraft);
    }
  });
  document.getElementById("condChildMatchAny")?.addEventListener("change", debouncedSaveDraft);
  document.getElementById("condChildMatchAll")?.addEventListener("change", debouncedSaveDraft);
  document.querySelectorAll('input[name="readdomMode"]').forEach(r => r.addEventListener("change", debouncedSaveDraft));
  document.querySelectorAll('input[name="switchMode"]').forEach(r => r.addEventListener("change", debouncedSaveDraft));
}
