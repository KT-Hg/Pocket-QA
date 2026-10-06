/**
 * record/action-form.js — the Add Manual Action form: Child Condition, validation,
 * building the action from the form, editing an existing action.
 */

import { pickIndexError, pickStrings } from '../../shared/dropdown-pick.js';
import { isBlockCase, validateSwitch } from '../../shared/switch-blocks.js';
import { patternError } from '../../shared/text-pattern.js';
import { normalizeVarName, normalizeVarRef, selectorStrings } from '../../shared/var-name.js';
import { addManualAction, cancelEdit, conditionExpectedValue, conditionExpectedValueWrapper, conditionSkipCount, conditionType, manualActionType, manualDelay, manualSelector, manualValue, pickElement, pickedSelectorsInfo, pickedSelectorsWrap, scenarioList, selectorType } from '../dom.js';
import { ui } from '../ui-state.js';
import { debounce, isEligibleTab, safeSendTabMessage, showToast } from '../utils.js';
import { addVariableRow, newVariableConfig } from '../variables.js';
import { saveDraft } from './draft.js';
import { DEFAULT_DELAY_MS, TYPES_NO_SELECTOR, readdomMode, switchMode, updateDropdownForm, updateReaddomForm, updateStepLabels, updateConditionFieldsVisibility } from './form-fields.js';
import { collectManualFormState } from './form-state.js';
import { CHILD_COND_FIELDS, TYPE_FIELDS, VALUE_BOX, clearField, fillField } from './form-table.js';
import { clearPickedSelectorsPanel, selectorIsPicked, showFieldError, updateFrameNote, displayPickedDragdropTargetSelectors, displayPickedSelectors } from './picked-selectors.js';
import { renderConditionRunTo, previewActions } from './preview.js';
import { alwaysSwitchError, candidateActions, refreshSwitchContext, refreshSwitchForm, resetCaseEditor, switchSelfIdx, populateSwitchScenarioSelect, renderSwitchCaseList } from './switch-case-builder.js';
import { updateUndoRedoState } from './undo-redo.js';
import { resetManualValueMemory, seedManualValueMemory } from './value-memory.js';

/* === DELAY PRESET HELPER === */
export function setManualDelayUI(ms) {
  const preset = document.getElementById("manualDelayPreset");
  const custom = document.getElementById("manualDelay");
  if (!preset || !custom) return;
  const s = ms != null && ms !== "" ? String(ms) : "";
  const presetMatch = Array.from(preset.options).some(o => o.value === s && o.value !== "custom");
  if (!s) {
    preset.value = ""; custom.style.display = "none"; custom.value = "";
  } else if (presetMatch) {
    preset.value = s; custom.style.display = "none"; custom.value = "";
  } else {
    preset.value = "custom"; custom.style.display = ""; custom.value = s;
  }
}

/* === Child Condition toggle === */
export function hasChildCondData() {
  return CHILD_COND_FIELDS.some((f) => document.getElementById(f.id)?.value?.trim());
}

export function updateChildCondBadge() {
  const badge = document.getElementById("childConditionBadge");
  if (badge) badge.style.display = hasChildCondData() ? "" : "none";
}

export function setChildCondExpanded(expanded) {
  const toggle = document.getElementById("childConditionToggle");
  const body   = document.getElementById("childConditionBody");
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  body.style.display = expanded ? "block" : "none";
}

// Update badge when any child condition input changes
const _debouncedUpdateChildCondBadge = debounce(updateChildCondBadge, 120);

// Selector listener is registered at top already

function extractVarNames(action) {
  const VAR_RE = /\$\{([^}]+)\}/g;
  const names = new Set();
  const scan = (str) => {
    if (typeof str !== 'string') return;
    for (const m of str.matchAll(VAR_RE)) names.add(m[1]);
  };
  selectorStrings(action).forEach(scan);
  scan(action.attrName);
  scan(action.value);
  scan(action.url);
  scan(action.code);
  scan(action.expectedValue);
  scan(normalizeVarRef(action.switchVar));
  scan(action.folderPath);
  scan(action.fileName);
  if (Array.isArray(action.fileNames)) action.fileNames.forEach(n => scan(n));
  pickStrings(action).forEach(scan);
  if (action.conditions && typeof action.conditions === 'object') {
    Object.values(action.conditions).forEach(v => scan(String(v)));
  }
  return names;
}

function autoCreateMissingVariables(action) {
  const needed = extractVarNames(action);
  if (!needed.size) return;
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const existing = res?.variables || {};
    const newVars = [...needed].filter(n => !(n in existing));
    if (!newVars.length) return;
    const merged = { ...existing };
    newVars.forEach(n => { merged[n] = newVariableConfig(); });
    chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: merged }, () => {
      newVars.forEach(n => addVariableRow(n, merged[n]));
      showToast(`Auto-created variables: ${newVars.join(', ')}`, 'success');
    });
  });
}

// Types that don't require a selector field
const TYPES_NO_SELECTOR_REQUIRED = new Set([
  "script", "navigate", "screenshot", "screenshot_full",
  "screenshot_tovar", "wait", "switch"
]);

// Types whose Selector can be a parent searched with a Child Condition.
export const TYPES_CHILD_CONDITION = ["click", "input", "hover", "readdom"];

function validateActionForm(type, selector, delayVal) {
  if (!type) {
    return { valid: false, el: manualActionType, msg: "Action type is required" };
  }
  if (!selector && !TYPES_NO_SELECTOR_REQUIRED.has(type)) {
    return { valid: false, el: manualSelector, msg: "Selector is required for this action type" };
  }
  if (type === "navigate") {
    const urlValue = manualValue?.value?.trim();
    if (!urlValue) {
      return { valid: false, el: manualValue, msg: "URL is required for Navigate action" };
    }
  }
  if (type === "wait") {
    const d = parseInt(delayVal, 10);
    if (!delayVal || isNaN(d) || d <= 0) {
      return {
        valid: false,
        el: document.getElementById("manualDelayPreset"),
        msg: "Wait action requires a duration greater than 0ms",
        toastOnly: true,
      };
    }
  }
  if (type === "readdom") {
    if (readdomMode() === "part") {
      const patEl  = document.getElementById("readdomPattern");
      const patErr = patternError(patEl?.value);
      if (patErr) return { valid: false, el: patEl, msg: `Pattern: ${patErr}` };
    } else {
      const varEl = document.getElementById("readdomVarName");
      if (!normalizeVarName(varEl?.value)) {
        return { valid: false, el: varEl, msg: "Variable name is required (e.g. orderId — no ${ } and no })" };
      }
    }
    const from = document.getElementById("readdomReadFrom")?.value;
    const attrEl = document.getElementById("readdomAttrName");
    if (from === "attr" && !attrEl?.value?.trim()) {
      return { valid: false, el: attrEl, msg: "Attribute name is required when reading an attribute" };
    }
  }
  if (type === "dropdown" && document.getElementById("dropdownPickMode")?.value === "index") {
    const indexEl = document.getElementById("dropdownPickIndex");
    const indexErr = pickIndexError(indexEl?.value);
    if (indexErr) return { valid: false, el: indexEl, msg: indexErr };
  }
  if (type === "uploadFile") {
    const fp = document.getElementById("uploadFolderPath")?.value?.trim();
    const fns = (document.getElementById("uploadFileNames")?.value || "")
      .split("\n").map(s => s.trim()).filter(Boolean);
    if (!fp)        return { valid: false, el: document.getElementById("uploadFolderPath"), msg: "Folder path is required for Upload File action" };
    if (!fns.length) return { valid: false, el: document.getElementById("uploadFileNames"),  msg: "At least one file name is required for Upload File action" };
  }
  return { valid: true };
}

function buildActionFromForm(type, selector, value, delayVal) {
  const action = { type };

  if (selector) {
    action.selector = selector;
    if (selectorIsPicked(selector)) {
      action.selectors = ui.currentPickedSelectors;
      // Still the element that was picked → play it in the frame it was picked in.
      if (ui.currentPickedFrameId != null) action.frameId = ui.currentPickedFrameId;
    } else {
      // Typed selector differs from the picked element's — playback prefers
      // `selectors`, so it must describe the typed selector only.
      if (ui.currentPickedSelectors) clearPickedSelectorsPanel();
      action.selectors = { [selectorType?.value || 'css']: selector };
    }
  }

  const valueBox = VALUE_BOX.get(type);
  if (valueBox && value) action[valueBox.prop] = value;

  if (type === "readdom") {
    if (readdomMode() === "part") {
      // Each ${name} of the pattern is a variable — shared/text-pattern.js.
      const pattern = document.getElementById("readdomPattern")?.value?.trim() || "";
      if (patternError(pattern)) { showToast("A pattern with ${name} is required for Part of the text", "error"); return null; }
      action.pattern = pattern;
      if (document.getElementById("readdomMatchCase")?.checked) action.matchCase = true;
    } else {
      // Saved without ${ } so `${name}` in later steps finds it.
      const varName = normalizeVarName(document.getElementById("readdomVarName")?.value);
      if (!varName) { showToast("Variable name is required for Read DOM action", "error"); return null; }
      action.varName = varName;
    }
    action.readFrom = document.getElementById("readdomReadFrom")?.value || "text";
    const attrName  = document.getElementById("readdomAttrName")?.value?.trim();
    if (action.readFrom === "attr") {
      if (!attrName) { showToast("Attribute name is required when reading an attribute", "error"); return null; }
      action.attrName = attrName;
    }
  }

  if (type === "screenshot_tovar") {
    const varName = normalizeVarName(document.getElementById("screenshotTovarVarName")?.value);
    if (!varName) { showToast("Variable name is required for Screenshot → Variable", "error"); return null; }
    action.varName = varName;
    action.target  = document.getElementById("screenshotTovarTarget")?.value || "page";
    if (action.target === "element") {
      if (!selector) { showToast("Selector (①) is required for Element target", "error"); return null; }
      action.selector = selector;
    }
  }

  if (TYPES_CHILD_CONDITION.includes(type)) {
    const filled = CHILD_COND_FIELDS
      .map((f) => [f.prop, document.getElementById(f.id)?.value?.trim()])
      .filter(([, v]) => v);
    if (filled.length) {
      const mode = document.querySelector('input[name="condChildMatchMode"]:checked')?.value || "any";
      action.conditions = { matchMode: mode, ...Object.fromEntries(filled) };
    }
  }

  if (type === "dragdrop") {
    const target = document.getElementById("dragdropTarget")?.value?.trim();
    if (!target) { showToast("Drop target selector is required for Drag & Drop action", "error"); return null; }
    action.targetSelector  = target;
    const dtSelectorType   = document.getElementById("dragdropTargetSelectorType")?.value || "css";
    action.targetSelectors = ui.currentPickedDragdropTargetSelectors || { [dtSelectorType]: target };
  }

  if (type === "dropdown" && document.getElementById("dropdownPickMode")?.value === "index") {
    // Saved as written: a ${var} is replaced when it plays.
    action.pick = { by: "index", index: document.getElementById("dropdownPickIndex")?.value?.trim() || "" };
    const itemSelector = document.getElementById("dropdownItemSelector")?.value?.trim();
    if (itemSelector) action.pick.itemSelector = itemSelector;
  }

  if (type === "uploadFile") {
    action.uploadMode = document.getElementById("uploadMode")?.value || "input";
    action.folderPath = document.getElementById("uploadFolderPath")?.value?.trim() || "";
    action.fileNames  = (document.getElementById("uploadFileNames")?.value || "")
      .split("\n").map(s => s.trim()).filter(Boolean);
  }

  if (type === "condition") {
    action.conditionType = conditionType?.value || "elementExists";
    action.expectedValue = conditionExpectedValue?.value?.trim() || "";
    // "0" = guards nothing: stored as `empty` since older code reads a skipCount of 0 as 1.
    const skip = parseInt(conditionSkipCount?.value, 10);
    action.skipCount     = skip || 1;
    if (skip === 0) action.empty = true;
  }

  if (type === "switch") {
    // A bare `role` is saved as `${role}`: only a `${…}` reference is substituted.
    // Always mode saves no variable: then only its default case can match.
    const always    = switchMode() === "always";
    const switchVar = always ? "" : normalizeVarRef(document.getElementById("switchVar")?.value);
    const alwaysErr = alwaysSwitchError();
    if (alwaysErr)        { showToast(alwaysErr, "error"); return null; }
    if (!always && !switchVar) { showToast("Variable is required for Switch action, e.g. ${role}", "error"); return null; }
    if (!ui._switchCases.length) { showToast("Add at least one case to the Switch", "error"); return null; }
    action.switchVar = switchVar;
    action.cases     = ui._switchCases.map(c => ({ ...c }));
    // Only a Switch with a block has somewhere to continue; left out when
    // automatic, so an untouched old Switch saves exactly as it was.
    if (ui._switchContinueAt != null && action.cases.some(isBlockCase)) action.continueAt = ui._switchContinueAt;
    const { errors } = validateSwitch(candidateActions({ ...action }), switchSelfIdx());
    if (errors.length) { showToast(errors[0], "error"); return null; }
  }

  if (delayVal) {
    const d = parseInt(delayVal, 10);
    if (!isNaN(d) && d > 0) action.delay = d;
  }

  const labelVal = document.getElementById("manualLabel")?.value?.trim();
  if (labelVal) action.label = labelVal;

  return action;
}

export function startEdit(index, action) {
  clearEditState();
  manualSelector.value = action.selector || "";
  manualActionType.value = action.type || "";

  // Show/hide selector section based on type
  const selectorSection = document.getElementById("selectorSection");
  if (selectorSection) {
    const ssTovarTargetVal = action.target || "page";
    const hideSelector = TYPES_NO_SELECTOR.has(action.type) ||
      (action.type === "screenshot_tovar" && ssTovarTargetVal !== "element");
    selectorSection.style.display = hideSelector ? "none" : "block";
  }

  // Restore selectors if available
  ui.currentPickedFrameId = action.frameId ?? null;
  if (action.selectors) {
    ui.currentPickedSelectors = action.selectors;
    displayPickedSelectors(action.selectors);
  } else {
    ui.currentPickedSelectors = null;
    if (pickedSelectorsInfo) {
      pickedSelectorsWrap.style.display = "none";
    }
  }

  // Show/hide value and delay wrappers
  const manualValueWrapper = document.getElementById("manualValueWrapper");
  const manualDelayWrapper = document.getElementById("manualDelayWrapper");

  // Reset inline display that clearEditState sets directly on the textarea
  manualValue.style.display = "";

  // The Value box (clearEditState emptied it), then the type's own section and
  // fields — record/form-table.js
  const valueBox = VALUE_BOX.get(action.type);
  if (manualValueWrapper) manualValueWrapper.style.display = valueBox ? "block" : "none";
  if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
  if (valueBox) {
    manualValue.value = valueBox.fromAction ? valueBox.fromAction(action) : (action[valueBox.prop] || "");
    manualValue.placeholder = valueBox.placeholder;
  }
  const section = TYPE_FIELDS.get(action.type);
  if (section) {
    const wrap = document.getElementById(section.wrapper);
    if (wrap) wrap.style.display = "block";
    for (const f of section.fields) fillField(f, action);
  }
  _afterFieldsFilled(action, selectorSection);

  // Tie the textarea contents to this action's type so a later type switch
  // stashes it instead of discarding it.
  seedManualValueMemory(action.type, manualValue.value);

  // For wait: support old actions that stored duration in action.value.
  // A Switch without a delay opens without one, so saving it untouched
  // gives back exactly the action that was stored.
  let delayForUI;
  if (action.type === "wait") delayForUI = String(action.delay || action.value || DEFAULT_DELAY_MS);
  else if (action.delay) delayForUI = String(action.delay);
  else if (action.type === "switch") delayForUI = "";
  else delayForUI = DEFAULT_DELAY_MS;
  setManualDelayUI(delayForUI);

  // Restore child condition fields
  const childCondWrap = document.getElementById("childConditionWrapper");
  if (childCondWrap) {
    const supportsChildCondition = TYPES_CHILD_CONDITION.includes(action.type);
    childCondWrap.style.display = supportsChildCondition ? "block" : "none";
  }
  const restoredMode  = action.conditions?.matchMode || "any";
  const radioAny = document.getElementById("condChildMatchAny");
  const radioAll = document.getElementById("condChildMatchAll");
  if (radioAny) radioAny.checked = restoredMode === "any";
  if (radioAll) radioAll.checked = restoredMode === "all";
  for (const f of CHILD_COND_FIELDS) {
    const el = document.getElementById(f.id);
    if (el) el.value = action.conditions?.[f.prop] || "";
  }
  // Auto-expand if there is existing condition data
  setChildCondExpanded(CHILD_COND_FIELDS.some((f) => action.conditions?.[f.prop]));
  updateChildCondBadge();

  const manualLabelEl = document.getElementById("manualLabel");
  const manualLabelWrapper = document.getElementById("manualLabelWrapper");
  if (manualLabelEl) manualLabelEl.value = action.label || "";
  if (manualLabelWrapper) manualLabelWrapper.style.display = "block";

  ui.editing = { scenarioId: scenarioList.value || null, index };
  addManualAction.textContent = "Save Edit";
  cancelEdit.style.display = "inline-block";
  updateStepLabels();
  saveDraft();
}

export function clearEditState() {
  ui.editing = null;
  manualSelector.value = "";
  manualActionType.value = "";
  manualValue.value = "";
  resetManualValueMemory();
  setManualDelayUI(DEFAULT_DELAY_MS);
  manualValue.style.display = "none";
  addManualAction.textContent = "Add Action";
  cancelEdit.style.display = "none";
  ui.currentPickedSelectors = null;
  ui.currentPickedFrameId = null;
  updateFrameNote();
  if (pickedSelectorsWrap) { pickedSelectorsWrap.style.display = "none"; }
  if (pickedSelectorsInfo) { pickedSelectorsInfo.innerHTML = ""; }
  if (selectorType) selectorType.value = "css";

  // Reset selectorSection and value/delay wrappers
  const _selectorSection = document.getElementById("selectorSection");
  if (_selectorSection) _selectorSection.style.display = "none";
  const _valWrap = document.getElementById("manualValueWrapper");
  if (_valWrap) _valWrap.style.display = "none";
  const _delWrap = document.getElementById("manualDelayWrapper");
  if (_delWrap) _delWrap.style.display = "none";
  const _lblWrap = document.getElementById("manualLabelWrapper");
  if (_lblWrap) _lblWrap.style.display = "none";

  // Every type's own section hidden and its fields emptied — record/form-table.js
  for (const { wrapper, fields } of TYPE_FIELDS.values()) {
    const wrap = document.getElementById(wrapper);
    if (wrap) wrap.style.display = "none";
    fields.forEach(clearField);
  }
  if (conditionExpectedValueWrapper) conditionExpectedValueWrapper.style.display = "none";

  // dragdrop: the picked drop target
  ui.currentPickedDragdropTargetSelectors = null;
  const pickedDdTargetWrap = document.getElementById("pickedDragdropTargetWrap");
  if (pickedDdTargetWrap) pickedDdTargetWrap.style.display = "none";
  const pickedDdTargetInfo = document.getElementById("pickedDragdropTargetInfo");
  if (pickedDdTargetInfo) pickedDdTargetInfo.innerHTML = "";

  // readdom
  const readdomAttrName = document.getElementById("readdomAttrName");
  if (readdomAttrName) readdomAttrName.style.display = "none";
  updateReaddomForm();

  // dropdown: back to "Only open it"
  updateDropdownForm();

  // switch: its cases and everything shown for them
  ui._switchCases = [];
  ui._switchContinueAt = null;
  ui._switchVarStash = null;
  const switchValClear = document.getElementById("switchValidation");
  if (switchValClear) { switchValClear.innerHTML = ""; switchValClear.style.display = "none"; }
  const switchContRowClear = document.getElementById("switchContinueRow");
  if (switchContRowClear) switchContRowClear.style.display = "none";
  resetCaseEditor();
  const switchCaseListClear = document.getElementById("switchCaseList");
  if (switchCaseListClear) switchCaseListClear.innerHTML = "";

  const manualLabelEl = document.getElementById("manualLabel");
  if (manualLabelEl) manualLabelEl.value = "";

  // Reset child condition fields
  const childCondWrapClear = document.getElementById("childConditionWrapper");
  if (childCondWrapClear) childCondWrapClear.style.display = "none";
  const radioAnyClear = document.getElementById("condChildMatchAny");
  const radioAllClear = document.getElementById("condChildMatchAll");
  if (radioAnyClear) radioAnyClear.checked = true;
  if (radioAllClear) radioAllClear.checked = false;
  for (const f of CHILD_COND_FIELDS) {
    const el = document.getElementById(f.id);
    if (el) el.value = "";
  }
  setChildCondExpanded(false);
  updateChildCondBadge();
}

/** startEdit: what a type needs once its fields are filled in. */
function _afterFieldsFilled(action, selectorSection) {
  switch (action.type) {
    case "screenshot":
    case "screenshot_full":
      // Hide pickedSelectorsInfo for screenshot
      if (pickedSelectorsInfo) {
        pickedSelectorsWrap.style.display = "none";
      }
      break;
    case "screenshot_tovar":
      document.getElementById("screenshotTovarTarget")?.dispatchEvent(new Event("change"));
      if (action.target === "element" && action.selector) {
        manualSelector.value = action.selector;
      }
      break;
    case "dragdrop":
      // The picked drop target's selectors, if it was picked
      if (action.targetSelectors) {
        displayPickedDragdropTargetSelectors(action.targetSelectors);
      } else {
        const pickedDdWrap = document.getElementById("pickedDragdropTargetWrap");
        if (pickedDdWrap) pickedDdWrap.style.display = "none";
      }
      break;
    case "readdom": {
      const readdomAttrName = document.getElementById("readdomAttrName");
      if (readdomAttrName) readdomAttrName.style.display = action.readFrom === "attr" ? "block" : "none";
      updateReaddomForm();
      break;
    }
    case "condition":
      updateConditionFieldsVisibility();
      refreshSwitchContext(() => renderConditionRunTo());
      break;
    case "dropdown":
      updateDropdownForm();
      break;
    case "switch": {
      ui._switchCases = (action.cases || []).map(c => ({ ...c }));
      ui._switchVarStash = null;
      const cont = parseInt(action.continueAt, 10);
      ui._switchContinueAt = Number.isFinite(cont) ? cont : null;
      resetCaseEditor();
      populateSwitchScenarioSelect();
      renderSwitchCaseList();
      // The From / To lists need the scenario's actions and this Switch's index.
      refreshSwitchContext(() => refreshSwitchForm());
      if (selectorSection) selectorSection.style.display = "none";
      break;
    }
  }
}

export function initActionForm() {
  document.getElementById("childConditionToggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("childConditionToggle");
    const expanded = toggle?.getAttribute("aria-expanded") === "true";
    setChildCondExpanded(!expanded);
  });
  ["condChildValueEquals","condChildTextContains","condChildIdContains","condChildClassContains","condChildType"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", _debouncedUpdateChildCondBadge);
    document.getElementById(id)?.addEventListener("change", updateChildCondBadge);
  });
  pickElement.addEventListener('click', () => {
    ui.pickerMode = !ui.pickerMode;
    pickElement.textContent = ui.pickerMode ? "✓ Pick Mode" : "🎯";
    pickElement.classList.toggle('picker-active', ui.pickerMode);

    // Save the WHOLE form before picking — the popup is closed and rebuilt below,
    // so anything not snapshotted here (child condition, condition, readdom,
    // upload, switch, dragdrop, label…) would be gone when it reopens.
    if (ui.pickerMode) {
      chrome.storage.local.set({
        pendingEdit: {
          ...(ui.editing || {}),
          ...collectManualFormState(),
          isNew: !ui.editing,
        }
      });
    }

    // Clear any stale Capture pick flag so R&P pick is not mistaken for a screenshot pick
    if (ui.pickerMode) chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);

    // Broadcast pick mode toggle to all tabs
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      if (!isEligibleTab(tab)) return;

      const type = ui.pickerMode ? "START_PICK_MODE" : "STOP_PICK_MODE";

      safeSendTabMessage(tab.id, { type });

      // Notify background to update badge for this tab
      chrome.runtime.sendMessage({ type, tabId: tab.id });

      // Show instruction bar briefly before popup closes
      if (ui.pickerMode) {
        const pickerBar = document.getElementById('pickerInstructionBar');
        if (pickerBar) { pickerBar.textContent = '🎯 Click an element on the page to select it. Reopen popup to cancel.'; pickerBar.classList.add('show'); }
        window.close();
      } else {
        document.getElementById('pickerInstructionBar')?.classList.remove('show');
      }
    });
  });
  addManualAction.addEventListener('click', () => {
    const selector  = manualSelector.value?.trim() || "";
    const type      = manualActionType.value?.trim() || "";
    const value     = manualValue.value?.trim() || "";
    const preset    = document.getElementById("manualDelayPreset");
    const delayVal  = (preset?.value === "custom")
      ? (manualDelay.value?.trim() || "")
      : (preset?.value || "");

    const check = validateActionForm(type, selector, delayVal);
    if (!check.valid) {
      if (check.toastOnly) {
        if (check.el) showFieldError(check.el, check.msg);
        showToast(check.msg, "error");
      } else {
        showFieldError(check.el, check.msg);
        check.el?.focus();
      }
      return;
    }

    const action = buildActionFromForm(type, selector, value, delayVal);
    if (!action) return; // buildActionFromForm already showed a toast

    autoCreateMissingVariables(action);

    const onDone = () => {
      clearEditState();
      chrome.storage.local.remove("manualFormDraft");
      previewActions();
      updateUndoRedoState();
    };

    if (ui.editing) {
      chrome.runtime.sendMessage({
        type: "UPDATE_ACTION",
        scenarioId: ui.editing.scenarioId,
        index: ui.editing.index,
        action,
      }, onDone);
    } else {
      chrome.runtime.sendMessage({
        type: "ADD_MANUAL_ACTION",
        action,
        scenarioId: scenarioList.value || null,
      }, onDone);
    }
  });
  cancelEdit.addEventListener('click', () => {
    clearEditState();
    chrome.storage.local.remove("manualFormDraft");
  });
}
