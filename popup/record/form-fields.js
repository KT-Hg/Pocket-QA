/**
 * record/form-fields.js — which fields of the Add Manual Action form show for
 * the chosen type: step labels, Condition fields, Read DOM and Screenshot →
 * Variable options.
 */

import { extractWithPattern, patternError, patternVarNames } from '../../shared/text-pattern.js';
import { normalizeVarName } from '../../shared/var-name.js';
import { conditionExpectedValue, conditionExpectedValueWrapper, conditionType, manualActionType, pickedSelectorsInfo, pickedSelectorsWrap } from '../dom.js';
import { ui } from '../ui-state.js';

// Condition types that don't need selector or expected value
export const CONDITION_NO_SELECTOR = ["urlContains", "urlEquals"];

const CONDITION_NO_EXPECTED_VALUE = ["elementExists", "elementNotExists", "elementVisible", "elementHidden"];

// Label and example for the value each condition type compares against.
const CONDITION_VALUE_HINTS = {
  textContains:  ["Text",      "text it contains"],
  textEquals:    ["Text",      "the exact text"],
  valueContains: ["Value",     "part of the field's value"],
  valueEquals:   ["Value",     "the field's exact value"],
  urlContains:   ["URL",       "part of the URL, e.g. /checkout"],
  urlEquals:     ["URL",       "the full URL"],
  hasClass:      ["Class",     "class name, e.g. active"],
  hasAttribute:  ["Attribute", "attribute name, e.g. disabled"],
};

/* === Default delay (ms) for all new actions === */
export const DEFAULT_DELAY_MS = "500";

/* === Types that never need a selector === */
export const TYPES_NO_SELECTOR = new Set(["navigate", "wait", "script", "screenshot", "screenshot_full", "switch"]);

/* === Step labels: their text, and whether they read as optional ===
   The Condition and Screenshot → Variable sections ahead of the selector keep
   fixed labels, so they are not listed here. */
const _STEP_LABEL_TEXTS = {
  selectorStepLabel:       'Selector',
  dropdownStepLabel:       'Dropdown',
  readdomStepLabel:        'Read DOM Settings',
  screenshotTovarStepLabel:'Save as',
  dragdropStepLabel:       'Drop on',
  switchStepLabel:         'Branch',
  delayStepLabel:          'Delay',
  labelStepLabel:          'Label',
};

// What the selector is for a type where "Selector" says too little.
const _SELECTOR_LABEL_TEXTS = {
  dragdrop:   () => 'Drag from',
  uploadFile: () => (document.getElementById('uploadMode')?.value === 'dropzone' ? 'Drop zone' : 'File input'),
};

const _VALUE_LABEL_TEXTS = {
  script:             'JavaScript',
  navigate:           'URL',
  screenshot:         'Filename',
  screenshot_full:    'Filename',
  screenshot_element: 'Filename',
};

// A screenshot's filename may be left empty; every other Value is the action's own.
const _OPTIONAL_VALUE_TYPES = new Set(['screenshot', 'screenshot_full', 'screenshot_element']);

/** Grey, and under the divider: Label, Delay (except a Wait's, which is the action), a screenshot's filename. */
function _isOptionalStep(labelId, type) {
  if (labelId === 'labelStepLabel') return true;
  if (labelId === 'delayStepLabel') return type !== 'wait';
  if (labelId === 'valueStepLabel') return _OPTIONAL_VALUE_TYPES.has(type);
  return false;
}

// Ordered list of [stepLabelId, parentWrapperId] in DOM appearance order
const _STEP_ORDER = [
  ['selectorStepLabel',        'selectorSection'],
  ['dropdownStepLabel',        'dropdownWrapper'],
  ['readdomStepLabel',         'readdomWrapper'],
  ['screenshotTovarStepLabel', 'screenshotTovarWrapper'],
  ['dragdropStepLabel',        'dragdropWrapper'],
  ['switchStepLabel',          'switchWrapper'],
  ['valueStepLabel',           'manualValueWrapper'],
  ['delayStepLabel',           'manualDelayWrapper'],
  ['labelStepLabel',           'manualLabelWrapper'],
];

export function updateStepLabels() {
  const type = manualActionType.value;
  let firstOptional = true;
  for (const [labelId, parentId] of _STEP_ORDER) {
    const parent = document.getElementById(parentId);
    const label  = document.getElementById(labelId);
    if (!parent || !label) continue;
    const vis = parent.style.display !== '' && parent.style.display !== 'none';
    if (!vis) continue;
    const isOptional = _isOptionalStep(labelId, type);
    let text;
    if (labelId === 'valueStepLabel') text = _VALUE_LABEL_TEXTS[type] || 'Value';
    else if (labelId === 'delayStepLabel' && type === 'wait') text = 'Duration';
    else if (labelId === 'selectorStepLabel' && _SELECTOR_LABEL_TEXTS[type]) text = _SELECTOR_LABEL_TEXTS[type]();
    else text = _STEP_LABEL_TEXTS[labelId] || '';
    label.textContent = text;
    label.classList.toggle('step-label-optional', isOptional);
    // Insert a divider before the first optional label
    if (isOptional && firstOptional) {
      label.classList.add('step-label-divider-top');
      firstOptional = false;
    } else {
      label.classList.remove('step-label-divider-top');
    }
  }
}

// Update visibility of condition fields based on selected condition type
export function updateConditionFieldsVisibility() {
  const ct = conditionType ? conditionType.value : "";
  const selectorSection = document.getElementById("selectorSection");

  // Hide selector section for URL-based conditions
  if (selectorSection && manualActionType.value === "condition") {
    selectorSection.style.display = CONDITION_NO_SELECTOR.includes(ct) ? "none" : "block";
  }
  if (pickedSelectorsInfo && manualActionType.value === "condition" && CONDITION_NO_SELECTOR.includes(ct)) {
    pickedSelectorsWrap.style.display = "none";
  }

  // Hide expected value for existence/visibility conditions; "" keeps the
  // wrapper's display: contents, which lays its label and field out in the grid.
  if (conditionExpectedValueWrapper) {
    conditionExpectedValueWrapper.style.display = CONDITION_NO_EXPECTED_VALUE.includes(ct) ? "none" : "";
  }
  const [valueLabel, valueExample] = CONDITION_VALUE_HINTS[ct] || ["Value", "value to compare"];
  const expectedLabel = document.getElementById("conditionExpectedLabel");
  if (expectedLabel) expectedLabel.textContent = valueLabel;
  if (conditionExpectedValue) conditionExpectedValue.placeholder = `${valueExample} — \${var} works`;

  updateStepLabels();
}

/** Read DOM's Save mode: the whole text into one variable, or parts of it through a pattern. */
export const readdomMode = () =>
  document.querySelector('input[name="readdomMode"]:checked')?.value === "part" ? "part" : "whole";

export function setReaddomMode(mode) {
  const radio = document.querySelector(`input[name="readdomMode"][value="${mode === "part" ? "part" : "whole"}"]`);
  if (radio) radio.checked = true;
}

const _varRef = (name) => "$" + "{" + name + "}";

/** Read DOM: shows the chosen Save mode's fields, its hints, and the live Try on result. */
export function updateReaddomForm() {
  const mode = readdomMode();
  const wrap = document.getElementById("readdomWrapper");
  if (wrap) wrap.dataset.mode = mode;

  // The hint names the variable the way later steps will write it.
  const hintCode = document.querySelector("#readdomVarHint code");
  if (hintCode) hintCode.textContent = _varRef(normalizeVarName(document.getElementById("readdomVarName")?.value) || "name");

  const out = document.getElementById("readdomTryResult");
  if (!out) return;
  out.className = "readdom-try-result";
  out.textContent = "";
  if (mode !== "part") return;

  const tryEl = document.getElementById("readdomTryText");
  // The picked element's text, when the picker kept it, is the natural sample.
  if (tryEl && !tryEl.value && ui.currentPickedSelectors?.text) tryEl.value = ui.currentPickedSelectors.text;
  const pattern = document.getElementById("readdomPattern")?.value?.trim() || "";
  if (!pattern) return;
  const err = patternError(pattern);
  if (err) { out.classList.add("is-error"); out.textContent = err; return; }
  const sample = tryEl?.value || "";
  if (!sample.trim()) {
    out.textContent = `Saves ${patternVarNames(pattern).map(_varRef).join(", ")} — paste the element's text above to check.`;
    return;
  }
  const got = extractWithPattern(sample, pattern, { matchCase: !!document.getElementById("readdomMatchCase")?.checked });
  if (!got) { out.classList.add("is-error"); out.textContent = "No match — the step would fail on this text."; return; }
  out.classList.add("is-ok");
  out.append("→ ");
  Object.entries(got).forEach(([name, val], k) => {
    if (k) out.append(" · ");
    const code = document.createElement("code");
    code.textContent = name;
    const b = document.createElement("b");
    b.textContent = val === "" ? "(empty)" : val;
    out.append(code, " = ", b);
  });
}

/** Switch: "var" (cases picked by a variable) or "always" (one scenario, every time). */
export function switchMode() {
  return document.querySelector('input[name="switchMode"]:checked')?.value === "always" ? "always" : "var";
}

/** Check the Switch mode radio and show that mode's fields (data-mode on #switchWrapper). */
export function setSwitchMode(mode) {
  const m = mode === "always" ? "always" : "var";
  document.querySelectorAll('input[name="switchMode"]').forEach((r) => { r.checked = r.value === m; });
  const wrap = document.getElementById("switchWrapper");
  if (wrap) wrap.dataset.mode = m;
}

/** Dropdown: the item fields show while the action chooses an item. */
export function updateDropdownForm() {
  const wrap = document.getElementById("dropdownWrapper");
  if (wrap) wrap.dataset.mode = document.getElementById("dropdownPickMode")?.value || "";
}

export function initFormFields() {
  // Listen for conditionType changes
  if (conditionType) {
    conditionType.onchange = updateConditionFieldsVisibility;
  }
  // Show/hide attrName field based on readdom readFrom selection
  document.getElementById("readdomReadFrom")?.addEventListener("change", function() {
    const attrNameEl = document.getElementById("readdomAttrName");
    if (attrNameEl) attrNameEl.style.display = this.value === "attr" ? "block" : "none";
  });
  document.querySelectorAll('input[name="readdomMode"]').forEach(r => r.addEventListener("change", updateReaddomForm));
  document.getElementById("dropdownPickMode")?.addEventListener("change", updateDropdownForm);
  ["readdomVarName", "readdomPattern", "readdomTryText"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", updateReaddomForm);
  });
  document.getElementById("readdomMatchCase")?.addEventListener("change", updateReaddomForm);
  // An upload's selector label follows its mode.
  document.getElementById("uploadMode")?.addEventListener("change", updateStepLabels);
  // For screenshot_tovar: show selector section only when target = element
  document.getElementById("screenshotTovarTarget")?.addEventListener("change", function() {
    const selectorSection = document.getElementById("selectorSection");
    if (selectorSection) selectorSection.style.display = this.value === "element" ? "block" : "none";
    updateStepLabels();
  });
}
