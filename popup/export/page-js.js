/**
 * page-js.js — the code an exported script runs inside the page under test,
 * written once for every export. Each constant is the source of one function
 * expression, unindented: the bookmarklet declares it as a const, the Selenium
 * script runs it through driver.execute_script().
 *
 * Each mirrors what playback does in content.js, which cannot import it (a
 * classic script); e2e export-run checks that both exports land where playback does.
 */

import { CHILD_COND_KEYS } from '../../shared/child-cond.js';

/**
 * (parent, cond) → the first element under `parent` matching the Child Condition
 * `cond`, or null; findElementByCondition in content.js.
 *
 * A field may hold a {fallback:A|B|C} spec — a Fallback variable only becomes one
 * at run time — and each value is then tried in order. An empty value is a Blank:
 * it matches a child whose field is empty. "select" is any <select> (its type is
 * select-one / select-multiple). A text matches the element's own text nodes
 * joined, or its whole textContent (_findElementSingle). Every wrapper's
 * textContent holds the text too, so a text match goes down to the innermost
 * element that still matches.
 */
export const FIND_CHILD_JS = String.raw`(parent, cond) => {
  const _fbRe = /^\{fallback:(.+)\}$/;
  const _fbField = ${JSON.stringify(CHILD_COND_KEYS).replace(/"/g, "'")}.find(f => cond[f] != null && _fbRe.test(String(cond[f])));
  const _fbVals  = _fbField ? String(cond[_fbField]).match(_fbRe)[1].split('|').map(s=>s.trim()) : null;
  const _tryFind = (c, blankField) => {
    const mode = c.matchMode || 'any';
    const norm = s => (s == null ? '' : String(s).trim().toLowerCase());
    const checks = [];
    if (c.valueEquals   != null && c.valueEquals   !== '') checks.push(el => el.value !== undefined && String(el.value) === String(c.valueEquals));
    if (c.textContains  != null && c.textContains  !== '') {
      // The element's own text (its text nodes, not its children's) or all of it, as playback matches.
      const n = norm(c.textContains);
      const own = el => [...el.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join('');
      checks.push(el => norm(own(el)).includes(n) || norm(el.textContent).includes(n));
    }
    if (c.idContains    != null && c.idContains    !== '') { const n = norm(c.idContains);    checks.push(el => norm(el.id).includes(n)); }
    if (c.classContains != null && c.classContains !== '') { const n = norm(c.classContains); checks.push(el => norm(el.className).includes(n)); }
    if (c.typeEquals    != null && c.typeEquals    !== '') checks.push(el => (c.typeEquals === 'select' ? el.tagName === 'SELECT' : el.type === c.typeEquals));
    if (blankField) checks.push(el => {
      if (blankField === 'valueEquals')   return el.value !== undefined && String(el.value) === '';
      if (blankField === 'textContains')  return norm(el.textContent) === '';
      if (blankField === 'idContains')    return !el.id;
      if (blankField === 'classContains') return norm(el.getAttribute('class')) === '';
      return !el.getAttribute('type');
    });
    if (!checks.length) return null;
    const test = mode === 'all' ? el => checks.every(fn => fn(el)) : el => checks.some(fn => fn(el));
    const first = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (test(node)) return node; }
      return null;
    };
    let hit = first(parent);
    if (hit && c.textContains != null && c.textContains !== '') { for (let inner = first(hit); inner; inner = first(hit)) hit = inner; }
    return hit;
  };
  if (_fbField && _fbVals) {
    for (const _fv of _fbVals) { const el = _tryFind({...cond, [_fbField]: _fv}, _fv === '' ? _fbField : null); if (el) return el; }
    return null;
  }
  return _tryFind(cond);
}`;

/**
 * () → a hidden <input type="file" multiple> added to the page: the bridge an
 * upload to a drop zone fills with its files, as setFileDropZoneViaCdp of
 * bg/cdp/upload.js adds it.
 */
export const DROP_BRIDGE_JS = String.raw`() => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  inp.setAttribute('data-cdp-dz-bridge', '1');
  document.documentElement.appendChild(inp);
  return inp;
}`;

/**
 * (zone, bridge) → the bridge's files dropped on `zone` — dragenter, dragover and
 * drop with one DataTransfer holding them, as setFileDropZoneViaCdp fires them —
 * and the bridge removed.
 */
export const DROP_FILES_JS = String.raw`(zone, bridge) => {
  const dt = new DataTransfer();
  Array.from(bridge.files).forEach((f) => dt.items.add(f));
  ['dragenter', 'dragover', 'drop'].forEach((t) => zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })));
  bridge.remove();
}`;

/**
 * (selector) → the first element a CSS selector finds in the page or in an open
 * shadow root inside it (a web component's), or null — querySelectorDeep in
 * content.js, the walk playback makes with an action's CSS selector when the page
 * itself has no match. A selector the page cannot parse finds nothing.
 */
export const QUERY_DEEP_JS = String.raw`(selector) => {
  const deep = (root) => {
    const el = root.querySelector(selector);
    if (el) return el;
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        const found = deep(host.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  try { return deep(document); } catch (e) { return null; }
}`;

/**
 * (text, tag) → the element a Text locator finds; the text strategy of _locators
 * and _innermostWithText in content.js. With `tag` (picked on the page): the
 * first such element whose trimmed text is `text`. Without (typed in the form):
 * the first element whose text, trimmed, is exactly `text`, then the deepest one
 * inside it that still is — the <span> in <button><span>OK</span></button>, and
 * never "OK Cancel".
 */
export const FIND_TEXT_JS = String.raw`(text, tag) => {
  if (tag) return Array.from(document.querySelectorAll(tag)).find(el => el.textContent.trim() === text) || null;
  const want = String(text).trim();
  const holds = (el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.textContent.trim() === want;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => (el.textContent.includes(want) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let hit = null;
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (hit && !hit.contains(el)) break;
    if (holds(el)) hit = el;
  }
  return hit;
}`;

// Each action function starts as playback's PLAY_ACTION does for every element
// action: scroll the element to the middle of the view, then focus it.

/**
 * (el) → a Click as playback makes it: mousedown and mouseup at its middle, then
 * click(). Widgets (jQuery UI, custom menus) act on mousedown; click() alone
 * never fires it.
 */
export const CLICK_JS = String.raw`(el) => {
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus();
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}`;

/** (el) → a Hover as playback makes it: mouseover, mouseenter, mousemove at its middle. */
export const HOVER_JS = String.raw`(el) => {
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus();
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
}`;

/**
 * (el, value) → an Input as playback makes it. A contenteditable gets the text
 * through execCommand, which rich-text editors observe. A <select> gets the
 * option with that value, else with that text; with neither it throws and keeps
 * its choice (setting .value to a missing option emptied it, and passed). Any
 * other field gets the value through its native setter, which React and Vue
 * track, then input, change and blur.
 */
export const SET_INPUT_JS = String.raw`(el, value) => {
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus();
  const v = value ?? '';
  if (el.isContentEditable) {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (el.tagName === 'SELECT') {
    const want = String(v);
    const options = Array.from(el.options);
    const option = options.find(o => o.value === want) || options.find(o => o.text === want);
    if (!option) throw new Error('The dropdown has no option "' + want + '"');
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return;
  }
  let setter = null;
  for (let p = Object.getPrototypeOf(el); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'value');
    if (d?.set) { setter = d.set; break; }
  }
  if (setter) setter.call(el, v); else el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}`;

/**
 * (src, dst) → a Drag & drop as playback makes it: mousedown, then the HTML5
 * drag events sharing one DataTransfer (dragstart, dragenter, dragover, drop,
 * dragend), then mouseup. Mouse events alone move nothing on an HTML5 list.
 */
export const DRAG_DROP_JS = String.raw`(src, dst) => {
  src.scrollIntoView({ behavior: 'auto', block: 'center' });
  src.focus();
  const s = src.getBoundingClientRect(), d = dst.getBoundingClientRect();
  const sx = s.left + s.width / 2, sy = s.top + s.height / 2, dx = d.left + d.width / 2, dy = d.top + d.height / 2;
  const dt = new DataTransfer();
  const fireM = (el, t, x, y, extra = {}) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
  const fireD = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  fireM(src, 'mousedown', sx, sy, { button: 0 });
  fireD(src, 'dragstart', sx, sy);
  fireD(dst, 'dragenter', dx, dy);
  fireD(dst, 'dragover', dx, dy);
  fireD(dst, 'drop', dx, dy);
  fireD(src, 'dragend', dx, dy);
  fireM(src, 'mouseup', dx, dy);
}`;

/** The Condition types CHECK_COND_JS answers; an export stops on any other. */
export const CONDITION_TYPES = new Set([
  'elementExists', 'elementNotExists', 'elementVisible', 'elementHidden', 'textContains', 'textEquals',
  'valueEquals', 'valueContains', 'urlContains', 'urlEquals', 'hasClass', 'hasAttribute',
]);

/**
 * (type, el, expected) → whether a Condition holds; CHECK_CONDITION in content.js.
 * `el` is the element found now (null when there is none, and for the URL types).
 * Visible means displayed, not visibility:hidden, not opacity 0 and with a size —
 * not offsetParent, which a position:fixed element lacks. Text is textContent,
 * hidden parts included. hasAttribute "name=value" compares the value.
 */
export const CHECK_COND_JS = String.raw`(type, el, expected) => {
  const shown = (e) => {
    const style = getComputedStyle(e), rect = e.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  };
  switch (type) {
    case 'elementExists':    return !!el;
    case 'elementNotExists': return !el;
    case 'elementVisible':   return !!el && shown(el);
    case 'elementHidden':    return !el || !shown(el);
    case 'textContains':     return !!el && el.textContent.includes(expected);
    case 'textEquals':       return !!el && el.textContent.trim() === (expected || '').trim();
    case 'valueEquals':      return !!el && 'value' in el && el.value === expected;
    case 'valueContains':    return !!el && 'value' in el && el.value.includes(expected);
    case 'urlContains':      return window.location.href.includes(expected);
    case 'urlEquals':        return window.location.href === expected;
    case 'hasClass':         return !!el && el.classList.contains(expected);
    case 'hasAttribute': {
      if (!el) return false;
      const eq = (expected || '').indexOf('=');
      if (eq < 0) return el.hasAttribute(expected);
      const name = expected.slice(0, eq);
      return el.hasAttribute(name) && el.getAttribute(name) === expected.slice(eq + 1);
    }
    default: throw new Error('Unknown condition type "' + type + '"');
  }
}`;

/**
 * (el, from, attr) → what Read DOM reads from `el` for its "Read from" choice
 * (text, visible, value, attr); readElementValue in content.js.
 */
export const READ_VAL_JS = String.raw`(el, from, attr) => {
  const tag = String(el.tagName || '').toUpperCase(), fld = tag === 'INPUT' || tag === 'TEXTAREA';
  const txt = () => (typeof el.innerText === 'string' ? el.innerText : (el.textContent || ''));
  const ws = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (from === 'attr') return el.getAttribute(attr) ?? '';
  if (from === 'value') {
    if (tag === 'SELECT' && el.multiple) return Array.from(el.selectedOptions).map(o => o.value).join(', ');
    if (fld || tag === 'SELECT') return el.value ?? '';
    if (el.isContentEditable) return txt().trim();
    if (typeof el.value === 'string' && el.value !== '') return el.value;
    if (typeof el.value === 'number' && tag !== 'LI') return String(el.value);
    return txt().trim();
  }
  if (from === 'visible') {
    if (tag === 'SELECT') return Array.from(el.selectedOptions).map(o => ws(o.text)).join(', ');
    if (fld) return el.value ?? '';
    return ws(txt());
  }
  return (el.textContent || '').trim();
}`;

/**
 * A Dropdown's "Choose item #", as statements declaring _pickIdx and _pickItem
 * (el, raw, itemSel, timeout); they need a `sleep` in scope. _pickIdx is
 * pickItemIndex of shared/dropdown-pick.js (tests/dropdown-pick.test.mjs
 * compares the two). A <select> gets its option set; anything else is clicked
 * open and the item clicked once the list shows it.
 */
export const PICK_ITEM_JS = String.raw`const _pickIdx = (raw, count, ok) => {
  const s = String(raw == null ? '' : raw).trim();
  if (/^random$/i.test(s)) {
    const pool = [];
    for (let k = 0; k < count; k++) if (ok(k)) pool.push(k);
    if (!pool.length) throw new Error('Dropdown: no item to choose at random (' + count + ' found)');
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (!/^-?\d+$/.test(s) || Number(s) === 0) throw new Error('Dropdown: "' + s + '" is not an item number');
  const n = Number(s), k = n > 0 ? n - 1 : count + n;
  if (k < 0 || k >= count) throw new Error('Dropdown: there is no item #' + n + ' (' + count + ' found)');
  return k;
};
const _pickItem = async (el, raw, itemSel, timeout) => {
  if (el.tagName === 'SELECT') {
    const o = Array.from(el.options);
    const k = _pickIdx(raw, o.length, i => !o[i].disabled && o[i].value !== '');
    if (o[k].disabled) throw new Error('Dropdown: item #' + (k + 1) + ' is disabled');
    el.selectedIndex = k;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  el.click();
  const shown = e => e.getClientRects().length > 0 && (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true }) : getComputedStyle(e).visibility !== 'hidden');
  const off = e => e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled');
  const end = Date.now() + timeout;
  for (;;) {
    const items = Array.from(document.querySelectorAll(itemSel || '[role="option"]')).filter(shown);
    let k;
    try { k = _pickIdx(raw, items.length, i => !off(items[i]) && items[i].textContent.trim() !== ''); }
    catch (e) { if (Date.now() >= end) throw e; await sleep(100); continue; }
    if (off(items[k])) throw new Error('Dropdown: item #' + (k + 1) + ' is disabled');
    items[k].click();
    return;
  }
};`;

/**
 * PICK_ITEM_JS for a driver's async script call (Selenium's execute_async_script,
 * Robot's Execute Async Javascript): arguments el, raw, itemSel, timeout, then the
 * callback, given null or the error's message.
 */
export const PICK_ITEM_ASYNC_JS = `const done = arguments[arguments.length - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${PICK_ITEM_JS}
_pickItem(arguments[0], arguments[1], arguments[2], arguments[3]).then(() => done(null), (e) => done(String(e && e.message || e)));`;
