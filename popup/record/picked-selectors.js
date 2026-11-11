/**
 * record/picked-selectors.js — a picked element (and a drag & drop target): the
 * line naming it and saying how many locators were kept, with Clear. The
 * locators themselves are listed in the selector-type menu
 * (record/selector-type-menu.js); the name shows it on the page
 * (record/show-on-page.js).
 */

import { manualSelector, pickedSelectorsInfo, pickedSelectorsWrap, selectorType } from '../dom.js';
import { ui } from '../ui-state.js';

// How long a field stays marked with its error.
const FIELD_ERROR_MS = 2500;

/**
 * What a field's message goes after: the field, or the row it sits in. Inside a
 * row (the selector box [CSS ▾ | …], a field and its button) the message would
 * be squeezed in beside the field.
 */
function _errorAnchor(inputEl) {
  let el = inputEl;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { display, flexDirection } = getComputedStyle(p);
    if (!display.includes("flex") || flexDirection.startsWith("column")) break;
    el = p;
  }
  return el;
}

/**
 * The field marked and its message under it, for FIELD_ERROR_MS; the message
 * element. `warn`: a note in amber, the field left unmarked. In a .form-grid
 * the message takes the field column (04-lists-cards-forms.css); it is removed
 * after, so it leaves no cell behind to shift the rows below.
 */
export function showFieldError(inputEl, message, { warn = false } = {}) {
  inputEl.classList.toggle("required-error", !warn);
  inputEl.setAttribute("aria-invalid", String(!warn));
  const anchor = _errorAnchor(inputEl);
  let errorEl = anchor.nextElementSibling;
  if (!errorEl?.matches('.field-error')) {
    errorEl = document.createElement("div");
    anchor.after(errorEl);
  }
  errorEl.setAttribute("role", warn ? "status" : "alert");
  errorEl.className = warn ? "field-error field-warn" : "field-error"; // a message folding away comes back
  delete errorEl.dataset.preview; // the caller marks its own (show-on-page.js), in this same task
  errorEl.textContent = message;
  // Shown again before it went: the full time again.
  clearTimeout(errorEl._t);
  errorEl._t = setTimeout(() => {
    inputEl.classList.remove("required-error");
    inputEl.setAttribute("aria-invalid", "false");
    if (errorEl.dataset.preview) _foldAway(errorEl); else errorEl.remove();
  }, FIELD_ERROR_MS);
  return errorEl;
}

// How long 👁's line takes to fold away (preview-msg-out, 04-lists-cards-forms.css).
const MESSAGE_FOLD_MS = 160;

function _foldAway(errorEl) {
  clearTimeout(errorEl._t);
  errorEl.classList.add("leaving");
  errorEl._t = setTimeout(() => errorEl.remove(), MESSAGE_FOLD_MS);
}

/** Take away, before its time, a message showFieldError put under the field and marked `data-preview`. */
export function clearPreviewMessage(inputEl) {
  const errorEl = _errorAnchor(inputEl).nextElementSibling;
  if (!errorEl?.matches('.field-error[data-preview]:not(.leaving)')) return;
  _foldAway(errorEl);
  inputEl.classList.remove("required-error");
  inputEl.setAttribute("aria-invalid", "false");
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

/**
 * What the picked element is called, as nodes (the name comes from the page, so
 * never as HTML): `button` “Sign in”, `div`#card, or "Picked element" while no
 * name is known (an action opened for editing, until the page is asked).
 */
function _nameNodes(label) {
  if (!label?.tag) return ['Picked element'];
  const tag = document.createElement('code');
  tag.textContent = label.tag;
  if (label.name) return [tag, ` “${label.name}”`];
  return label.id ? [tag, `#${label.id}`] : [tag];
}

function _renderSelectorPanel(selectors, { infoEl, wrapEl, clearBtnId, onClear, label }) {
  if (!selectors || !infoEl || !wrapEl) return;
  const { listed, extras } = _locatorSummary(selectors);
  const plus = extras.map((name) => ` + ${name}`).join('');
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'pk-name';
  name.title = 'Hover to outline it on the page, click to scroll to it';
  name.append(..._nameNodes(label));
  const locators = document.createElement('span');
  locators.textContent = ` · ${listed} locator${listed === 1 ? '' : 's'}${plus}`;
  locators.title = extras.length
    ? `Tried in turn on playback. The ${listed} are listed in the selector type menu (▾); ${extras.join(' and ')} ${extras.length === 1 ? 'is' : 'are'} tried too`
    : 'Tried in turn on playback; each one is listed in the selector type menu (▾)';
  const stale = document.createElement('span');
  stale.className = 'pk-stale';
  stale.textContent = ' · box edited';
  stale.title = 'The box no longer holds the picked element — Add Action saves what you typed';
  infoEl.replaceChildren('🎯', name, locators, stale);
  infoEl.removeAttribute('title');
  wrapEl.style.display = 'flex';

  const clearBtn = document.getElementById(clearBtnId);
  if (clearBtn) {
    const newBtn = clearBtn.cloneNode(true); // remove prior listeners
    clearBtn.parentNode.replaceChild(newBtn, clearBtn);
    newBtn.addEventListener('click', (e) => { e.stopPropagation(); onClear(); });
  }
}

// What a pick leaves in storage for the popup the worker opens after it (content.js).
const LAST_PICKED_KEYS = ["lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId", "lastPickedLabel"];

/** The picked element's line; `label`: what it is called ({ tag, name, id }), null when not known. */
export function displayPickedSelectors(selectors, label = null) {
  if (!selectors || !pickedSelectorsInfo || !pickedSelectorsWrap) return;
  ui.currentPickedSelectors = selectors;
  ui.currentPickedLabel = label;
  _renderSelectorPanel(selectors, {
    infoEl: pickedSelectorsInfo,
    wrapEl: pickedSelectorsWrap,
    clearBtnId: 'clearPickedSelectorsBtn',
    label,
    onClear: () => {
      ui.currentPickedSelectors = null;
      ui.currentPickedLabel = null;
      ui.currentPickedFrameId = null;
      updateFrameNote();
      manualSelector.value = '';
      pickedSelectorsInfo.innerHTML = '';
      pickedSelectorsWrap.style.display = 'none';
      chrome.storage.local.remove(LAST_PICKED_KEYS);
    },
  });
  updatePickedStale();
}

/** The name, once the page told it (show-on-page.js), for a picked element that had none. */
export function setPickedLabel(which, label) {
  const source = which === 'source';
  if (!label?.tag || (source ? ui.currentPickedLabel : ui.currentPickedDragdropTargetLabel)) return;
  if (source) ui.currentPickedLabel = label;
  else ui.currentPickedDragdropTargetLabel = label;
  const info = source ? pickedSelectorsInfo : document.getElementById('pickedDragdropTargetInfo');
  info?.querySelector('.pk-name')?.replaceChildren(..._nameNodes(label));
}

/** The name struck out while the box holds something other than the picked element. */
export function updatePickedStale() {
  pickedSelectorsWrap?.classList.toggle('picked-stale',
    !!ui.currentPickedSelectors && !selectorIsPicked(manualSelector.value.trim()));
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
  ui.currentPickedLabel = null;
  ui.currentPickedFrameId = null;
  updateFrameNote();
  if (pickedSelectorsInfo) pickedSelectorsInfo.innerHTML = '';
  if (pickedSelectorsWrap) pickedSelectorsWrap.style.display = 'none';
  chrome.storage.local.remove(LAST_PICKED_KEYS);
}

/**
 * The drop target's line. Not struck out when its box is edited: Add Action
 * keeps the picked target's locators whatever the box says (_buildDragdrop).
 */
export function displayPickedDragdropTargetSelectors(selectors, label = null) {
  const info = document.getElementById('pickedDragdropTargetInfo');
  const wrap = document.getElementById('pickedDragdropTargetWrap');
  if (!selectors || !info || !wrap) return;
  ui.currentPickedDragdropTargetSelectors = selectors;
  ui.currentPickedDragdropTargetLabel = label;
  _renderSelectorPanel(selectors, {
    infoEl: info,
    wrapEl: wrap,
    clearBtnId: 'clearDragdropTargetBtn',
    label,
    onClear: () => {
      ui.currentPickedDragdropTargetSelectors = null;
      ui.currentPickedDragdropTargetLabel = null;
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
    updatePickedStale();
  });
  /* Switching the selector flavour swaps in the matching picked selector rather
     than leaving a stale one from the previous flavour in the box. */
  selectorType?.addEventListener('change', () => {
    const picked = ui.currentPickedSelectors?.[selectorType.value];
    if (picked) manualSelector.value = picked;
    updatePickedStale();
  });
  document.getElementById('dragdropTargetSelectorType')?.addEventListener('change', (e) => {
    const picked = ui.currentPickedDragdropTargetSelectors?.[e.target.value];
    const target = document.getElementById('dragdropTarget');
    if (picked && target) target.value = picked;
  });
}
