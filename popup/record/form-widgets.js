/**
 * record/form-widgets.js — small pieces of the Add Manual Action card that
 * action-form.js and form-state.js both drive: the delay preset and the Child
 * Condition section's toggle and badge. A leaf module, so neither has to import
 * the other for them.
 */

import { CHILD_COND_FIELDS } from './form-table.js';

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
