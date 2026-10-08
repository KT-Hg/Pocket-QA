/**
 * record/value-memory.js — remembers what was typed in the Value field per action
 * type while the form switches types.
 */

import { conditionType, conditionWrapper, manualActionType, manualValue, pickedSelectorsInfo, pickedSelectorsWrap } from '../dom.js';
import { CONDITION_NO_SELECTOR, TYPES_CHILD_CONDITION, TYPES_NO_SELECTOR, updateDropdownForm, updateStepLabels, updateConditionFieldsVisibility } from './form-fields.js';
import { VALUE_BOX, showClickThroughFor } from './form-table.js';
import { renderConditionRunTo } from './preview.js';
import { refreshSwitchContext, refreshSwitchForm, populateSwitchScenarioSelect } from './switch-case-builder.js';

/* === ADD MANUAL ACTION === */

/* === VALUE FIELD MEMORY (per action type) ===
 * #manualValue is a single textarea shared by input / navigate / script /
 * screenshot, where it means four different things (value, URL, JS code,
 * filename). Keep one stashed copy per action type so switching the type never
 * destroys what was already typed for another type — and never leaks JS code
 * into the "value" of an input action.
 * Every other field has its own dedicated element, so it survives a type switch
 * on its own (the wrappers are only hidden, never cleared).
 */
export const valueByType = Object.create(null);

let _valueMemoryType = "";   // action type the textarea currently holds

export function rememberManualValue() {
  if (_valueMemoryType) valueByType[_valueMemoryType] = manualValue.value;
}

/** Point the textarea at `type`, stashing the outgoing value first. */
function _syncManualValueForType(type) {
  if ((type || "") === _valueMemoryType) return;
  rememberManualValue();
  manualValue.value = valueByType[type] ?? "";
  _valueMemoryType = type || "";
}

/** Seed from a restored/edited action so the next onchange won't blank it. */
export function seedManualValueMemory(type, value, map) {
  if (map) Object.assign(valueByType, map);
  _valueMemoryType = type || "";
  if (type) valueByType[type] = value ?? "";
}

/**
 * Shape the Value box for `type` (VALUE_BOX): its placeholder and its kind.
 * Returns the type's box, or undefined when the type shows none.
 */
export function applyValueBox(type) {
  const box = VALUE_BOX.get(type);
  if (box) {
    manualValue.placeholder = box.placeholder;
    manualValue.dataset.kind = box.kind;
  }
  return box;
}

export function resetManualValueMemory() {
  for (const k of Object.keys(valueByType)) delete valueByType[k];
  _valueMemoryType = "";
}

export function initValueMemory() {
  manualActionType.onchange = () => {
    const type = manualActionType.value;
    // Carry the value textarea over to the new type without losing the old text.
    _syncManualValueForType(type);
    const manualValueWrapper = document.getElementById("manualValueWrapper");
    const manualDelayWrapper = document.getElementById("manualDelayWrapper");
    const selectorSection    = document.getElementById("selectorSection");

    // --- Selector section ---
    // screenshot_tovar shows selector only when target = element
    const ssTovarTarget = document.getElementById("screenshotTovarTarget");
    const isConditionUrlType = type === "condition" && CONDITION_NO_SELECTOR.includes(conditionType ? conditionType.value : "");
    const showSelector = !TYPES_NO_SELECTOR.has(type) &&
      type !== "" &&
      !(type === "screenshot_tovar" && ssTovarTarget?.value !== "element") &&
      !isConditionUrlType;
    if (selectorSection) selectorSection.style.display = showSelector ? "block" : "none";
    if (pickedSelectorsInfo && !showSelector) pickedSelectorsWrap.style.display = "none";

    // --- Special wrappers ---
    if (conditionWrapper) {
      conditionWrapper.style.display = type === "condition" ? "block" : "none";
      if (type === "condition") {
        updateConditionFieldsVisibility();
        refreshSwitchContext(() => renderConditionRunTo());
      }
    }

    const readdomWrapper = document.getElementById("readdomWrapper");
    if (readdomWrapper) readdomWrapper.style.display = type === "readdom" ? "block" : "none";

    const dropdownWrapper = document.getElementById("dropdownWrapper");
    if (dropdownWrapper) {
      dropdownWrapper.style.display = type === "dropdown" ? "block" : "none";
      if (type === "dropdown") updateDropdownForm();
    }

    const dragdropWrapper = document.getElementById("dragdropWrapper");
    if (dragdropWrapper) dragdropWrapper.style.display = type === "dragdrop" ? "block" : "none";

    const ssTovarWrapper = document.getElementById("screenshotTovarWrapper");
    if (ssTovarWrapper) ssTovarWrapper.style.display = type === "screenshot_tovar" ? "block" : "none";

    const switchWrapper = document.getElementById("switchWrapper");
    if (switchWrapper) {
      switchWrapper.style.display = type === "switch" ? "block" : "none";
      if (type === "switch") {
        populateSwitchScenarioSelect();
        refreshSwitchContext(() => refreshSwitchForm());
      }
    }

    const uploadFileWrapper = document.getElementById("uploadFileWrapper");
    if (uploadFileWrapper) uploadFileWrapper.style.display = type === "uploadFile" ? "block" : "none";

    const childConditionWrapper = document.getElementById("childConditionWrapper");
    if (childConditionWrapper) {
      childConditionWrapper.style.display = TYPES_CHILD_CONDITION.includes(type) ? "block" : "none";
    }
    const childSubtitle = document.getElementById("childConditionSubtitle");
    if (childSubtitle) {
      childSubtitle.textContent = `(optional — find child element to ${type === "readdom" ? "read" : "act on"})`;
    }

    // --- Value field ---
    manualValueWrapper.style.display = applyValueBox(type) ? "block" : "none";
    manualValue.style.display = "";

    // --- Delay & Label ---
    manualDelayWrapper.style.display = type ? "block" : "none";
    const manualLabelWrapper = document.getElementById("manualLabelWrapper");
    if (manualLabelWrapper) manualLabelWrapper.style.display = type ? "block" : "none";
    showClickThroughFor(type);

    if (type !== "condition") updateStepLabels();
  };
}
