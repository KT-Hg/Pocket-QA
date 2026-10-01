// Each variable stores a full config object across all 4 types so switching type never discards data.

import { showToast, showConfirm, lockScroll, unlockScroll, getDragAfterElement } from './utils.js';
import { listEntries, listSpec, parseListSpec } from '../bg/var-name.js';

/* ── Parsers ─────────────────────────────────────────────────────────────── */

const RANDOM_RE   = /^\{random:(\w+):(\d+)\}$/;

// Config lists keep a Blank entry as null (see listEntries in bg/var-name.js).
const _toConfigList = (vals) => vals && vals.map(v => (v === '' ? null : v));

function _parsePick(val) {
  return _toConfigList(parseListSpec('pick', val));
}

function _parseRandom(val) {
  const m = typeof val === 'string' && val.match(RANDOM_RE);
  return m ? { type: m[1], length: m[2] } : null;
}

function _parseFallback(val) {
  return _toConfigList(parseListSpec('fallback', val));
}

/* ── Config model ────────────────────────────────────────────────────────── */

function _defaultConfig() {
  return { activeType: 's', s: '', r: { type: 'alphanumeric', length: '8' }, p: ['', ''], f: ['', ''] };
}

export function _migrateToConfig(val) {
  if (val && typeof val === 'object' && 'activeType' in val) {
    const def = _defaultConfig();
    return {
      ...def,
      ...val,
      r: { ...def.r, ...(val.r || {}) },
      p: Array.isArray(val.p) && val.p.length ? val.p : def.p,
      f: Array.isArray(val.f) && val.f.length ? val.f : def.f,
    };
  }
  const cfg = _defaultConfig();
  const fallbackVals = _parseFallback(val);
  const pickVals     = _parsePick(val);
  const randSpec     = _parseRandom(val);
  if      (fallbackVals) { cfg.activeType = 'f'; cfg.f = fallbackVals; }
  else if (pickVals)     { cfg.activeType = 'p'; cfg.p = pickVals; }
  else if (randSpec)     { cfg.activeType = 'r'; cfg.r = randSpec; }
  else                   { cfg.activeType = 's'; cfg.s = typeof val === 'string' ? val : ''; }
  return cfg;
}

export function _getActiveValue(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r' && cfg.r) return `{random:${cfg.r.type}:${cfg.r.length}}`;
  if (t === 'p') return listSpec('pick', cfg.p);
  if (t === 'f') return listSpec('fallback', cfg.f);
  return cfg.s || '';
}

/* ── Type helpers ────────────────────────────────────────────────────────── */

function _typeLabel(t) {
  return t === 'f' ? 'Fallback' : t === 'p' ? 'Pick' : t === 'r' ? 'Rand' : 'Static';
}

function _valueText(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r') {
    return cfg.r?.type === 'datetime'
      ? 'YYYY-MM-DD_HH-MM-SS'
      : `${cfg.r?.type || 'alphanumeric'} · ${cfg.r?.length || '8'}`;
  }
  if (t === 'p') return _listText(cfg.p, ' · ');
  if (t === 'f') return _listText(cfg.f, ' → ');
  return cfg.s || '';
}

const BLANK_TEXT = '∅ blank';

/** "a · ∅ blank · c" — a Blank is named, never shown as nothing. */
function _listText(arr, sep) {
  return listEntries(arr).map(v => (v === '' ? BLANK_TEXT : v)).join(sep) || '—';
}

/* ── DOM helpers ─────────────────────────────────────────────────────────── */

function getListEl() {
  return document.getElementById('variablesTableBody');
}

function _reindexRows() {
  const ul = getListEl();
  if (!ul) return;
  ul.querySelectorAll('li.var-row').forEach((li, i) => {
    const idx = li.querySelector('.vr-idx');
    if (idx) idx.textContent = (i + 1) + '.';
  });
  const empty = ul.querySelector('.var-list-empty');
  const hasRows = ul.querySelectorAll('li.var-row').length > 0;
  if (empty) empty.style.display = hasRows ? 'none' : '';
}

/* ── Auto-save ───────────────────────────────────────────────────────────── */

function _autoSave() {
  chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', ..._readTable() });
}

/* ── Drag to reorder ─────────────────────────────────────────────────────── */

// The row being dragged, and every row in the order it had when the drag
// began — put back when the row is let go outside the Variables card or the
// drag is cancelled with Esc, since no drop fires then.
let _dragRow     = null;
let _dragFrom    = null;
let _dragDropped = false;

function _rows() {
  return [...(getListEl()?.querySelectorAll('li.var-row') || [])];
}

function _onDragStart(li, e) {
  _dragRow     = li;
  _dragFrom    = _rows();
  _dragDropped = false;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function _onDragEnd(li) {
  li.classList.remove('dragging');
  const from = _dragFrom;
  _dragRow = _dragFrom = null;
  if (!from) return;
  if (!_dragDropped) getListEl()?.append(...from);
  else if (_rows().some((r, i) => r !== from[i])) _autoSave();
  _reindexRows();
}

/** The whole card is the drop area, so a row can be let go just above or below the list. */
function _initDragArea() {
  const ul   = getListEl();
  const area = ul?.closest('.card') || ul;
  if (!area) return;
  area.addEventListener('dragover', (e) => {
    if (!_dragRow) return; // a file or text dragged in from elsewhere
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = getDragAfterElement(ul, e.clientY);
    // Move only when the spot changes: every move re-lays the list out.
    if (after == null) {
      if (ul.lastElementChild === _dragRow) return;
      ul.appendChild(_dragRow);
    } else {
      if (_dragRow.nextElementSibling === after) return;
      ul.insertBefore(_dragRow, after);
    }
    _reindexRows();
  });
  area.addEventListener('drop', (e) => {
    if (!_dragRow) return;
    e.preventDefault();
    _dragDropped = true;
  });
}

/* ── Row rendering ───────────────────────────────────────────────────────── */

function _buildRow(key, valOrCfg) {
  const cfg = _migrateToConfig(valOrCfg);
  const t   = cfg.activeType || 's';

  const li = document.createElement('li');
  li.className      = `var-row t-${t}`;
  li.dataset.key    = key;
  li.dataset.config = JSON.stringify(cfg);
  li.draggable      = true;
  li.addEventListener('dragstart', (e) => _onDragStart(li, e));
  li.addEventListener('dragend',   () => _onDragEnd(li));

  const idxSpan = document.createElement('span');
  idxSpan.className = 'vr-idx';
  idxSpan.textContent = '1.';

  const typeSpan = document.createElement('span');
  typeSpan.className = 'vr-type';
  const iconBox = document.createElement('span');
  iconBox.className   = `vt-i ${t}`;
  iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : t === 'p' ? 'P' : 'F';
  typeSpan.appendChild(iconBox);
  typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));

  const keySpan = document.createElement('span');
  keySpan.className   = 'vr-key';
  keySpan.title       = key;
  keySpan.textContent = key || '—';

  const arrSpan = document.createElement('span');
  arrSpan.className   = 'vr-arr';
  arrSpan.textContent = '→';

  const valSpan = document.createElement('span');
  valSpan.className   = 'vr-val';
  valSpan.title       = _getActiveValue(cfg);
  valSpan.textContent = _valueText(cfg);

  if (t === 'p') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    const n = listEntries(cfg.p).length;
    sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
    valSpan.appendChild(sub);
  } else if (t === 'r') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    sub.textContent = 'new value each run';
    valSpan.appendChild(sub);
  } else if (t === 'f') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    const n = listEntries(cfg.f).length;
    sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
    valSpan.appendChild(sub);
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'var-btn-row';

  const editBtn = document.createElement('button');
  editBtn.className   = 'vr-edit';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => _openModal(li));

  const delBtn = document.createElement('button');
  delBtn.className   = 'vr-delete';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => {
    const varKey = li.dataset.key || 'this variable';
    showConfirm(`Delete variable "${varKey}"?`, () => {
      li.remove();
      _reindexRows();
      _autoSave();
      showToast(`"${varKey}" deleted`, 'success');
    }, { title: 'Delete Variable', danger: true });
  });

  btnRow.appendChild(editBtn);
  btnRow.appendChild(delBtn);

  li.appendChild(idxSpan);
  li.appendChild(typeSpan);
  li.appendChild(keySpan);
  li.appendChild(arrSpan);
  li.appendChild(valSpan);
  li.appendChild(btnRow);

  return li;
}

function _refreshRow(li) {
  let cfg;
  try { cfg = JSON.parse(li.dataset.config || '{}'); } catch { cfg = _defaultConfig(); }
  cfg = _migrateToConfig(cfg);
  const t = cfg.activeType || 's';

  li.className = `var-row t-${t}`;

  const typeSpan = li.querySelector('.vr-type');
  if (typeSpan) {
    typeSpan.innerHTML = '';
    const iconBox = document.createElement('span');
    iconBox.className   = `vt-i ${t}`;
    iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : t === 'p' ? 'P' : 'F';
    typeSpan.appendChild(iconBox);
    typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));
  }

  const key     = li.dataset.key || '';
  const keySpan = li.querySelector('.vr-key');
  if (keySpan) { keySpan.textContent = key || '—'; keySpan.title = key; }

  const valSpan = li.querySelector('.vr-val');
  if (valSpan) {
    valSpan.title       = _getActiveValue(cfg);
    valSpan.textContent = _valueText(cfg);
    if (t === 'p') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      const n = listEntries(cfg.p).length;
      sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
      valSpan.appendChild(sub);
    } else if (t === 'r') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      sub.textContent = 'new value each run';
      valSpan.appendChild(sub);
    } else if (t === 'f') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      const n = listEntries(cfg.f).length;
      sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
      valSpan.appendChild(sub);
    }
  }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export function addVariableRow(key = '', value = '') {
  const ul = getListEl();
  if (!ul) return;

  if (key || value) {
    const empty = findEmptyRow();
    if (empty) {
      const cfg = _migrateToConfig(value);
      empty.dataset.key    = key;
      empty.dataset.config = JSON.stringify(cfg);
      _refreshRow(empty);
      _reindexRows();
      return;
    }
  }

  const li = _buildRow(key, value);
  ul.appendChild(li);
  _reindexRows();
}

export function findEmptyRow() {
  const ul = getListEl();
  if (!ul) return null;
  for (const li of ul.querySelectorAll('li.var-row')) {
    if (!li.dataset.key) {
      try {
        const cfg = JSON.parse(li.dataset.config || '{}');
        if (!_getActiveValue(cfg)) return li;
      } catch { return li; }
    }
  }
  return null;
}

/**
 * { variables, order } in row order. The order travels as its own list: an
 * object cannot hold it — chrome.storage sorts the keys, and JS puts
 * number-like names ("1", "2") first whatever the order they were added in.
 */
function _readTable() {
  const variables = {};
  const order     = [];
  _rows().forEach(li => {
    const key = li.dataset.key?.trim();
    if (!key) return;
    if (!Object.hasOwn(variables, key)) order.push(key);
    try {
      variables[key] = JSON.parse(li.dataset.config || '{}');
    } catch {
      variables[key] = _defaultConfig();
    }
  });
  return { variables, order };
}

export function getVariablesFromTable() {
  return _readTable().variables;
}

export function loadVariables() {
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const ul = getListEl();
    if (!ul) return;
    ul.innerHTML = '';

    const empty = document.createElement('div');
    empty.className = 'var-list-empty';
    empty.textContent = 'No variables yet — click + Add Row';
    ul.appendChild(empty);

    const vars  = res?.variables || {};
    const order = Array.isArray(res?.order) ? res.order : Object.keys(vars);
    order.forEach(k => { if (Object.hasOwn(vars, k)) addVariableRow(k, vars[k]); });
    _reindexRows();
  });
}

/* ── Modal state ─────────────────────────────────────────────────────────── */

let _editingRow = null;
let _focusTimer  = null;
let _triggerEl   = null;
let _rndMode     = 'static'; // 'static' | 'string' | 'pick' | 'fallback'

const _TYPE_TO_MODE = { s: 'static', r: 'string', p: 'pick', f: 'fallback' };
const _MODE_TO_TYPE = { static: 's', string: 'r', pick: 'p', fallback: 'f' };

/* ── Pick / Fallback list helpers ────────────────────────────────────────── */

// Each row is a value or a Blank (the empty string). A Blank row shows a
// labelled pill instead of the input, so it never looks like a row someone
// forgot to fill in — those are dropped on save, a Blank is kept.

const _LIST_IDS = { pick: 'pickValuesList', fallback: 'fallbackValuesList' };

/** Order marks: fallback rows are tried A → B → C, pick rows are unordered. */
function _renumberList(kind) {
  const list = document.getElementById(_LIST_IDS[kind]);
  if (!list) return;
  list.querySelectorAll('.pick-value-row').forEach((row, i) => {
    const mark = row.querySelector('.pv-mark');
    if (mark) mark.textContent = kind === 'fallback' ? String.fromCharCode(65 + (i % 26)) : '•';
  });
}

function _setRowBlank(row, blank) {
  row.classList.toggle('is-blank', blank);
  row.dataset.blank = blank ? '1' : '';
  const inp  = row.querySelector('input');
  const btn  = row.querySelector('.blank-pick-btn');
  inp.hidden = blank;
  row.querySelector('.pv-blank-pill').hidden = !blank;
  btn.setAttribute('aria-pressed', String(blank));
  btn.title = blank ? 'Blank — click to type a value instead' : 'Make this entry Blank (empty value)';
}

function _addListValueRow(kind, value = '', doFocus = true) {
  const list = document.getElementById(_LIST_IDS[kind]);
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'pick-value-row';

  const mark = document.createElement('span');
  mark.className = 'pv-mark';
  mark.setAttribute('aria-hidden', 'true');

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.placeholder = 'e.g., active';
  inp.value       = value ?? '';
  inp.setAttribute('aria-label', 'Value');

  const pill = document.createElement('span');
  pill.className = 'pv-blank-pill';
  pill.innerHTML = '<b>∅ Blank</b> <span>empty value</span>';
  pill.hidden    = true;

  const blankBtn = document.createElement('button');
  blankBtn.className   = 'blank-pick-btn';
  blankBtn.type        = 'button';
  blankBtn.textContent = '∅';
  blankBtn.addEventListener('click', () => {
    const toBlank = row.dataset.blank !== '1';
    _setRowBlank(row, toBlank);
    if (!toBlank) inp.focus();
  });

  const del = document.createElement('button');
  del.className   = 'del-pick-btn';
  del.type        = 'button';
  del.textContent = '×';
  del.title       = 'Remove value';
  del.setAttribute('aria-label', 'Remove value');
  del.addEventListener('click', () => {
    if (list.querySelectorAll('.pick-value-row').length > 1) { row.remove(); _renumberList(kind); }
    else showToast('At least one value required', 'error');
  });

  row.append(mark, inp, pill, blankBtn, del);
  list.appendChild(row);
  _setRowBlank(row, value === null);
  _renumberList(kind);
  if (doFocus) (value === null ? blankBtn : inp).focus();
}

/** Entries in row order: trimmed values, null for a Blank; unfilled rows dropped. */
function _getListValues(kind) {
  const list = document.getElementById(_LIST_IDS[kind]);
  if (!list) return [];
  return [...list.querySelectorAll('.pick-value-row')]
    .map(row => (row.dataset.blank === '1' ? null : row.querySelector('input').value.trim()))
    .filter(v => v === null || v !== '');
}

const _addPickValueRow     = (value, doFocus) => _addListValueRow('pick', value, doFocus);
const _addFallbackValueRow = (value, doFocus) => _addListValueRow('fallback', value, doFocus);
const _getPickValues       = () => _getListValues('pick');
const _getFallbackValues   = () => _getListValues('fallback');

/* ── Length row visibility ───────────────────────────────────────────────── */

function _updateLengthRow(type) {
  const row = document.getElementById('rndLengthRow');
  if (row) row.style.display = type === 'datetime' ? 'none' : '';
}

/* ── Mode switching ──────────────────────────────────────────────────────── */

function _switchMode(mode) {
  _rndMode = mode;
  const sections = { static: 'rndStaticSection', string: 'rndStringSection', pick: 'rndPickSection', fallback: 'rndFallbackSection' };
  const tabs     = { static: 'rndTabStatic',     string: 'rndTabString',     pick: 'rndTabPick',     fallback: 'rndTabFallback'     };
  Object.entries(sections).forEach(([m, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = m === mode ? '' : 'none';
  });
  Object.entries(tabs).forEach(([m, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', m === mode);
    el.setAttribute('aria-selected', String(m === mode));
  });
}

/* ── Modal open / close ──────────────────────────────────────────────────── */

function _openModal(editRow = null) {
  _triggerEl  = document.activeElement;
  _editingRow = editRow;

  const modal      = document.getElementById('randomModal');
  const varName    = document.getElementById('randomVarName');
  const rndType    = document.getElementById('randomType');
  const rndLen     = document.getElementById('randomLength');
  const title      = document.getElementById('randomModalTitle');
  const confirmBtn = document.getElementById('confirmRandom');

  if (editRow) {
    let cfg;
    try { cfg = JSON.parse(editRow.dataset.config || '{}'); } catch { cfg = _defaultConfig(); }
    cfg = _migrateToConfig(cfg);

    if (varName) { varName.value = editRow.dataset.key || ''; varName.readOnly = false; }
    if (title)      title.textContent      = 'Edit Variable';
    if (confirmBtn) confirmBtn.textContent = 'Save';

    const sv = document.getElementById('staticValue');
    if (sv) sv.value = cfg.s || '';

    if (rndType) rndType.value = cfg.r?.type   || 'alphanumeric';
    if (rndLen)  rndLen.value  = cfg.r?.length  || '8';
    _updateLengthRow(cfg.r?.type || 'alphanumeric');

    // doFocus=false — all 4 tabs are populated at once, only the active tab should receive focus
    const pickList = document.getElementById('pickValuesList');
    if (pickList) {
      pickList.innerHTML = '';
      const pickVals = (cfg.p || []).filter(v => v !== undefined);
      (pickVals.length >= 2 ? pickVals : ['', '']).forEach(v => _addPickValueRow(v, false));
    }

    const fbListEl = document.getElementById('fallbackValuesList');
    if (fbListEl) {
      fbListEl.innerHTML = '';
      const fbVals = (cfg.f || []).filter(v => v !== undefined);
      (fbVals.length >= 2 ? fbVals : ['', '']).forEach(v => _addFallbackValueRow(v, false));
    }

    _switchMode(_TYPE_TO_MODE[cfg.activeType] || 'static');
  } else {
    if (varName) { varName.value = ''; varName.readOnly = false; }
    if (title)      title.textContent      = 'Add Variable';
    if (confirmBtn) confirmBtn.textContent = 'Add Variable';

    const sv = document.getElementById('staticValue');
    if (sv) sv.value = '';
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen)  rndLen.value  = '8';
    _updateLengthRow('alphanumeric');

    const pickList = document.getElementById('pickValuesList');
    if (pickList) { pickList.innerHTML = ''; _addPickValueRow('', false); _addPickValueRow('', false); }
    const fbListEl = document.getElementById('fallbackValuesList');
    if (fbListEl) { fbListEl.innerHTML = ''; _addFallbackValueRow('', false); _addFallbackValueRow('', false); }

    _switchMode('static');
  }

  modal?.setAttribute('aria-hidden', 'false');
  modal?.classList.add('show');
  lockScroll();
  clearTimeout(_focusTimer);
  _focusTimer = setTimeout(() => {
    _focusTimer = null;
    if (!document.getElementById('randomModal')?.classList.contains('show')) return;
    (editRow ? confirmBtn : varName)?.focus();
  }, 50);
}

function _closeModal() {
  clearTimeout(_focusTimer);
  _focusTimer = null;
  const modal = document.getElementById('randomModal');
  if (modal?.contains(document.activeElement)) document.activeElement.blur();
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  _triggerEl?.focus();
  _editingRow = null;
  _triggerEl  = null;
  unlockScroll();
}

/* ── Init ────────────────────────────────────────────────────────────────── */

export function initVariables() {
  const addBtn     = document.getElementById('addVariableRow');
  const modal      = document.getElementById('randomModal');
  const varName    = document.getElementById('randomVarName');
  const rndType    = document.getElementById('randomType');
  const rndLen     = document.getElementById('randomLength');
  const cancelBtn  = document.getElementById('cancelRandom');
  const confirmBtn = document.getElementById('confirmRandom');

  addBtn?.addEventListener('click', () => _openModal(null));

  cancelBtn?.addEventListener('click', _closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) _closeModal(); });

  document.querySelectorAll('.rnd-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchMode(btn.dataset.mode));
  });

  rndType?.addEventListener('change', () => _updateLengthRow(rndType.value));

  _initDragArea();

  document.getElementById('addPickValue')?.addEventListener('click',     () => _addPickValueRow(''));
  document.getElementById('addFallbackValue')?.addEventListener('click', () => _addFallbackValueRow(''));
  document.getElementById('addPickBlank')?.addEventListener('click',     () => _addPickValueRow(null));
  document.getElementById('addFallbackBlank')?.addEventListener('click', () => _addFallbackValueRow(null));

  confirmBtn?.addEventListener('click', () => {
    const name = varName?.value.trim();
    if (!name) {
      varName?.classList.add('required-error');
      setTimeout(() => varName?.classList.remove('required-error'), 2000);
      return;
    }

    // Read ALL tabs regardless of which is active — this is what preserves config across switches
    const staticVal    = document.getElementById('staticValue')?.value || '';
    const randTypeVal  = rndType?.value || 'alphanumeric';
    const randLenVal   = rndLen?.value  || '8';
    const pickVals     = _getPickValues();
    const fallbackVals = _getFallbackValues();

    if (_rndMode === 'fallback') {
      if (fallbackVals.length < 2) { showToast('Add at least 2 fallback values (a Blank counts)', 'error'); return; }
    } else if (_rndMode === 'pick') {
      if (pickVals.length < 2) { showToast('Add at least 2 values to Pick list (a Blank counts)', 'error'); return; }
    }

    const cfg = {
      activeType: _MODE_TO_TYPE[_rndMode] || 's',
      s: staticVal,
      r: { type: randTypeVal, length: randLenVal },
      p: pickVals.length     ? pickVals     : ['', ''],
      f: fallbackVals.length ? fallbackVals : ['', ''],
    };

    if (_editingRow) {
      _editingRow.dataset.key    = name;
      _editingRow.dataset.config = JSON.stringify(cfg);
      _refreshRow(_editingRow);
      _reindexRows();
      _closeModal();
      _autoSave();
      showToast(`"${name}" saved`, 'success');
    } else {
      addVariableRow(name, cfg);
      _closeModal();
      _autoSave();
      showToast(`"${name}" added`, 'success');
    }
  });

  loadVariables();
}
