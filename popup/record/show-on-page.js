/**
 * record/show-on-page.js — 👁 in the Selector and Drop on boxes, and the picked
 * element's name in the line under them: hover (or keyboard focus) outlines the
 * element on the page, a click scrolls to it and flashes it (content.js ELEMENT
 * PREVIEW). Each looks for what playback would use: 👁 for what its box holds,
 * the name for the element that was picked. What went wrong (not found, hidden,
 * several matches, under the popup) shows under the box.
 */

import { manualSelector, pickedSelectorsWrap, selectorType } from '../dom.js';
import { ui } from '../ui-state.js';
import { isEligibleTab } from '../utils.js';
import { clearPreviewMessage, selectorIsPicked, setPickedLabel, showFieldError } from './picked-selectors.js';

// Hover intent: a mouse passing over 👁 or the name sends nothing to the page.
const HOVER_MS = 150;
// How long 👁 shows ✓ / ! / ✕ after a click.
const RESULT_ICON_MS = 1500;

const chosenType = (select) => (select?.dataset.chosen === '1' ? select.value : null);

/** What the Selector box would play (action-form _setSelector): the picked element while it holds one of its selectors, else what was typed. */
function selectorTarget() {
  const selector = manualSelector.value.trim();
  if (selectorIsPicked(selector)) {
    return { which: 'source', selector, selectors: ui.currentPickedSelectors, selectorType: chosenType(selectorType), frameId: ui.currentPickedFrameId ?? 0 };
  }
  return { selector, selectors: { [selectorType.value || 'css']: selector }, selectorType: null, frameId: 0 };
}

/** The element picked for the Selector, whatever the box holds now. */
function pickedTarget() {
  return { which: 'source', selector: '', selectors: ui.currentPickedSelectors, selectorType: chosenType(selectorType), frameId: ui.currentPickedFrameId ?? 0 };
}

/** What Drop on would play (action-form _buildDragdrop): the picked target's locators if there are some, else what was typed. */
function dropTarget() {
  const typeSelect = document.getElementById('dragdropTargetSelectorType');
  const selector = document.getElementById('dragdropTarget').value.trim();
  const frameId = ui.currentPickedFrameId ?? 0; // a drag & drop plays in its source's frame
  const picked = ui.currentPickedDragdropTargetSelectors;
  if (picked) return { which: 'target', selector, selectors: picked, selectorType: chosenType(typeSelect), frameId };
  return { selector, selectors: { [typeSelect?.value || 'css']: selector }, selectorType: null, frameId };
}

function send(at, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(at.tabId, msg, { frameId: at.frameId }, (reply) => {
      void chrome.runtime.lastError; // no content script there: no reply
      resolve(reply ?? null);
    });
  });
}

/** Ask the page to peek at or flash `t`; what it found, as { kind, … }. */
async function look(t, mode) {
  if (!t.which) {
    // Typed: what can be told without the page.
    if (!t.selector) return { kind: 'empty' };
    if (t.selector.includes('${')) return { kind: 'var' };
    if (Object.keys(t.selectors)[0] === 'css') {
      try { document.createDocumentFragment().querySelector(t.selector); } catch (_) { return { kind: 'invalid' }; }
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isEligibleTab(tab)) return { kind: 'tab' };
  const at = { tabId: tab.id, frameId: t.frameId };
  const reply = await send(at, {
    type: 'SHOW_ELEMENT', mode, selectors: t.selectors, selector: t.selector, selectorType: t.selectorType,
    // Where this popup is on the screen, so the page can tell an element under it (content.js _popupRectOnPage).
    popup: { width: window.innerWidth, height: window.innerHeight, screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio },
  });
  if (!reply) return { kind: 'absent' };
  if (reply.error) return { kind: 'error', error: reply.error, at };
  if (!reply.found) return { kind: 'missing', picked: !!t.which, at };
  if (t.which) setPickedLabel(t.which, reply.label);
  let kind = 'ok';
  if (reply.hidden) kind = 'hidden';
  else if (reply.offscreen) kind = 'offscreen';
  else if (reply.count > 1) kind = 'multi';
  return { ...reply, kind, at };
}

/** The line under the box for `r`; 'ok' | 'warn' | 'bad' for 👁. */
function report(input, r) {
  const say = (text, warn) => { showFieldError(input, text, { warn }).dataset.preview = '1'; return warn ? 'warn' : 'bad'; };
  switch (r.kind) {
    case 'ok':
      if (!r.covered) { clearPreviewMessage(input); return 'ok'; }
      return say('Under this popup — press Esc to see it.', true);
    case 'offscreen': clearPreviewMessage(input); return 'ok'; // the arrow on the page says where
    case 'multi': {
      const name = r.label?.name ? ` (solid outline: “${r.label.name}”)` : ' (solid outline)';
      return say(`${r.count} matches — playback uses the first${name}. Pick again or narrow the selector.`, true);
    }
    case 'hidden': return say(`On the page but hidden (it has no size)${r.parent ? ' — the dashed box is what holds it' : ''}.`, true);
    case 'missing': return say(r.picked ? 'Not on this page — none of its locators finds it.' : 'Not on this page — the selector matches nothing.', false);
    case 'var': return say('The selector has ${…} — its value is only known when it plays.', true);
    case 'invalid': return say('Not a valid CSS selector.', false);
    case 'empty': return say('The selector is empty.', false);
    case 'tab': return say('Cannot look on this page.', true);
    case 'absent': return say('No answer from the page — reload it and try again.', true);
    default: return say(r.error || 'Could not look on the page.', false);
  }
}

/** ✓ / ! / ✕ on 👁 for a moment, then the eye again. */
function markEye(eye, result) {
  if (!eye) return;
  if (!eye._icon) eye._icon = eye.innerHTML;
  const [cls, glyph] = { ok: ['r-ok', '✓'], warn: ['r-warn', '!'] }[result] || ['r-bad', '✕'];
  clearTimeout(eye._t);
  eye.classList.remove('r-ok', 'r-warn', 'r-bad');
  eye.classList.add(cls);
  eye.textContent = glyph;
  eye._t = setTimeout(() => { eye.classList.remove(cls); eye.innerHTML = eye._icon; }, RESULT_ICON_MS);
}

/**
 * Hover with intent, keyboard focus and click for one trigger. A peek is taken
 * back when the mouse leaves; a popup that closes meanwhile cannot do that, and
 * the page clears it itself (content.js PREVIEW_HOLD_MS).
 */
function previewer(input, target, eye = null) {
  let timer = null, hovering = false, at = null;
  const hide = () => {
    if (at) send(at, { type: 'HIDE_ELEMENT' });
    at = null;
    clearPreviewMessage(input);
  };
  return {
    start() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        hovering = true;
        const r = await look(target(), 'peek');
        at = r.at || null;
        if (hovering) report(input, r);
        else hide(); // left before the page answered
      }, HOVER_MS);
    },
    stop() {
      clearTimeout(timer);
      if (hovering) { hovering = false; hide(); }
    },
    async click() {
      clearTimeout(timer);
      hovering = false;
      at = null; // the flash replaces the peek and goes by itself
      markEye(eye, report(input, await look(target(), 'flash')));
    },
  };
}

/** 👁: hover, focus (keyboard only — a mouse click focuses it too) and click. */
function wireEye(eye, p) {
  if (!eye) return;
  eye.addEventListener('mouseenter', p.start);
  eye.addEventListener('mouseleave', p.stop);
  eye.addEventListener('focus', () => { if (eye.matches(':focus-visible')) p.start(); });
  eye.addEventListener('blur', p.stop);
  eye.addEventListener('click', p.click);
}

/** The name in a Picked line: it is drawn again on every pick, so listen on the line. */
function wireName(wrap, p) {
  if (!wrap) return;
  const nameIn = (e) => e.target.closest?.('.pk-name');
  const crossing = (e) => { const b = nameIn(e); return b && !b.contains(e.relatedTarget) ? b : null; };
  wrap.addEventListener('mouseover', (e) => { if (crossing(e)) p.start(); });
  wrap.addEventListener('mouseout', (e) => { if (crossing(e)) p.stop(); });
  wrap.addEventListener('focusin', (e) => { if (nameIn(e)?.matches(':focus-visible')) p.start(); });
  wrap.addEventListener('focusout', (e) => { if (nameIn(e)) p.stop(); });
  wrap.addEventListener('click', (e) => { if (nameIn(e)) p.click(); });
}

export function initShowOnPage() {
  const dropInput = document.getElementById('dragdropTarget');
  wireEye(document.getElementById('showSelectorOnPage'), previewer(manualSelector, selectorTarget, document.getElementById('showSelectorOnPage')));
  wireName(pickedSelectorsWrap, previewer(manualSelector, pickedTarget));
  if (dropInput) {
    const dropEye = document.getElementById('showDragdropTargetOnPage');
    wireEye(dropEye, previewer(dropInput, dropTarget, dropEye));
    wireName(document.getElementById('pickedDragdropTargetWrap'), previewer(dropInput, dropTarget));
  }
}
