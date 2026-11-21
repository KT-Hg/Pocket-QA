/**
 * content-highlight.js — the highlight engine: text highlights and notes on the
 * page (HL_* messages from the popup's Highlight tab): the tooltip, the painting,
 * restore on load and on page changes, URL patterns.
 *
 * Highlights are painted with the CSS Custom Highlight API (CSS.highlights): a
 * Range per highlight, one Highlight per colour, styled by ::highlight() rules.
 * The page's DOM is never touched. Its text nodes used to be split and wrapped in
 * <mark>, and a page that kept a reference to its text node (React, Vue) and later
 * changed it showed garbage: "Total: $40.00 due today42.00 due today".
 *
 * A classic script, not in the manifest: the worker injects it (HL_LOAD) into a
 * frame whose content.js asks for it, which happens only while highlighting is
 * on. It runs in content.js's isolated world, and what it uses from content.js
 * comes through window.__pqaContent (see HIGHLIGHT ENGINE LOADING there). Its own
 * guard makes a second injection do nothing.
 */

if (!window.__pqaHighlightInjected && window.__pqaContent) {
  window.__pqaHighlightInjected = true;

const {
  safeSend, getAllSelectors, findElementWithFallback, _isDynamicId, _DYNAMIC_ID_RE,
  _extOverlay, _extTokens, _extRegisterThemed, _EXT_THEMES, _EXT_ACCENT,
} = window.__pqaContent;

const _HL_KEY = 'hl_v1';

const _HL_COLORS = {
  yellow: { light: '#fde047', dark: 'rgba(253,224,71,0.75)'  },
  green:  { light: '#86efac', dark: 'rgba(74,222,128,0.70)'  },
  pink:   { light: '#f9a8d4', dark: 'rgba(244,114,182,0.72)' },
  blue:   { light: '#93c5fd', dark: 'rgba(147,197,253,0.72)' },
  orange: { light: '#fdba74', dark: 'rgba(251,146,60,0.75)'  },
};

function _hlBg(color) {
  const bg = window.getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\d+/g);
  const isDark = m ? (Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.114) < 100 : false;
  return isDark ? (_HL_COLORS[color]?.dark ?? _HL_COLORS.yellow.dark)
                : (_HL_COLORS[color]?.light ?? _HL_COLORS.yellow.light);
}

function _hlCtxOk() { return !!chrome.runtime?.id; }

// ── Toggle / enabled state ──
let _hlEnabled      = true;
let _hlObserver     = null;
let _hlRestoreTimer = null;
// Page changes are waited out this long before highlights are restored.
const HL_RESTORE_DEBOUNCE_MS = 600;
let _hlStyleEl      = null;

/**
 * Override user-select:none so text in any element can be selected for highlighting
 * — only while Alt is held. It used to be on for every element of every page from
 * load, so a page under test behaved unlike it does for its users (a button's label
 * became selectable, a drag on a board smeared text).
 * High-specificity selectors (0,1,2) beat site rules like h1.class (0,1,1);
 * draggables are left alone.
 */
const _HL_SELECT_CSS = [
  'html body *:not([draggable="true"]):not([draggable="true"] *)',
  '{ user-select: text !important; -webkit-user-select: text !important; }',
].join(' ');

function _hlInjectStyle() {
  if (_hlStyleEl) return;
  _hlStyleEl = document.createElement('style');
  _hlStyleEl.setAttribute('data-hl-ui', '1');
  _hlStyleEl.textContent = _HL_SELECT_CSS;
  (document.head || document.documentElement).appendChild(_hlStyleEl);
}

function _hlRemoveStyle() {
  _hlStyleEl?.remove();
  _hlStyleEl = null;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Alt' && _hlEnabled) _hlInjectStyle(); }, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Alt') _hlRemoveStyle(); }, true);
window.addEventListener('blur', _hlRemoveStyle);

/**
 * Watch the page for content that comes late (or comes back), only while it has
 * highlights: a page with none no longer reads the store on every change it makes.
 */
function _hlObserve(on) {
  if (on && _hlEnabled && !_hlObserver) {
    _hlObserver = new MutationObserver(() => {
      clearTimeout(_hlRestoreTimer);
      _hlRestoreTimer = setTimeout(() => { if (_hlCtxOk()) _hlRestore(); }, HL_RESTORE_DEBOUNCE_MS);
    });
    _hlObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else if (!on && _hlObserver) {
    _hlObserver.disconnect();
    _hlObserver = null;
  }
}

function _hlSetEnabled(on) {
  _hlEnabled = on;
  if (on) {
    _hlRestore();
  } else {
    _hlRemoveStyle();
    _hlObserve(false);
    _hlHideTip();
    _hlHideNotePop();
  }
}

// ── Painting ──
// id → { range, color, note, hidden, text }: what is painted, rebuilt into the
// CSS.highlights registry by _hlPaint.
const _hlLive = new Map();
const _HL_NAMES = ['yellow', 'green', 'pink', 'blue', 'orange'];
const _HL_FLASH_MS = 1200; // how long a scrolled-to highlight stays lit
let _hlPaintStyle = null;

function _hlPaint() {
  if (!globalThis.CSS?.highlights) return;
  const shown = [..._hlLive.values()].filter((h) => !h.hidden);
  const set = (name, ranges) => {
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  };
  for (const c of _HL_NAMES) set(`pqa-hl-${c}`, shown.filter((h) => (_HL_NAMES.includes(h.color) ? h.color : 'yellow') === c).map((h) => h.range));
  set('pqa-hl-note', shown.filter((h) => h.note).map((h) => h.range));

  // The ::highlight() rules, in a <style> of ours — only once there is something
  // to paint: a page with no highlights gets nothing at all.
  if (!_hlPaintStyle?.isConnected && !shown.length) return;
  const css = _HL_NAMES.map((c) => `::highlight(pqa-hl-${c}){background-color:${_hlBg(c)}}`).join('')
    + '::highlight(pqa-hl-note){text-decoration:underline dotted;text-underline-offset:2px}'
    + '::highlight(pqa-hl-flash){background-color:#6366f1;color:#fff}';
  if (!_hlPaintStyle?.isConnected) {
    _hlPaintStyle = document.createElement('style');
    _hlPaintStyle.setAttribute('data-hl-ui', '1');
    (document.head || document.documentElement).appendChild(_hlPaintStyle);
  }
  if (_hlPaintStyle.textContent !== css) _hlPaintStyle.textContent = css;
}

/** The highlight painted under (x, y), or null. */
function _hlAt(x, y) {
  for (const [id, h] of _hlLive) {
    if (h.hidden) continue;
    for (const r of h.range.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
  }
  return null;
}

/** Whether a painted range still holds its text in the page. */
function _hlRangeOk(h) {
  const r = h?.range;
  return !!r && r.startContainer.isConnected && r.endContainer.isConnected && r.toString().trim() === h.text;
}

// ── URL pattern normalisation ──
const _HL_PATTERNS_KEY = 'hl_patterns_v1';
let _hlPatterns = [];

// A bare #anchor jumps within the same document, so it must not fork the
// storage key — otherwise clicking a table-of-contents link makes the page's
// highlights vanish. A #/route (or #!/route) hash is a router path and does
// name a different page, so that one stays part of the key.
function _hlCanonicalUrl(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  if (i === -1) return s;
  const first = s[i + 1];
  return (first === '/' || first === '!') ? s : s.slice(0, i);
}

function _hlMatchPattern(url, pattern) {
  const strip = s => _hlCanonicalUrl(s).replace(/^https?:\/\//, '');
  const pat = strip(pattern);
  const u   = strip(url);
  // A pattern naming no query of its own matches whatever query the URL carries
  // — /products and /products?page=2 are one page as far as a grouping rule is
  // concerned. A pattern that does name a query is matched against it.
  const target  = pat.includes('?') ? u : u.split('?')[0];
  const escaped = pat
    .replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)
    .replace(/\*/g, '[^/?#]+');   // one path segment — never across ? or #
  try { return new RegExp('^' + escaped + '(/.*)?$').test(target); }
  catch (_) { return false; }
}

function _hlNormalizeUrl(url) {
  for (const p of _hlPatterns) {
    if (_hlMatchPattern(url, p)) return p;
  }
  return _hlCanonicalUrl(url);
}

// Forget every painted highlight without touching storage — used when the storage
// key changes under us (pattern added/removed) and the page must be re-painted
// from the new bucket.
function _hlForgetAll() {
  _hlLive.clear();
  _hlPaint();
}

// Patterns changed → this page's storage key may have moved. Repaint from the
// bucket the page now resolves to.
let _hlPatternRefreshTimer = null;
// Pattern changes arriving together are applied once.
const HL_PATTERN_REFRESH_MS = 150;
function _hlRefreshForPatterns() {
  clearTimeout(_hlPatternRefreshTimer);
  _hlPatternRefreshTimer = setTimeout(() => {
    // Runs even when highlighting is off: highlights already painted stay on the
    // page in that state, so leaving them would show the old bucket's set.
    if (!_hlCtxOk()) return;
    _hlHideTip();
    _hlHideNotePop();
    _hlForgetAll();
    _hlRestore();
  }, HL_PATTERN_REFRESH_MS);
}

// ── Bootstrap: load patterns + enabled state, then start observer ──
function _hlInit() {
  try {
    if (!_hlCtxOk()) { _hlSetEnabled(true); return; }
    // popupTheme is loaded by the shared overlay bootstrap, not here.
    chrome.storage.local.get(['hl_enabled', _HL_PATTERNS_KEY], res => {
      try {
        void chrome.runtime.lastError;
        _hlPatterns = res[_HL_PATTERNS_KEY] || [];
        _hlApplyTipTheme();
        _hlSetEnabled(res.hl_enabled !== false);
      } catch (_) { _hlSetEnabled(true); }
    });
  } catch (_) { _hlSetEnabled(true); }
}

// Keep patterns in sync when the popup changes them
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[_HL_PATTERNS_KEY]) {
      _hlPatterns = changes[_HL_PATTERNS_KEY].newValue || [];
      // The bucket this page reads from just moved — repaint. Debounced, so the
      // hl_v1 re-group written alongside the patterns lands first.
      _hlRefreshForPatterns();
    }
  });
} catch (_) { /* extension context invalidated: no live pattern updates */ }

function _hlGetAll(cb) {
  try {
    if (!_hlCtxOk()) return;
    chrome.storage.local.get(_HL_KEY, res => {
      try {
        void chrome.runtime.lastError;
        cb(res[_HL_KEY] || {});
      } catch (_) { /* context invalidated mid-callback: highlights are not restored */ }
    });
  } catch (_) { /* extension context invalidated: highlights are not restored */ }
}

// Edits to this page's highlights (shared/highlight-store.js), applied by the
// worker (HL_EDIT) to the store as it is then: sending the whole list this tab
// had read lost a highlight another tab on the same page saved meanwhile.
function _hlEdit(ops, cb) {
  const key = _hlNormalizeUrl(location.href);
  try {
    if (!_hlCtxOk()) { cb?.(); return; }
    chrome.runtime.sendMessage({ type: 'HL_EDIT', url: key, ops }, () => {
      try {
        void chrome.runtime.lastError;
        safeSend({ type: 'HL_UPDATED', url: key });
        cb?.();
      } catch (_) { cb?.(); }
    });
  } catch (_) { cb?.(); }
}

function _hlGetPage(cb) {
  _hlGetAll(all => cb(all[_hlNormalizeUrl(location.href)] || []));
}

// ── Tooltip ──
let _hlTip = null;
let _hlRange = null;
let _hlAnchor = '';
let _hlParentSel = '';

// Tooltip mode: 'create' (from text selection) or 'edit' (hovering an existing
// highlight).  Both share one tooltip element — colour swatches + a note field.
let _hlTipMode    = 'create';
let _hlTipEditId  = null;
let _hlColorBtns  = {};     // color → swatch button
let _hlNoteWrap   = null;
let _hlNoteInput  = null;
let _hlNoteSaveBtn = null;
let _hlNoteHint   = null;
let _hlDelBtn     = null;
let _hlNoteBtn    = null;
let _hlTipLabel   = null;
let _hlNotePop    = null;   // small bubble showing a highlight's note on hover

// Solid swatch colour of each highlight colour: the tooltip's colour dots and the
// note bubble's accent.
const _HL_SWATCHES = { yellow:'#fde047', green:'#86efac', pink:'#f9a8d4', blue:'#93c5fd', orange:'#fdba74' };

function _hlTipEl() {
  if (_hlTip) return _hlTip;
  const t0 = _extTokens();
  // Same template as the capture overlays — `panel` variant, since this one is
  // positioned against a text selection and owns its own content. The template
  // keeps the surface themed; _hlApplyTipTheme only paints the inner parts.
  const tip = _extOverlay({
    variant: 'panel',
    label: null, hint: null,
    extra: ['pointer-events:auto', 'user-select:none', 'font-size:12px'],
  });
  const d = tip.el;
  d.setAttribute('data-hl-ui', '1');

  const lbl = document.createElement('div');
  lbl.textContent = 'Highlight color:';
  lbl.style.cssText = `font-size:11px;color:${t0.sub};font-family:inherit;line-height:1;`;
  _hlTipLabel = lbl;
  d.appendChild(lbl);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;font-family:inherit;line-height:0;';

  const DOTS = _HL_SWATCHES;
  const LABELS = { yellow:'Yellow', green:'Green', pink:'Pink', blue:'Blue', orange:'Orange' };
  _hlColorBtns = {};
  Object.keys(DOTS).forEach(color => {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'all:initial', 'display:inline-block',
      `background:${DOTS[color]}`,
      'width:22px', 'height:22px', 'border-radius:50%',
      'cursor:pointer', 'border:2px solid transparent',
      'box-sizing:border-box',
      'transition:transform 0.1s,border-color 0.1s',
    ].join(';');
    btn.title = LABELS[color];
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.25)'; btn.style.borderColor = 'rgba(255,255,255,0.7)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.borderColor = btn.dataset.sel === '1' ? 'rgba(255,255,255,0.9)' : 'transparent'; });
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (_hlTipMode === 'edit') _hlEditSetColor(color);
      else _hlApply(color);
    });
    _hlColorBtns[color] = btn;
    row.appendChild(btn);
  });

  // Note toggle button — placed after the orange swatch.
  const noteBtn = document.createElement('button');
  noteBtn.textContent = '📝';
  noteBtn.title = 'Note';
  noteBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'font-size:16px', 'line-height:1',
    'width:24px', 'height:24px', 'border-radius:6px', 'text-align:center',
    'border:1px solid rgba(255,255,255,0.18)', 'box-sizing:border-box',
    'margin-left:2px', 'transition:background 0.1s',
  ].join(';');
  noteBtn.addEventListener('mouseenter', () => { noteBtn.style.background = 'rgba(255,255,255,0.12)'; });
  noteBtn.addEventListener('mouseleave', () => { noteBtn.style.background = 'transparent'; });
  noteBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  noteBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = _hlNoteWrap.style.display !== 'none';
    _hlNoteWrap.style.display = open ? 'none' : 'flex';
    if (!open) _hlNoteInput.focus();
  });
  _hlNoteBtn = noteBtn;
  row.appendChild(noteBtn);

  // Delete button — shown only in edit mode (existing highlight).
  // Solid red with a white SVG icon so it stays clearly visible in both themes
  // (the 🗑 emoji renders dark and gets lost on the dark tooltip).
  const delBtn = document.createElement('button');
  delBtn.title = 'Delete highlight';
  delBtn.innerHTML = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<polyline points="3 6 5 6 21 6"></polyline>',
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>',
    '<line x1="10" y1="11" x2="10" y2="17"></line>',
    '<line x1="14" y1="11" x2="14" y2="17"></line>',
    '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
    '</svg>',
  ].join('');
  delBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'line-height:0',
    'display:none', 'align-items:center', 'justify-content:center',
    'width:26px', 'height:26px', 'border-radius:6px',
    'background:#ef4444', 'border:1px solid #ef4444',
    'box-sizing:border-box', 'margin-left:auto', 'transition:background 0.1s',
  ].join(';');
  delBtn.addEventListener('mouseenter', () => { delBtn.style.background = '#dc2626'; });
  delBtn.addEventListener('mouseleave', () => { delBtn.style.background = '#ef4444'; });
  delBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (_hlTipMode === 'edit' && _hlTipEditId) {
      _hlRemove(_hlTipEditId);
      _hlHideTip();
    }
  });
  row.appendChild(delBtn);
  d.appendChild(row);

  // Note editor (collapsible).
  const nw = document.createElement('div');
  nw.style.cssText = 'display:none;flex-direction:column;gap:4px;margin-top:2px;font-family:inherit;';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Add a note…';
  ta.rows = 2;
  ta.style.cssText = [
    'all:initial', 'box-sizing:border-box', 'width:180px', 'resize:vertical',
    'min-height:38px', 'padding:5px 6px', 'border-radius:6px',
    `border:1px solid ${t0.btnBorder}`, `background:${t0.taBg}`,
    `color:${t0.text}`, 'font-family:inherit', 'font-size:12px', 'line-height:1.4',
  ].join(';');
  ta.addEventListener('mousedown', e => e.stopPropagation());
  ta.addEventListener('mouseup',   e => e.stopPropagation());
  ta.addEventListener('click',     e => e.stopPropagation());
  ta.addEventListener('keydown',   e => e.stopPropagation());
  nw.appendChild(ta);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-family:inherit;';

  const hint = document.createElement('span');
  hint.style.cssText = `font-size:11px;color:${t0.sub};font-family:inherit;`;

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save note';
  saveBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'font-family:inherit', 'font-size:12px',
    'padding:3px 10px', 'border-radius:6px', 'color:#fff',
    `background:${_EXT_ACCENT}`, 'border:1px solid rgba(255,255,255,0.15)',
  ].join(';');
  saveBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  saveBtn.addEventListener('click', e => { e.stopPropagation(); if (_hlTipMode === 'edit') _hlEditSaveNote(); });

  actions.appendChild(hint);
  actions.appendChild(saveBtn);
  nw.appendChild(actions);
  d.appendChild(nw);

  tip.mount();
  _hlTip = d;
  _hlNoteWrap = nw;
  _hlNoteInput = ta;
  _hlNoteSaveBtn = saveBtn;
  _hlNoteHint = hint;
  _hlDelBtn = delBtn;
  _hlApplyTipTheme();
  return d;
}

// ── Apply the current theme's palette to the tooltip + note bubble ──
// Only the inner parts: both panels' surfaces are painted by their overlay
// template registration. The palette is the overlays' own (_EXT_THEMES), so the
// highlight UI and the capture chrome stay on one palette.
function _hlApplyTipTheme(t = _extTokens()) {
  if (_hlTipLabel)  _hlTipLabel.style.color = t.sub;
  if (_hlNoteHint)  _hlNoteHint.style.color = t.sub;
  if (_hlNoteInput) {
    _hlNoteInput.style.background  = t.taBg;
    _hlNoteInput.style.color       = t.text;
    _hlNoteInput.style.borderColor = t.btnBorder;
  }
  if (_hlNoteBtn) _hlNoteBtn.style.borderColor = t.btnBorder;
  if (_hlNotePop) {
    if (_hlNotePop._dot) _hlNotePop._dot.style.boxShadow =
      `0 0 0 2px ${t === _EXT_THEMES.light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)'}`;
    if (_hlNotePop._arrow) {
      const arrow = _hlNotePop._arrow;
      arrow.style.background = t.bg;
      // Stash the themed border shorthand for _hlPositionNotePop's two sides.
      arrow._border = `1px solid ${t.border}`;
    }
  }
}
_extRegisterThemed(_hlApplyTipTheme);

function _hlPositionTip(rect) {
  const tt = _hlTip;
  const tw = tt.offsetWidth || 200, th = tt.offsetHeight || 80;
  let top  = rect.top - th - 10;
  let left = rect.left + rect.width / 2 - tw / 2;
  if (top < 8) top = rect.bottom + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tt.style.top  = top  + 'px';
  tt.style.left = left + 'px';
}

// Configure swatch selection rings; pass null to clear all (create mode).
function _hlSetSwatchSel(color) {
  Object.entries(_hlColorBtns).forEach(([c, b]) => {
    const sel = c === color;
    b.dataset.sel = sel ? '1' : '';
    b.style.borderColor = sel ? 'rgba(255,255,255,0.9)' : 'transparent';
  });
}

// ── Show tooltip for a fresh selection (create mode) ──
function _hlShowTip(rect) {
  _hlTipEl();
  _hlTipMode   = 'create';
  _hlTipEditId = null;
  _hlNoteInput.value      = '';
  _hlNoteWrap.style.display = 'none';
  _hlNoteHint.textContent = 'Pick a color to apply';
  _hlNoteSaveBtn.style.display = 'none';
  _hlDelBtn.style.display = 'none';
  _hlHideNotePop();
  _hlSetSwatchSel(null);
  _hlTip.style.display = 'flex';
  _hlPositionTip(rect);
}

// ── Show tooltip for an existing highlight (edit mode) — opened by clicking it ──
function _hlShowEditTipFor(id) {
  const live = _hlLive.get(id);
  if (!live) return;
  _hlGetPage(list => {
    const h = list.find(x => x.id === id);
    if (!h) return;
    _hlTipEl();
    _hlTipMode   = 'edit';
    _hlTipEditId = id;
    _hlNoteInput.value        = h.note || '';
    _hlNoteWrap.style.display = h.note ? 'flex' : 'none';
    _hlNoteHint.textContent   = '';
    _hlNoteSaveBtn.style.display = '';
    _hlDelBtn.style.display   = 'inline-flex';
    _hlSetSwatchSel(h.color);
    _hlHideNotePop();
    _hlTip.style.display = 'flex';
    _hlPositionTip(live.range.getBoundingClientRect());
  });
}

// ── Edit-mode actions ──
function _hlEditSetColor(color) {
  if (!_hlTipEditId) return;
  const id = _hlTipEditId;
  const live = _hlLive.get(id);
  if (live) { live.color = color; _hlPaint(); }
  _hlSetSwatchSel(color);
  _hlEdit([{ op: 'set', id, fields: { color } }]);
}

function _hlEditSaveNote() {
  if (!_hlTipEditId) return;
  const id = _hlTipEditId;
  const note = (_hlNoteInput.value || '').trim();
  _hlApplyNote(id, note);
  _hlEdit([{ op: 'set', id, fields: { note } }], () => _hlHideTip());
}

function _hlHideTip() {
  if (_hlTip) _hlTip.style.display = 'none';
  _hlRange = null;
  _hlAnchor = '';
  _hlParentSel = '';
  _hlTipMode   = 'create';
  _hlTipEditId = null;
}

// The selection is read a moment after mouseup, once the browser has settled it.
const SELECTION_SETTLE_MS = 10;

document.addEventListener('mouseup', e => {
  setTimeout(() => {
    if (!_hlEnabled) return;
    if (e.target?.closest?.('[data-hl-ui]')) return;
    const sel = window.getSelection();
    // A click on a highlight opens its edit tooltip (the click listener below).
    if (!sel || sel.isCollapsed) { if (!_hlAt(e.clientX, e.clientY)) _hlHideTip(); return; }
    const text = sel.toString().trim();
    if (!text) { _hlHideTip(); return; }
    const range = sel.getRangeAt(0);
    if (e.target?.closest?.('[data-hl-ui]')) return;
    _hlRange = range.cloneRange();
    _hlAnchor = _hlGetFlatCtx(range);
    _hlParentSel = _hlGetParentSel(range);
    _hlShowTip(range.getBoundingClientRect());
  }, SELECTION_SETTLE_MS);
}, true);

document.addEventListener('mousedown', e => {
  if (!e.target?.closest?.('[data-hl-ui]')) _hlHideTip();
}, true);

// A click on a highlight → its edit tooltip (colour / note / delete), and the page
// does not get the click, as it did not when the highlight was a <mark>. Not while
// recording: there the click is a step, and the page must act on it.
document.addEventListener('click', e => {
  if (!_hlEnabled || e.button !== 0 || e.altKey || !_hlLive.size) return;
  if (e.target?.closest?.('[data-hl-ui]') || window.__pqaContent.isRecording?.()) return;
  if (!window.getSelection()?.isCollapsed) return;
  const id = _hlAt(e.clientX, e.clientY);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  _hlShowEditTipFor(id);
}, true);

/* ── Note hover bubble — shows ONLY the note text (not the edit tooltip) ──
   Features: fade in/out, hover-intent delay, an arrow pointing at the mark,
   and an interactive body (hover in to select/copy text or click links). */
const _HL_NOTE_SHOW_DELAY = 280;   // ms of hover before the bubble appears
const _HL_NOTE_HIDE_DELAY = 200;   // ms grace to cross the gap into the bubble
// The tooltip's swatch colours, as the bubble's accent — links the bubble
// visually to the highlight it belongs to.
const _HL_NOTE_ACCENT = _HL_SWATCHES;
let _hlNotePopId = null;            // highlight the bubble is currently showing for
let _hlNotePopShowT = null;
let _hlNotePopHideT = null;

function _hlNotePopEl() {
  if (_hlNotePop) return _hlNotePop;

  // One-time thin scrollbar styling for the (scoped) note body.
  if (!document.getElementById('hl-note-pop-style')) {
    const st = document.createElement('style');
    st.id = 'hl-note-pop-style';
    st.textContent = [
      '[data-hl-note-body]::-webkit-scrollbar{width:7px}',
      '[data-hl-note-body]::-webkit-scrollbar-thumb{',
      'background:rgba(128,128,128,0.4);border-radius:7px;',
      'background-clip:padding-box;border:2px solid transparent}',
      '[data-hl-note-body]::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,0.6);background-clip:padding-box;border:2px solid transparent}',
      '[data-hl-note-body]::-webkit-scrollbar-track{background:transparent}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  // Same `panel` template as the tooltip; `extra` carries only what is genuinely
  // this bubble's own — its stacking order below the tooltip, its size bounds and
  // its enter/leave animation.
  const pop = _extOverlay({
    variant: 'panel',
    label: null, hint: null,
    extra: [
      'z-index:2147483646', 'opacity:0',
      'transform:translateY(6px) scale(0.96)', 'transform-origin:top center',
      'transition:opacity 0.16s cubic-bezier(0.16,1,0.3,1), transform 0.16s cubic-bezier(0.16,1,0.3,1)',
      'max-width:320px', 'min-width:120px', 'pointer-events:auto',
    ],
  });
  const d = pop.el;
  d.setAttribute('data-hl-ui', '1');

  // Header row: a colour dot matching the highlight + a "Note" label.
  const head = document.createElement('div');
  head.style.cssText = [
    'all:initial', 'display:flex', 'align-items:center', 'gap:6px',
    'font-family:inherit', 'color:inherit', 'margin:0 0 6px',
    'user-select:none', 'pointer-events:none',
  ].join(';');

  const dot = document.createElement('span');
  dot.style.cssText = [
    'all:initial', 'display:inline-block', 'width:9px', 'height:9px',
    'border-radius:50%', 'background:#fde047', 'flex:0 0 auto',
    'box-shadow:0 0 0 2px rgba(255,255,255,0.08)',
  ].join(';');

  const lbl = document.createElement('span');
  lbl.textContent = 'Note';
  lbl.style.cssText = [
    'all:initial', 'font-family:inherit', 'font-size:10px', 'font-weight:700',
    'letter-spacing:0.6px', 'text-transform:uppercase', 'opacity:0.85',
    'color:inherit',
  ].join(';');

  head.appendChild(dot);
  head.appendChild(lbl);

  // Scrollable body holding the note text (and any linkified URLs)
  const body = document.createElement('div');
  body.setAttribute('data-hl-note-body', '1');
  body.style.cssText = [
    'all:initial', 'display:block', 'font-family:inherit',
    'white-space:pre-wrap', 'word-break:break-word', 'font-size:13px',
    'line-height:1.55', 'color:inherit', 'max-height:220px',
    'overflow-y:auto', 'user-select:text', 'cursor:text',
    'scrollbar-width:thin', 'scrollbar-color:rgba(128,128,128,0.4) transparent',
  ].join(';');

  // Arrow pointing at the highlighted mark (a rotated square)
  const arrow = document.createElement('div');
  arrow.style.cssText = [
    'all:initial', 'position:absolute', 'width:10px', 'height:10px',
    'background:#1e1e2e', 'transform:rotate(45deg)', 'pointer-events:none',
    'border-radius:2px',
  ].join(';');

  d.appendChild(head);
  d.appendChild(body);
  d.appendChild(arrow);
  d._body = body;
  d._arrow = arrow;
  d._dot = dot;

  // Keep the bubble open while the pointer is inside it.
  d.addEventListener('mouseenter', () => { clearTimeout(_hlNotePopHideT); });
  d.addEventListener('mouseleave', _hlScheduleHideNotePop);

  pop.mount();
  _hlNotePop = d;
  _hlApplyTipTheme();
  return d;
}

function _hlPositionNotePop(pop, r) {
  const pw = pop.offsetWidth || 220, ph = pop.offsetHeight || 48;
  const markCx = r.left + r.width / 2;

  let above = true;
  let top = r.top - ph - 9;
  if (top < 8) { top = r.bottom + 9; above = false; }
  const left = Math.max(8, Math.min(markCx - pw / 2, window.innerWidth - pw - 8));
  pop.style.top  = top  + 'px';
  pop.style.left = left + 'px';

  // Point the arrow at the mark's centre, clamped to the bubble's edges.
  const arrow = pop._arrow;
  const border = arrow._border || '1px solid rgba(255,255,255,0.12)';
  const ax = Math.max(10, Math.min(markCx - left - 5, pw - 20));
  arrow.style.left = ax + 'px';
  if (above) {
    arrow.style.top = '';
    arrow.style.bottom = '-5px';
    arrow.style.borderRight  = border;
    arrow.style.borderBottom = border;
    arrow.style.borderTop = arrow.style.borderLeft = 'none';
  } else {
    arrow.style.bottom = '';
    arrow.style.top = '-5px';
    arrow.style.borderLeft = border;
    arrow.style.borderTop  = border;
    arrow.style.borderBottom = arrow.style.borderRight = 'none';
  }
}

// Turn bare URLs in the note text into clickable links; everything else
// stays as plain text. Returns a DocumentFragment safe to insert.
function _hlLinkifyNote(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'color:#89b4fa;text-decoration:underline;word-break:break-all';
    frag.appendChild(a);
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function _hlShowNotePop(id) {
  const h = _hlLive.get(id);
  const note = h?.note;
  if (!note) return;
  const pop = _hlNotePopEl();
  _hlNotePopId = id;
  pop._body.textContent = '';
  pop._body.appendChild(_hlLinkifyNote(note));
  // Tint the header dot to match the highlight's colour.
  if (pop._dot) pop._dot.style.background = _HL_NOTE_ACCENT[h.color] || _HL_NOTE_ACCENT.yellow;
  pop.style.display = 'block';
  _hlPositionNotePop(pop, h.range.getBoundingClientRect());
  // Trigger the fade/slide-in on the next frame.
  requestAnimationFrame(() => {
    pop.style.opacity = '1';
    pop.style.transform = 'translateY(0) scale(1)';
  });
}

// Show after a short hover so a quick mouse pass doesn't flicker the bubble.
function _hlScheduleShowNotePop(id) {
  clearTimeout(_hlNotePopHideT);
  if (_hlNotePopId === id && _hlNotePop?.style.display === 'block') return;
  clearTimeout(_hlNotePopShowT);
  _hlNotePopShowT = setTimeout(() => _hlShowNotePop(id), _HL_NOTE_SHOW_DELAY);
}

function _hlScheduleHideNotePop() {
  clearTimeout(_hlNotePopShowT);
  clearTimeout(_hlNotePopHideT);
  _hlNotePopHideT = setTimeout(_hlHideNotePop, _HL_NOTE_HIDE_DELAY);
}

function _hlHideNotePop() {
  clearTimeout(_hlNotePopShowT);
  clearTimeout(_hlNotePopHideT);
  _hlNotePopId = null;
  if (!_hlNotePop) return;
  const pop = _hlNotePop;
  pop.style.opacity = '0';
  pop.style.transform = 'translateY(6px) scale(0.96)';
  const NOTE_POP_FADE_MS = 160; // the fade-out above, then it is taken out of the layout
  setTimeout(() => { if (pop.style.opacity === '0') pop.style.display = 'none'; }, NOTE_POP_FADE_MS);
}

// Hover a highlight that has a note → show the note bubble (unless the edit
// tooltip is already open for it). Nothing to hover: the painted ranges are hit
// by the pointer's position, once a frame at most.
let _hlHoverId = null;
let _hlMoveRaf = 0;
let _hlLastMove = null;
document.addEventListener('mousemove', e => {
  if (!_hlEnabled || !_hlLive.size) return;
  _hlLastMove = e;
  if (_hlMoveRaf) return;
  _hlMoveRaf = requestAnimationFrame(() => {
    _hlMoveRaf = 0;
    const ev = _hlLastMove;
    // Into the bubble itself: its own mouseenter keeps it open.
    if (_hlNotePop?.contains(ev.target)) return;
    const id = _hlAt(ev.clientX, ev.clientY);
    const withNote = id && _hlLive.get(id)?.note ? id : null;
    if (withNote === _hlHoverId) return;
    _hlHoverId = withNote;
    if (!withNote) { _hlScheduleHideNotePop(); return; }
    if (_hlTipMode === 'edit' && _hlTip?.style.display === 'flex' && _hlTipEditId === withNote) return;
    _hlScheduleShowNotePop(withNote);
  });
}, true);

// ── Build CSS selector for the element containing the selection ──
// Stored alongside each highlight so restore can pinpoint the exact element
// instead of relying on flat-text anchor matching alone (which fails for
// common words like "HTML" that appear hundreds of times on a page).
function _hlGetParentSel(range) {
  const sc = range.startContainer;
  const el = sc.nodeType === Node.TEXT_NODE ? sc.parentElement : sc;
  if (!el || el === document.body || el === document.documentElement) return '';

  const path = [];
  let cur = el;
  while (cur && cur !== document.body && path.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && !_isDynamicId(cur.id)) {
      // Stable ID found — use as anchor and stop walking up
      path.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    if (cur.className && typeof cur.className === 'string') {
      const cls = cur.className.split(/\s+/)
        .filter(c => c.length > 2 && !_DYNAMIC_ID_RE.test(c))
        .slice(0, 2);
      if (cls.length) part += cls.map(c => '.' + CSS.escape(c)).join('');
    }
    path.unshift(part);
    cur = cur.parentElement;
  }

  const sel = path.join(' > ');
  try { if (sel && document.querySelector(sel)) return sel; } catch (_) { /* the path is not a valid selector: no selector */ }
  return '';
}

// ── Find a Range for text within a specific root element ──
function _hlFindRangeIn(root, text) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('[data-hl-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  let pos = 0;
  const offsets = nodes.map(n => { const s = pos; pos += n.textContent.length; return s; });
  const flat = nodes.map(n => n.textContent).join('');

  const idx = flat.indexOf(text);
  if (idx < 0) return null;

  const end = idx + text.length;
  let startNode, startOff, endNode, endOff;
  for (let i = 0; i < nodes.length; i++) {
    const s = offsets[i], e = s + nodes[i].textContent.length;
    if (!startNode && idx < e) { startNode = nodes[i]; startOff = idx - s; }
    if (end <= e)               { endNode   = nodes[i]; endOff   = end - s; break; }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

// ── Build 50-char context window around a range in the page's flat text ──
// Used to disambiguate identical text appearing multiple times on a page.
function _hlGetFlatCtx(range) {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('[data-hl-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let pos = 0;
  const offsets = nodes.map(nd => { const s = pos; pos += nd.textContent.length; return s; });
  const flat    = nodes.map(nd => nd.textContent).join('');
  const sc = range.startContainer;
  if (sc.nodeType !== Node.TEXT_NODE) return '';
  const si = nodes.indexOf(sc);
  if (si < 0) return '';
  const start = offsets[si] + range.startOffset;
  return flat.slice(Math.max(0, start - 10), start + range.toString().length + 40);
}

// ── Apply highlight — a Range painted under the colour chosen ──
function _hlApply(color) {
  if (!_hlRange) return;
  const text = _hlRange.toString().trim();
  if (!text) return;

  const id        = 'hl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const anchor    = _hlAnchor;
  const parentSel = _hlParentSel;
  const note      = (_hlNoteInput?.value || '').trim();

  const _anchorNode = _hlRange.commonAncestorContainer;
  const _containerEl = _anchorNode.nodeType === Node.TEXT_NODE ? _anchorNode.parentElement : _anchorNode;
  const containerSelectors = (_containerEl && _containerEl !== document.body && _containerEl !== document.documentElement)
    ? getAllSelectors(_containerEl)
    : null;

  // The range painted is the text itself, as a restore will find it again. The
  // stored Range goes stale if the page re-renders between the selection and the
  // colour (common on SPAs): then the text is found in the live DOM instead.
  let range = null;
  if (_hlRange.startContainer.isConnected && _containerEl?.isConnected) range = _hlFindRangeIn(_containerEl, text) || _hlRange.cloneRange();
  else range = _hlFindRange(text, anchor, parentSel);
  if (!range) { _hlHideTip(); return; }

  _hlLive.set(id, { range, color, note, hidden: false, text });
  _hlPaint();
  _hlObserve(true);
  window.getSelection().removeAllRanges();

  // srcUrl records the real page this highlight was made on. The storage key
  // may be a URL pattern, so without it a pattern change would orphan the
  // entry with no way to re-group it. See hlRegroup (shared/highlight-store.js).
  _hlEdit([{ op: 'add', item: { id, text, color, note, createdAt: Date.now(), srcUrl: location.href, anchor, parentSel, containerSelectors } }]);

  // Keep the tooltip open in edit mode on the highlight just created, so the
  // user can add a note if they want — but leave the note field collapsed until
  // they click the 📝 button.
  _hlRange = null;
  _hlAnchor = '';
  _hlParentSel = '';
  _hlTipMode   = 'edit';
  _hlTipEditId = id;
  _hlNoteWrap.style.display    = 'none';
  _hlNoteHint.textContent      = '';
  _hlNoteSaveBtn.style.display = '';
  _hlDelBtn.style.display      = 'inline-flex';
  _hlSetSwatchSel(color);
  _hlPositionTip(range.getBoundingClientRect());
}

// ── A note's dotted underline follows the note ──
function _hlApplyNote(id, note) {
  const live = _hlLive.get(id);
  if (live) { live.note = note; _hlPaint(); }
}

// ── Remove ──
function _hlRemove(id) {
  _hlLive.delete(id);
  _hlPaint();
  _hlEdit([{ op: 'remove', id }]);
}

// ── Clear page ──
function _hlClear() {
  _hlForgetAll();
  _hlEdit([{ op: 'clear' }]);
}

// ── Find a Range for text that may span across element boundaries (e.g. <a> tags) ──
// parentSel: CSS selector of the parent element — try first for precise lookup.
// anchor: fallback 50-char context string for disambiguation across full page.
function _hlFindRange(text, anchor = '', parentSel = '') {
  if (!text) return null;

  // Primary strategy: narrow search to the element identified by parentSel.
  // This handles common words (e.g. "HTML") that appear hundreds of times on a page.
  if (parentSel) {
    try {
      const roots = document.querySelectorAll(parentSel);
      for (const root of roots) {
        const r = _hlFindRangeIn(root, text);
        if (r) return r;
      }
    } catch (_) { /* stale parent selector: search the whole page below */ }
  }

  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('[data-hl-ui]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  let pos = 0;
  const offsets = nodes.map(n => { const s = pos; pos += n.textContent.length; return s; });
  const flat = nodes.map(n => n.textContent).join('');

  // Determine best occurrence using anchor context (suffix + prefix scoring)
  const anchorTextIdx = anchor ? anchor.indexOf(text) : -1;
  let idx = flat.indexOf(text);
  if (idx < 0) return null;

  if (anchor && anchorTextIdx >= 0) {
    const anchorPrefix = anchor.slice(0, anchorTextIdx);
    const anchorSuffix = anchor.slice(anchorTextIdx + text.length);
    let searchFrom = 0;
    let bestScore  = -1;
    while (true) {
      const cand = flat.indexOf(text, searchFrom);
      if (cand < 0) break;
      // Count matching chars in suffix (from start) — heavily weighted
      const candSfx = flat.slice(cand + text.length, cand + text.length + anchorSuffix.length);
      let sfxMatch = 0;
      while (sfxMatch < candSfx.length && candSfx[sfxMatch] === anchorSuffix[sfxMatch]) sfxMatch++;
      // Count matching chars in prefix (from right end)
      const candPfx = flat.slice(Math.max(0, cand - anchorPrefix.length), cand);
      let pfxMatch = 0;
      for (let k = 1; k <= Math.min(candPfx.length, anchorPrefix.length); k++) {
        if (candPfx[candPfx.length - k] === anchorPrefix[anchorPrefix.length - k]) pfxMatch++;
        else break;
      }
      const score = sfxMatch * 100 + pfxMatch;
      if (score > bestScore) { bestScore = score; idx = cand; }
      searchFrom = cand + 1;
    }
  }

  const end = idx + text.length;
  let startNode, startOff, endNode, endOff;
  for (let i = 0; i < nodes.length; i++) {
    const s = offsets[i], e = s + nodes[i].textContent.length;
    if (!startNode && idx < e) { startNode = nodes[i]; startOff = idx - s; }
    if (end <= e)               { endNode   = nodes[i]; endOff   = end - s; break; }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

// ── Restore one highlight — tries containerSelectors first, falls back to parentSel / anchor ──
const _hlRestoringIds = new Set();

async function _hlRestoreOne(h) {
  const live = _hlLive.get(h.id);
  // Still where it was: take the stored colour, note and on/off, which another
  // tab or the popup may have changed.
  if (live && _hlRangeOk(live)) {
    Object.assign(live, { color: h.color, note: h.note || '', hidden: !!h.disabled });
    return;
  }
  if (_hlRestoringIds.has(h.id)) return;
  _hlRestoringIds.add(h.id);

  try {
    let range = null;

    // Strategy 1: element-finder with stored selectors (fullXpath → id → xpath → css …)
    if (h.containerSelectors) {
      try {
        const el = await findElementWithFallback(h.containerSelectors, 2000);
        if (el) range = _hlFindRangeIn(el, h.text);
      } catch (_) { /* container not found: strategy 2 below */ }
    }

    // Strategy 2: parentSel + anchor (legacy / fallback)
    if (!range) range = _hlFindRange(h.text, h.anchor || '', h.parentSel || '');
    // Not on the page (any more): nothing painted. The page was never changed, so
    // there is nothing to undo either.
    if (!range) { _hlLive.delete(h.id); return; }
    // A highlight disabled from the popup stays saved but is not painted, the
    // state HL_SET_HIDDEN leaves it in.
    _hlLive.set(h.id, { range, color: h.color, note: h.note || '', hidden: !!h.disabled, text: h.text });
  } finally {
    _hlRestoringIds.delete(h.id);
  }
}

// ── Restore all highlights for the current page ──
function _hlRestore() {
  _hlGetPage(async list => {
    // Gone from the store (deleted in the popup, or from another tab): not painted.
    const ids = new Set(list.map(h => h.id));
    for (const id of [..._hlLive.keys()]) if (!ids.has(id)) _hlLive.delete(id);
    await Promise.all(list.map(h => _hlRestoreOne(h)));
    _hlPaint();
    _hlObserve(list.length > 0);

    // Entries saved before srcUrl existed carry no record of their origin page.
    // One that just restored here demonstrably belongs to this page, so stamp
    // it — that keeps it re-groupable when patterns change later.
    const orphans = list.filter(h => !h.srcUrl && _hlLive.has(h.id));
    if (orphans.length) _hlEdit(orphans.map(h => ({ op: 'set', id: h.id, fields: { srcUrl: location.href } })));
  });
}

// ── Scroll to, then light it up for a moment ──
let _hlFlashTimer = null;
function _hlScrollTo(id) {
  const h = _hlLive.get(id);
  if (!h || !_hlRangeOk(h)) return false;
  h.range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (globalThis.CSS?.highlights) {
    const flash = new Highlight(h.range);
    flash.priority = 1;
    CSS.highlights.set('pqa-hl-flash', flash);
    clearTimeout(_hlFlashTimer);
    _hlFlashTimer = setTimeout(() => CSS.highlights.delete('pqa-hl-flash'), _HL_FLASH_MS);
  }
  return true;
}

// ── Bootstrap: loads settings then starts MutationObserver + restore ──
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _hlInit);
} else {
  _hlInit();
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'HL_GET_PAGE') {
    _hlGetAll(all => sendResponse({ url: location.href, data: all }));
    return true;
  }
  if (msg.type === 'HL_REMOVE') {
    _hlRemove(msg.id);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_CLEAR') {
    _hlClear();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_SCROLL_TO') {
    sendResponse({ found: _hlScrollTo(msg.id) });
    return false;
  }
  if (msg.type === 'HL_SET_ENABLED') {
    _hlSetEnabled(msg.enabled);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_PATTERNS_UPDATED') {
    _hlPatterns = msg.patterns || [];
    _hlRefreshForPatterns();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_SET_HIDDEN' || msg.type === 'HL_RESTORE' || msg.type === 'HL_UPDATE_COLOR') {
    const live = _hlLive.get(msg.id);
    if (live) {
      if (msg.type === 'HL_UPDATE_COLOR') live.color = msg.color;
      else live.hidden = msg.type === 'HL_SET_HIDDEN';
      _hlPaint();
    }
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'HL_UPDATE_NOTE') {
    _hlApplyNote(msg.id, msg.note);
    sendResponse({ ok: true }); return false;
  }
});

} // End of injection guard
