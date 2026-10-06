/**
 * ui/var-suggest.js — the list of variable names under a field being typed in.
 *
 * attachVarSuggest(el, { mode, getEntries }):
 *   mode 'ref'   the field takes text with `${name}` references: the list opens
 *                when `${` is typed (Ctrl+Space types it) and writes `${name}`;
 *   mode 'name'  the field takes a variable name only: the list opens when the
 *                field is focused or typed in, and writes the bare name.
 * getEntries() gives [{ name, kind, detail }] (or a promise of it); it is asked
 * each time the field gets focus. shared/var-suggest.js decides what fits.
 * `detail` is what the row shows on its right: `{ chips, more, chain }` (a
 * Data tab value as varValueDetail reads it) or `{ text }`, and `spec` for the
 * row's tooltip.
 *
 * One list serves every field. It sits under the field, or above it when there
 * is more room there, and closes on blur, Escape or a choice. ↑ / ↓ move,
 * Enter / Tab choose — only while the list is open, so Enter in a textarea and
 * Tab between fields work as before otherwise. A choice is typed into the field
 * (undo works) and fires `input` as typing does.
 */

import { findVarToken, insertVarRef, nameQuery, rankVarNames } from '../../shared/var-suggest.js';

const LIST_ID = 'varSuggest';
// Narrow fields still get a list wide enough to read the names.
const MIN_WIDTH = 220;
// Gap between the field and the list, and from the popup's edges.
const GAP = 2;
const EDGE = 4;
// The list is never squeezed shorter than this; it scrolls instead.
const MIN_HEIGHT = 80;
// Badge per kind: the Variables tab's S / R / P / F, a step that writes the
// variable (#), a column of the loaded CSV (C).
const BADGE = { s: 'S', r: 'R', p: 'P', f: 'F', w: '#', c: 'C' };
// A Blank Pick / Fallback entry, named as the Variables tab names it.
const BLANK_TEXT = '∅ blank';

let list = null;    // the <ul>, made on first use
let cur = null;     // the open list: { st, token, matches, active }
let writing = false; // our own `input` event while a choice is written

function _list() {
  if (list) return list;
  list = document.createElement('ul');
  list.id = LIST_ID;
  list.className = 'var-suggest';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Variables');
  list.hidden = true;
  // The field keeps focus while an item is clicked.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (li && cur) _choose(Number(li.dataset.k));
  });
  document.body.appendChild(list);
  window.addEventListener('resize', _place);
  document.addEventListener('scroll', _place, true);
  return list;
}

function _close() {
  if (!cur) return;
  const { el } = cur.st;
  cur = null;
  list.hidden = true;
  list.replaceChildren();
  el.removeAttribute('aria-activedescendant');
  if (el.tagName === 'INPUT') el.setAttribute('aria-expanded', 'false');
}

/** Under the field, or above it when there is more room there; scrolls when neither fits. */
function _place() {
  if (!cur || list.hidden) return;
  const r = cur.st.el.getBoundingClientRect();
  const width = Math.max(r.width, MIN_WIDTH);
  list.style.width = `${width}px`;
  list.style.left = `${Math.max(EDGE, Math.min(r.left, innerWidth - width - EDGE))}px`;
  list.style.maxHeight = '';
  const natural = list.offsetHeight;
  const below = innerHeight - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const under = natural <= below || below >= above;
  const height = Math.min(natural, Math.max(MIN_HEIGHT, under ? below : above));
  if (height < natural) list.style.maxHeight = `${height}px`;
  list.style.top = `${under ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - height)}px`;
}

function _mark() {
  const { el } = cur.st;
  [...list.children].forEach((li, k) => {
    const on = k === cur.active;
    li.classList.toggle('is-active', on);
    li.setAttribute('aria-selected', String(on));
    if (on) li.scrollIntoView({ block: 'nearest' });
  });
  if (cur.active >= 0) el.setAttribute('aria-activedescendant', `${LIST_ID}-${cur.active}`);
  else el.removeAttribute('aria-activedescendant');
}

function _span(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

/** The right side of a row: a chip per value (arrows between Fallback values), or a line of text. */
function _detail({ chips, more, chain, text } = {}) {
  const box = _span('vs-detail', '');
  if (!chips) {
    // Only a Static value is ever empty; a step or a CSV column always says what it is.
    box.append(_span('vs-text', text || 'empty'));
    box.classList.toggle('is-empty', !text);
    return box;
  }
  chips.forEach((c, k) => {
    if (k && chain) box.append(_span('vs-sep', '→'));
    const chip = _span('vs-chip', c === '' ? BLANK_TEXT : c);
    chip.classList.toggle('is-blank', c === '');
    box.append(chip);
  });
  if (more) box.append(_span('vs-more', `+${more}`));
  return box;
}

function _render() {
  const ul = _list();
  ul.replaceChildren(...cur.matches.map((m, k) => {
    const li = document.createElement('li');
    li.id = `${LIST_ID}-${k}`;
    li.dataset.k = String(k);
    li.className = `k-${m.kind}`;
    li.setAttribute('role', 'option');
    if (m.detail?.spec) li.title = m.detail.spec;
    const badge = _span(`vt-i ${m.kind}`, BADGE[m.kind] || '?');
    badge.setAttribute('aria-hidden', 'true');
    li.append(badge, _span('vs-name', m.name), _detail(m.detail));
    return li;
  }));
  ul.hidden = false;
  if (cur.st.el.tagName === 'INPUT') cur.st.el.setAttribute('aria-expanded', 'true');
  _mark();
  _place();
}

/** What fits the field as it reads now; opens the list only when `open`. */
function _update(st, { open = false, pickFirst = st.mode === 'ref' } = {}) {
  const { el } = st;
  const isOpen = cur?.st === st;
  if (document.activeElement !== el) { if (isOpen) _close(); return; }
  if (!isOpen && !open) return;
  let token = null;
  let query;
  if (st.mode === 'ref') {
    token = findVarToken(el.value, el.selectionStart);
    if (!token) { if (isOpen) _close(); return; }
    query = token.query;
  } else {
    query = nameQuery(el.value);
  }
  const matches = rankVarNames(query, st.entries);
  // Nothing to offer, or only the name already written in full.
  const done = matches.length === 1 && matches[0].name === query && (st.mode === 'name' || token.closed);
  if (!matches.length || done) { if (isOpen) _close(); return; }
  // A reference is being typed, so the first name is ready to take; a name
  // field waits for ↓, so Enter keeps what was typed.
  cur = { st, token, matches, active: pickFirst ? 0 : -1 };
  _render();
}

/** Type `text` over start–end, as the user would: undo works and `input` fires. */
function _type(el, text, start, end) {
  el.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function _choose(k) {
  const { st, token, matches } = cur;
  const m = matches[k];
  if (!m) return;
  const { el } = st;
  _close();
  writing = true;
  try {
    if (st.mode === 'ref') {
      const ref = insertVarRef('', { start: 0, end: 0 }, m.name).text;
      _type(el, ref, token.start, token.end);
    } else {
      _type(el, m.name, 0, el.value.length);
    }
  } finally {
    writing = false;
  }
}

function _onKey(st, e) {
  if (cur?.st !== st) {
    if (e.key === ' ' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      if (st.mode === 'ref') _type(st.el, '${', st.el.selectionStart, st.el.selectionEnd); // its input opens the list
      else _update(st, { open: true });
    } else if (st.mode === 'name' && e.key === 'ArrowDown' && !e.altKey) {
      e.preventDefault();
      _update(st, { open: true, pickFirst: true });
    }
    return;
  }
  const n = cur.matches.length;
  if (e.key === 'ArrowDown') cur.active = (cur.active + 1) % n;
  else if (e.key === 'ArrowUp') cur.active = cur.active <= 0 ? n - 1 : cur.active - 1;
  else if (e.key === 'Enter' || e.key === 'Tab') {
    // Nothing picked (a name field before ↓), or Shift+Tab: keep what was
    // typed and let the key do what it does.
    if (cur.active < 0 || e.shiftKey) { _close(); return; }
    e.preventDefault();
    e.stopPropagation();
    _choose(cur.active);
    return;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    _close();
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  _mark();
}

export function attachVarSuggest(el, { mode, getEntries }) {
  if (!el) return;
  const st = { el, mode, entries: [], loading: Promise.resolve() };
  el.setAttribute('aria-autocomplete', 'list');
  el.setAttribute('aria-controls', LIST_ID);
  if (el.tagName === 'INPUT') {
    el.setAttribute('role', 'combobox');
    el.setAttribute('aria-expanded', 'false');
  }
  el.addEventListener('focus', () => {
    st.loading = Promise.resolve()
      .then(getEntries)
      .then((entries) => { st.entries = entries || []; }, () => { st.entries = []; });
    if (mode === 'name') st.loading.then(() => _update(st, { open: true }));
  });
  el.addEventListener('blur', () => { if (cur?.st === st) _close(); });
  el.addEventListener('input', () => {
    if (!writing) st.loading.then(() => _update(st, { open: true }));
  });
  // The caret moved: the reference it is in may have changed.
  el.addEventListener('click', () => _update(st));
  el.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) _update(st);
  });
  el.addEventListener('keydown', (e) => _onKey(st, e));
}
