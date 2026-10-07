/**
 * record/form-state.js — the whole Add Manual Action form as a plain object and
 * back (for the draft and for editing).
 */

import { addManualAction, cancelEdit, manualActionType, manualSelector, manualValue } from '../dom.js';
import { ui } from '../ui-state.js';
import { hasChildCondData, setChildCondExpanded, updateChildCondBadge, setManualDelayUI } from './form-widgets.js';
import { DEFAULT_DELAY_MS, updateDropdownForm, updateReaddomForm, updateStepLabels, updateConditionFieldsVisibility } from './form-fields.js';
import { CHILD_COND_FIELDS, TYPE_FIELDS, applyDraftValue, draftFields } from './form-table.js';
import { updateFrameNote, displayPickedDragdropTargetSelectors, displayPickedSelectors } from './picked-selectors.js';
import { renderConditionRunTo } from './preview.js';
import { refreshSwitchContext, refreshSwitchForm, resetCaseEditor, populateSwitchScenarioSelect } from './switch-case-builder.js';
import { rememberManualValue, seedManualValueMemory, valueByType } from './value-memory.js';

/* === FORM STATE SNAPSHOT ===
 * One shared shape for every place that has to put the Add Action card away and
 * bring it back: the draft (popup close/reopen) and the 🎯 pick round-trip.
 * Both collect and apply cover EVERY field regardless of the selected action
 * type, so nothing typed under one type is lost by switching to another.
 */

export function collectManualFormState() {
  rememberManualValue(); // flush the live textarea into the per-type map

  return {
    actionType:  manualActionType.value,
    selector:    manualSelector.value?.trim() || "",
    selectorType: document.getElementById("selectorType")?.value || "css",
    // Chosen from the menu (saved as selectorType / targetSelectorType).
    selectorTypeChosen: document.getElementById("selectorType")?.dataset.chosen === "1",
    dragdropTargetTypeChosen: document.getElementById("dragdropTargetSelectorType")?.dataset.chosen === "1",
    pickedSelectors: ui.currentPickedSelectors || null,
    pickedFrameId:   ui.currentPickedFrameId,
    value:       manualValue.value || "",
    valueByType: { ...valueByType },
    delay:       (() => {
      const preset = document.getElementById("manualDelayPreset");
      return preset?.value === "custom"
        ? (document.getElementById("manualDelay")?.value?.trim() || "")
        : (preset?.value || "");
    })(),
    delayPreset: document.getElementById("manualDelayPreset")?.value ?? "500", // "" = No delay
    label:       document.getElementById("manualLabel")?.value?.trim() || "",

    // Each type's own fields go under their element ids — record/form-table.js.
    ...draftFields("dragdrop"),
    pickedDragdropTargetSelectors: ui.currentPickedDragdropTargetSelectors || null,

    ...draftFields("condition"),
    childCond: {
      matchAny: document.getElementById("condChildMatchAny")?.checked ?? true,
      ...Object.fromEntries(CHILD_COND_FIELDS.map((f) => [f.draftKey, document.getElementById(f.id)?.value?.trim() || ""])),
    },
    childCondExpanded: document.getElementById("childConditionToggle")?.getAttribute("aria-expanded") === "true",

    ...draftFields("readdom"),
    ...draftFields("screenshot_tovar"),

    ...draftFields("switch"),
    switchCases: ui._switchCases ? [...ui._switchCases] : [],
    switchContinueAt: ui._switchContinueAt,

    ...draftFields("uploadFile"),
    ...draftFields("dropdown"),
  };
}

/**
 * Edit mode on (`{ scenarioId, index }`) or off (null): ui.editing and what the
 * card shows for it — its title, Save Edit / Add Action, Cancel. Every way into
 * an edit comes through here: Edit on an action, a restored draft, a pick.
 */
export function setEditing(editing) {
  ui.editing = editing;
  const title = document.getElementById("manualCardTitle");
  if (title) title.textContent = editing ? `Edit Action #${editing.index + 1}` : "Add Manual Action";
  addManualAction.textContent = editing ? "Save Edit" : "Add Action";
  cancelEdit.style.display = editing ? "inline-block" : "none";
}

export function applyManualFormState(state) {
  if (!state) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ""; };
  // `actionValue` / `actionDelay*` = legacy pendingEdit shape from older versions
  const value = state.value ?? state.actionValue ?? "";
  const type  = state.actionType || "";

  /* --- Type-specific fields first: manualActionType.onchange reads
         conditionType / screenshotTovarTarget to decide selector visibility. --- */
  for (const { fields } of TYPE_FIELDS.values()) {
    for (const f of fields) applyDraftValue(f, state);
  }

  // dragdrop: the picked drop target
  if (state.pickedDragdropTargetSelectors) {
    ui.currentPickedDragdropTargetSelectors = state.pickedDragdropTargetSelectors;
    displayPickedDragdropTargetSelectors(ui.currentPickedDragdropTargetSelectors);
  }

  // child condition
  const cc = state.childCond || {};
  const radioAny = document.getElementById("condChildMatchAny");
  const radioAll = document.getElementById("condChildMatchAll");
  if (radioAny) radioAny.checked = cc.matchAny !== false;
  if (radioAll) radioAll.checked = cc.matchAny === false;
  for (const f of CHILD_COND_FIELDS) set(f.id, cc[f.draftKey]);

  // switch: its cases
  ui._switchCases = state.switchCases ? state.switchCases.map(c => ({ ...c })) : [];
  ui._switchVarStash = null;
  resetCaseEditor();
  ui._switchContinueAt = Number.isFinite(state.switchContinueAt) ? state.switchContinueAt : null;

  // label
  set("manualLabel", state.label);

  /* --- Core fields --- */
  manualSelector.value   = state.selector || "";
  manualActionType.value = type;
  manualValue.value      = value;
  seedManualValueMemory(type, value, state.valueByType);
  setManualDelayUI(state.delay ?? state.actionDelay ?? DEFAULT_DELAY_MS);
  const presetEl = document.getElementById("manualDelayPreset");
  const preset   = state.delayPreset ?? state.actionDelayPreset;
  if (presetEl && preset != null) presetEl.value = preset;

  // Drives all wrapper visibility off the now fully-populated fields
  manualActionType.onchange?.();

  /* --- Post-visibility touch-ups ---
     onchange above already resolved every wrapper's display from the populated
     fields; #pickedSelectorsWrap lives inside #selectorSection so it follows. */
  if (state.selectorType) set("selectorType", state.selectorType);
  if (state.pickedSelectors) {
    ui.currentPickedSelectors = state.pickedSelectors;
    displayPickedSelectors(ui.currentPickedSelectors);
  }
  ui.currentPickedFrameId = state.pickedFrameId ?? null;
  updateFrameNote();
  const attrEl = document.getElementById("readdomAttrName");
  if (attrEl) attrEl.style.display = (state.readdomReadFrom === "attr") ? "block" : "none";
  updateReaddomForm();
  updateDropdownForm();
  if (type === "condition") updateConditionFieldsVisibility?.();
  if (type === "switch") { populateSwitchScenarioSelect?.(); refreshSwitchContext(() => refreshSwitchForm()); }
  if (type === "condition") refreshSwitchContext(() => renderConditionRunTo());
  setChildCondExpanded(state.childCondExpanded ?? hasChildCondData());
  updateChildCondBadge?.();
  updateStepLabels?.();
  // Last: writing a select's value clears its mark.
  const markChosen = (id, on) => { const el = document.getElementById(id); if (el && on) el.dataset.chosen = "1"; };
  markChosen("selectorType", state.selectorTypeChosen);
  markChosen("dragdropTargetSelectorType", state.dragdropTargetTypeChosen);
}
