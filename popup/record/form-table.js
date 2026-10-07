/**
 * record/form-table.js — the Add Manual Action card's fields that each hold one
 * thing of the action, by action type.
 *
 * Five functions move an action or a draft in and out of the card:
 * buildActionFromForm, startEdit and clearEditState (record/action-form.js),
 * collectManualFormState and applyManualFormState (record/form-state.js). They
 * take element ids, action properties, draft keys and empty values from here.
 * What is particular to one type stays with them: validation, the order an
 * action's properties are saved in (it shows in exported JSON), the Switch's
 * cases, the wait duration.
 */

import { conditionSkip, isAlwaysSwitch } from '../../shared/switch-blocks.js';
import { readdomMode, setReaddomMode, setSwitchMode, switchMode } from './form-fields.js';

/**
 * The Value box means something else for each type that shows it: the action
 * property it is saved as, its placeholder, its kind — which sizes the box
 * (#manualValue[data-kind] in 02-action-list.css; url and file are one line) —
 * and what an action opens with there when that is not just the property.
 */
const FILENAME_BOX = { prop: "value", kind: "file", placeholder: "e.g. login-page.png — empty = automatic name, ${var} works" };
export const VALUE_BOX = new Map([
  // Either type opens with whichever of value / url the action has.
  ["input",              { prop: "value", kind: "text", placeholder: "Text to type — ${var} works", fromAction: (a) => a.value || a.url || "" }],
  ["navigate",           { prop: "url",   kind: "url",  placeholder: "e.g. https://example.com/login", fromAction: (a) => a.value || a.url || "" }],
  ["script",             { prop: "code",  kind: "code", placeholder: "JavaScript — runs in the page, e.g. document.title" }],
  ["screenshot",         FILENAME_BOX],
  ["screenshot_full",    FILENAME_BOX],
  ["screenshot_element", FILENAME_BOX],
]);

/** One-line kinds: Enter and pasted line breaks never get into them. */
export const SINGLE_LINE_KINDS = new Set(["url", "file"]);

/** Upload File's names, one per line; older actions have a single `fileName`. */
function fileNamesText(action) {
  let names;
  if (Array.isArray(action.fileNames) && action.fileNames.length) names = action.fileNames;
  else if (action.fileName) names = [action.fileName];
  else names = [];
  return names.join("\n");
}

/**
 * Per action type, the section that shows the type's own fields, and the fields:
 *
 *   id          the element, and the field's key in a draft
 *   prop        the action property it edits — none: never saved in the action
 *   empty       what a cleared card holds, and what an action without `prop` opens with
 *   check       a checkbox: `checked` instead of `value`
 *   trim        a draft keeps the value trimmed
 *   draftEmpty  what a draft keeps for an empty field, when that is not `empty`
 *   fromAction  what an action opens with, when that is not just `prop`
 *   fromDraft   what a draft puts back, when that is not just its key
 *   read/write  for a field that is not one element (a radio group)
 *
 * In section order: the order clearEditState resets them in.
 */
export const TYPE_FIELDS = new Map([
  ["condition", {
    wrapper: "conditionWrapper",
    fields: [
      { id: "conditionType",          prop: "conditionType", empty: "elementExists", draftEmpty: "" },
      { id: "conditionExpectedValue", prop: "expectedValue", trim: true },
      // "0" = guards nothing — saved as `empty`, see buildActionFromForm.
      { id: "conditionSkipCount",     empty: "1", fromAction: conditionSkip },
    ],
  }],
  ["dragdrop", {
    wrapper: "dragdropWrapper",
    fields: [
      { id: "dragdropTarget",             prop: "targetSelector", trim: true },
      // The selector type the drop target was saved with.
      { id: "dragdropTargetSelectorType", empty: "css",
        fromAction: (a) => (a.targetSelectors ? Object.keys(a.targetSelectors)[0] || "css" : "css") },
    ],
  }],
  ["readdom", {
    wrapper: "readdomWrapper",
    fields: [
      { id: "readdomVarName",   prop: "varName",  trim: true },
      { id: "readdomReadFrom",  prop: "readFrom", empty: "text" },
      { id: "readdomAttrName",  prop: "attrName", trim: true },
      // Save mode radios: the whole text into one variable, or parts of it through the pattern.
      { id: "readdomMode", empty: "whole", read: readdomMode, write: setReaddomMode,
        fromAction: (a) => (a.pattern ? "part" : "whole"),
        fromDraft: (st) => st.readdomMode || (st.readdomPattern ? "part" : "whole") },
      { id: "readdomPattern",   prop: "pattern" },
      { id: "readdomMatchCase", prop: "matchCase", check: true },
      { id: "readdomTryText" }, // a sample to try the pattern on
    ],
  }],
  ["screenshot_tovar", {
    wrapper: "screenshotTovarWrapper",
    fields: [
      { id: "screenshotTovarVarName", prop: "varName", trim: true },
      { id: "screenshotTovarTarget",  prop: "target",  empty: "page" },
    ],
  }],
  ["uploadFile", {
    wrapper: "uploadFileWrapper",
    fields: [
      { id: "uploadMode",       prop: "uploadMode", empty: "input" },
      { id: "uploadFolderPath", prop: "folderPath", trim: true },
      { id: "uploadFileNames",  fromAction: fileNamesText,
        fromDraft: (st) => st.uploadFileNames ?? st.uploadFileName ?? "" }, // uploadFileName: older drafts
    ],
  }],
  ["switch", {
    wrapper: "switchWrapper",
    fields: [
      { id: "switchVar", prop: "switchVar", trim: true },
      // On a variable, or Always: no variable, one scenario played every time.
      { id: "switchMode", empty: "var", read: switchMode, write: setSwitchMode,
        fromAction: (a) => (isAlwaysSwitch(a) ? "always" : "var"),
        fromDraft: (st) => st.switchMode || "var" },
    ],
  }],
  // "Choose item #" lives under `action.pick` — shared/dropdown-pick.js.
  ["dropdown", {
    wrapper: "dropdownWrapper",
    fields: [
      { id: "dropdownPickMode",     fromAction: (a) => (a.pick ? a.pick.by || "index" : "") },
      { id: "dropdownPickIndex",    trim: true, fromAction: (a) => a.pick?.index ?? "" },
      { id: "dropdownItemSelector", trim: true, fromAction: (a) => a.pick?.itemSelector || "" },
    ],
  }],
]);

/**
 * Child Condition (click, input, hover, readdom): the element, the property under
 * `action.conditions`, and the key under a draft's `childCond`.
 */
export const CHILD_COND_FIELDS = [
  { id: "condChildValueEquals",   prop: "valueEquals",   draftKey: "valueEquals" },
  { id: "condChildTextContains",  prop: "textContains",  draftKey: "textContains" },
  { id: "condChildIdContains",    prop: "idContains",    draftKey: "idContains" },
  { id: "condChildClassContains", prop: "classContains", draftKey: "classContains" },
  { id: "condChildType",          prop: "typeEquals",    draftKey: "childType" },
];

function _put(f, v) {
  if (f.write) { f.write(v); return; }
  const el = document.getElementById(f.id);
  if (!el) return;
  if (f.check) el.checked = v; else el.value = v;
}

/** The field as a cleared card has it. */
export function clearField(f) {
  _put(f, f.check ? false : (f.empty || ""));
}

/** The field as `action` opens with it; a field the action does not keep is left alone. */
export function fillField(f, action) {
  if (!f.prop && !f.fromAction) return;
  let v;
  if (f.fromAction) v = f.fromAction(action);
  else if (f.check) v = !!action[f.prop];
  else v = action[f.prop] || f.empty || "";
  _put(f, v);
}

/** What a draft keeps of the field. */
export function draftValue(f) {
  if (f.read) return f.read();
  const el = document.getElementById(f.id);
  if (f.check) return !!el?.checked;
  return (f.trim ? el?.value?.trim() : el?.value) || (f.draftEmpty ?? f.empty ?? "");
}

/** A type's fields as a draft keeps them, by element id. */
export function draftFields(type) {
  return Object.fromEntries(TYPE_FIELDS.get(type).fields.map((f) => [f.id, draftValue(f)]));
}

/** The field as `state` (a draft) has it. */
export function applyDraftValue(f, state) {
  let v;
  if (f.fromDraft) v = f.fromDraft(state);
  else if (f.check) v = !!state[f.id];
  else if (f.empty) v = state[f.id] || f.empty;
  else v = state[f.id] ?? "";
  _put(f, v);
}
