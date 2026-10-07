/**
 * record/selector-type-menu.js — the selector type as a button inside the
 * selector field, [CSS ▾ | selector], with its menu: the Selector row and the
 * Drag & Drop "Drop on" row.
 *
 * The <select> each button stands for stays in the form, hidden. Everything
 * that reads or writes the type — drafts, editing an action, the picker,
 * building the action — still talks to that select; this module only draws it.
 * The button shows its value, the menu sets it, and lists the picked element's
 * locator for each type (or an example when nothing is picked).
 *
 * Typing //… or /html… under CSS switches to XPath / Full XPath on its own
 * ("auto"), and back to CSS when that text goes; any other type chosen by hand
 * stays as chosen.
 *
 * The button is as wide as its longest label whichever type is shown — every
 * label sits in the same grid cell and only the current one is visible — so
 * the field beside it never changes width when the type does.
 */

import { ui } from '../ui-state.js';

/** What a selector of each type looks like: the menu's examples and the field's placeholder. */
const EXAMPLES = {
  css:       '#submit or .card .title',
  xpath:     "//button[text()='Save']",
  id:        'submit',
  name:      'username',
  text:      'Save',
  fullXpath: '/html/body/div[2]/form/button',
};

const ROWS = [
  { select: 'selectorType', input: 'manualSelector', button: 'selectorTypeBtn', menu: 'selectorTypeMenu',
    picked: () => ui.currentPickedSelectors },
  { select: 'dragdropTargetSelectorType', input: 'dragdropTarget', button: 'dragdropTargetTypeBtn', menu: 'dragdropTargetTypeMenu',
    picked: () => ui.currentPickedDragdropTargetSelectors },
];

const SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

/** XPath or Full XPath when the text can only be one; otherwise null. */
function _detectXPath(text) {
  const s = String(text || '').trim();
  if (/^\/html\b/i.test(s)) return 'fullXpath';
  if (/^\(*\.?\//.test(s)) return 'xpath';
  return null;
}

/**
 * The button's insides, built once: every label stacked in one cell
 * (.sel-type-labels), the "auto" mark, the chevron. Painting only says which
 * label shows and whether "auto" does.
 */
function _buildButton(btn, sel) {
  const labels = document.createElement('span');
  labels.className = 'sel-type-labels';
  labels.setAttribute('aria-hidden', 'true');
  for (const o of sel.options) {
    const l = document.createElement('span');
    l.dataset.type = o.value;
    l.textContent = o.textContent;
    labels.append(l);
  }
  const autoMark = document.createElement('span');
  autoMark.className = 'auto';
  autoMark.textContent = 'auto';
  autoMark.setAttribute('aria-hidden', 'true');
  btn.replaceChildren(labels, autoMark);
  btn.insertAdjacentHTML('beforeend', '<span class="chev chev--menu" aria-hidden="true">▾</span>');
  return { labels, autoMark };
}

/** One row per type: the picked element's locator of that type, or an example. */
function _fillMenu(list, sel, found) {
  list.textContent = '';
  if (found) {
    const head = document.createElement('div');
    head.className = 'sel-menu-head';
    head.textContent = 'Picked element';
    list.append(head);
  }
  for (const o of sel.options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(o.value === sel.value));
    item.dataset.type = o.value;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = o.textContent;
    const v = document.createElement('span');
    const value = found?.[o.value];
    v.className = value ? 'v' : 'v ex';
    v.textContent = value || (found ? '—' : EXAMPLES[o.value] || '');
    item.append(t, v);
    list.append(item);
  }
}

/** Arrow keys, Home / End move through the menu; Escape and Tab close it. */
function _onMenuKey(e, list, close) {
  const items = [...list.querySelectorAll('button[data-type]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close({ refocus: true });
  } else if (e.key === 'Tab') {
    close();
  }
}

function _wire({ select, input, button, menu, picked }) {
  const sel = document.getElementById(select);
  const field = document.getElementById(input);
  const btn = document.getElementById(button);
  const list = document.getElementById(menu);
  if (!sel || !field || !btn || !list) return null;
  const group = btn.closest('.sel-group');
  const { labels, autoMark } = _buildButton(btn, sel);
  const typeText = (v) => [...sel.options].find((o) => o.value === v)?.textContent || v;
  let settingAuto = false;

  function paint() {
    const auto = group.dataset.auto === '1';
    for (const l of labels.children) l.classList.toggle('on', l.dataset.type === sel.value);
    autoMark.hidden = !auto;
    btn.setAttribute('aria-label', `Selector type: ${typeText(sel.value)}${auto ? ' (detected)' : ''}`);
    field.placeholder = `e.g. ${EXAMPLES[sel.value] || EXAMPLES.css}`;
  }

  // Every write to the select's value repaints the button — drafts, edits and
  // the picker set it directly, without a change event. A write from outside
  // this module is a type somebody chose, so it is no longer "auto".
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return SELECT_VALUE.get.call(this); },
    set(v) {
      SELECT_VALUE.set.call(this, v);
      if (!settingAuto) delete group.dataset.auto;
      paint();
    },
  });

  function setAuto(v, auto) {
    settingAuto = true;
    if (auto) group.dataset.auto = '1'; else delete group.dataset.auto;
    sel.value = v;
    settingAuto = false;
  }

  const isOpen = () => !list.hidden;
  function open() {
    _fillMenu(list, sel, picked() || null);
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    (list.querySelector('[aria-checked="true"]') || list.querySelector('button'))?.focus();
  }
  function close({ refocus = false } = {}) {
    if (!isOpen()) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  list.addEventListener('keydown', (e) => _onMenuKey(e, list, close));
  list.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-type]');
    if (!item) return;
    sel.value = item.dataset.type;
    // The existing listeners: swap in the picked locator of that type, save the draft.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // A keyboard choice keeps focus on the button; a mouse one lets it go.
    close({ refocus: e.detail === 0 });
  });

  field.addEventListener('input', () => {
    const detected = _detectXPath(field.value);
    // Only from CSS (which never starts with "/") or a type it set itself: a
    // Text "/api/users" chosen by hand stays Text.
    const mayDetect = sel.value === 'css' || group.dataset.auto === '1';
    if (detected && mayDetect && sel.value !== detected) setAuto(detected, true);
    else if (!detected && group.dataset.auto === '1') setAuto('css', false);
  });

  paint();
  return { group, close };
}

export function initSelectorTypeMenus() {
  const wired = ROWS.map(_wire).filter(Boolean);
  // A click anywhere else closes an open menu.
  document.addEventListener('pointerdown', (e) => {
    for (const w of wired) if (!w.group.contains(e.target)) w.close();
  });
}
