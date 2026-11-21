/**
 * playback/run-pick.js — 🎯 Pick it on a failed step's prompt: the user clicks the
 * element the step should use, on the page, and the run goes on with it.
 *
 * The picker is the form's (content.js ELEMENT PICKER), started with `forRun`, so
 * its answer comes back here (ELEMENT_PICKED, bg/handlers/picker.js) instead of to
 * the popup's form. "Save & go on" also writes the new locators into the step
 * (one Undo in the popup); "This run only" uses them for the rest of this run.
 */

import { state } from '../state.js';
import { mutateScenarioActions } from '../storage.js';
import { SELECTOR_KEYS } from '../../shared/var-name.js';

// How often a pick checks whether the run was stopped meanwhile.
const STOP_POLL_MS = 250;
// What the page may name the picked element with (content.js _previewLabel).
const LABEL_MAX = 80;

/**
 * Steps whose element a pick can replace: one element, found by the step's own
 * locators. Not a Drag & drop (two elements), nor a step with a Child Condition
 * (its selector is a parent searched for the child) or a picked selector type.
 */
const PICKABLE = new Set(['click', 'input', 'hover', 'dropdown', 'readdom', 'uploadFile', 'screenshot_element']);

export function canPick(action) {
  if (!action || !(action.selector || action.selectors)) return false;
  if (action.conditions && typeof action.conditions === 'object' && Object.keys(action.conditions).length) return false;
  return PICKABLE.has(action.type) || (action.type === 'screenshot_tovar' && action.target === 'element');
}

/** The picked locators as a page may send them: the selector strings only. */
function _cleanSelectors(raw) {
  const out = {};
  for (const k of [...SELECTOR_KEYS, 'textTag']) {
    if (typeof raw?.[k] === 'string' && raw[k]) out[k] = raw[k].slice(0, 2000);
  }
  return out;
}

let _pending = null; // { tabId, resolve }

/** Settle the pick in progress (ELEMENT_PICKED, a cancel, a stop): `result` or null. */
function _settle(result) {
  const p = _pending;
  _pending = null;
  if (!p) return;
  clearInterval(p.poll);
  chrome.tabs.sendMessage(p.tabId, { type: 'STOP_PICK_MODE' }, () => void chrome.runtime.lastError);
  p.resolve(result);
}

/** Whether `tabId` has a run's pick going: ELEMENT_PICKED and STOP_PICK_MODE from it are this module's. */
export const runPickOn = (tabId) => _pending != null && _pending.tabId === tabId;

/** ELEMENT_PICKED with `forRun`, from frame `frameId` of the run's tab. */
export function runPicked(request, frameId) {
  const selectors = _cleanSelectors(request.selectors);
  if (!Object.keys(selectors).length) { _settle(null); return; }
  const l = request.label && typeof request.label === 'object' ? request.label : {};
  const label = { tag: String(l.tag || '').slice(0, 20), name: String(l.name || '').slice(0, LABEL_MAX), id: String(l.id || '').slice(0, LABEL_MAX) };
  _settle({ selectors, frameId: frameId ?? 0, label });
}

/** The pick was cancelled on the page (Esc, the bar's ✕). */
export const runPickCancelled = () => _settle(null);

/**
 * Let the user click the element step `index` (0-based) should use on tab `tabId`.
 * Resolves to { selectors, frameId, label } or null (cancelled, run stopped).
 */
export function pickForRun(tabId, index) {
  _settle(null); // an older one: nobody waits for it now
  return new Promise((resolve) => {
    const poll = setInterval(() => { if (!state.playback.active) _settle(null); }, STOP_POLL_MS);
    _pending = { tabId, resolve, poll };
    // Every frame picks; none answers (the pick comes back as ELEMENT_PICKED), so no callback:
    // one would only hear "the message port closed".
    chrome.tabs.sendMessage(tabId, {
      type: 'START_PICK_MODE', forRun: true, label: `🎯 Click the element action ${index + 1} should use — Esc: back`,
    }).catch(() => { /* a frame without the content script */ });
  });
}

/** "button “Add to basket”" — the picked element as the prompt names it. */
export function pickedName({ label, selectors }) {
  const name = label?.name || label?.id || selectors.text || selectors.css || 'element';
  return `${label?.tag || 'element'} “${name}”`;
}

/** `action` with the picked element's locators in place of its own. */
export function withPicked(action, picked) {
  const next = { ...action, selectors: picked.selectors, selector: picked.selectors.css || Object.values(picked.selectors)[0] };
  // A selector type chosen in the form meant the old element's locator of that kind.
  delete next.selectorType;
  if (picked.frameId) next.frameId = picked.frameId;
  else delete next.frameId;
  return next;
}

/**
 * Write the picked element into step `index` of `scenarioId`, unless the step
 * changed since the run read it (`was`, as the run has it): true when written.
 */
export async function savePicked(scenarioId, index, was, picked) {
  if (!scenarioId) return false;
  // A throw leaves the scenario and its Undo as they were.
  return mutateScenarioActions(scenarioId, (list) => {
    if (JSON.stringify(list[index]) !== JSON.stringify(was)) throw new Error('the step changed since the run read it');
    const next = [...list];
    next[index] = withPicked(list[index], picked);
    return next;
  }).then(() => true, () => false);
}
