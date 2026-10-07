/**
 * record/picked-selectors.js — a picked element (and a drag & drop target): the
 * line saying how many locators were kept, with Clear. The locators themselves
 * are listed in the selector-type menu (record/selector-type-menu.js).
 */

import { manualSelector, pickedSelectorsInfo, pickedSelectorsWrap, selectorType } from '../dom.js';
import { ui } from '../ui-state.js';

// How long a field stays marked with its error.
const FIELD_ERROR_MS = 2500;

export function showFieldError(inputEl, message) {
  inputEl.classList.add("required-error");
  inputEl.setAttribute("aria-invalid", "true");
  let errorEl = inputEl.parentElement.querySelector('[role="alert"].field-error');
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.setAttribute("role", "alert");
    errorEl.className = "field-error";
    errorEl.style.cssText = "color:var(--danger);font-size:11px;margin-top:3px;";
    inputEl.parentElement.insertBefore(errorEl, inputEl.nextSibling);
  }
  errorEl.textContent = message;
  setTimeout(() => {
    inputEl.classList.remove("required-error");
    inputEl.setAttribute("aria-invalid", "false");
    errorEl.textContent = "";
  }, FIELD_ERROR_MS);
}

// Locators a pick keeps that the selector-type menu does not list; playback still tries them.
const EXTRA_LOCATORS = { testId: 'Test ID', dataId: 'Data ID' };

/**
 * What a pick kept: how many of the menu's types (its options), and the extra
 * locators by name. textTag only qualifies the text one.
 */
function _locatorSummary(selectors) {
  const has = (type) => typeof selectors[type] === 'string' && selectors[type] !== '';
  const listed = [...(selectorType?.options || [])].filter((o) => has(o.value)).length;
  const extras = Object.keys(EXTRA_LOCATORS).filter(has).map((type) => EXTRA_LOCATORS[type]);
  return { listed, extras };
}

function _renderSelectorPanel(selectors, { infoEl, wrapEl, clearBtnId, onClear }) {
  if (!selectors || !infoEl || !wrapEl) return;
  const { listed, extras } = _locatorSummary(selectors);
  const plus = extras.map((name) => ` + ${name}`).join('');
  infoEl.textContent = `🎯 Picked · ${listed} locator${listed === 1 ? '' : 's'}${plus} saved, tried in turn on playback`;
  infoEl.title = extras.length
    ? `The ${listed} are listed in the selector type menu (▾); ${extras.join(' and ')} ${extras.length === 1 ? 'is' : 'are'} tried too`
    : 'Each one is listed in the selector type menu (▾)';
  wrapEl.style.display = 'flex';

  const clearBtn = document.getElementById(clearBtnId);
  if (clearBtn) {
    const newBtn = clearBtn.cloneNode(true); // remove prior listeners
    clearBtn.parentNode.replaceChild(newBtn, clearBtn);
    newBtn.addEventListener('click', (e) => { e.stopPropagation(); onClear(); });
  }
}

// Helper to display all available selectors
export function displayPickedSelectors(selectors) {
  if (!selectors || !pickedSelectorsInfo || !pickedSelectorsWrap) return;
  ui.currentPickedSelectors = selectors;
  _renderSelectorPanel(selectors, {
    infoEl: pickedSelectorsInfo,
    wrapEl: pickedSelectorsWrap,
    clearBtnId: 'clearPickedSelectorsBtn',
    onClear: () => {
      ui.currentPickedSelectors = null;
      ui.currentPickedFrameId = null;
      updateFrameNote();
      manualSelector.value = '';
      pickedSelectorsInfo.innerHTML = '';
      pickedSelectorsWrap.style.display = 'none';
      chrome.storage.local.remove(["lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId"]);
    },
  });
}

/** True while the selector box still holds one of the picked element's selectors. */
export function selectorIsPicked(selector) {
  if (!ui.currentPickedSelectors || !selector) return false;
  return Object.values(ui.currentPickedSelectors).some(v => typeof v === "string" && v === selector);
}

/** "in iframe" note beside the selector while the picked element is in a frame. */
export function updateFrameNote() {
  const note = document.getElementById("pickedFrameNote");
  if (!note) return;
  const inFrame = ui.currentPickedFrameId != null && ui.currentPickedFrameId !== 0;
  note.style.display = inFrame ? "block" : "none";
  note.textContent = inFrame ? `⧉ In an iframe (frame ${ui.currentPickedFrameId}) — plays back in that frame` : "";
}

/** Forget the picked element (selectors + frame) without touching the selector box. */
export function clearPickedSelectorsPanel() {
  ui.currentPickedSelectors = null;
  ui.currentPickedFrameId = null;
  updateFrameNote();
  if (pickedSelectorsInfo) pickedSelectorsInfo.innerHTML = '';
  if (pickedSelectorsWrap) pickedSelectorsWrap.style.display = 'none';
  chrome.storage.local.remove(["lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId"]);
}

// Display picked selectors for drag & drop TARGET
export function displayPickedDragdropTargetSelectors(selectors) {
  const info = document.getElementById('pickedDragdropTargetInfo');
  const wrap = document.getElementById('pickedDragdropTargetWrap');
  if (!selectors || !info || !wrap) return;
  ui.currentPickedDragdropTargetSelectors = selectors;
  _renderSelectorPanel(selectors, {
    infoEl: info,
    wrapEl: wrap,
    clearBtnId: 'clearDragdropTargetBtn',
    onClear: () => {
      ui.currentPickedDragdropTargetSelectors = null;
      const t = document.getElementById('dragdropTarget');
      if (t) t.value = '';
      info.innerHTML = '';
      wrap.style.display = 'none';
    },
  });
}

export function initPickedSelectors() {
  // Typing a different selector drops the picked frame: the new selector is
  // looked up in the top page, as for any hand-written selector.
  manualSelector?.addEventListener("input", () => {
    if (ui.currentPickedFrameId != null && !selectorIsPicked(manualSelector.value.trim())) {
      ui.currentPickedFrameId = null;
      updateFrameNote();
    }
  });
  /* Switching the selector flavour swaps in the matching picked selector rather
     than leaving a stale one from the previous flavour in the box. */
  selectorType?.addEventListener('change', () => {
    const picked = ui.currentPickedSelectors?.[selectorType.value];
    if (picked) manualSelector.value = picked;
  });
  document.getElementById('dragdropTargetSelectorType')?.addEventListener('change', (e) => {
    const picked = ui.currentPickedDragdropTargetSelectors?.[e.target.value];
    const target = document.getElementById('dragdropTarget');
    if (picked && target) target.value = picked;
  });
}
