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
 * select-one / select-multiple). Every wrapper's textContent holds the text too,
 * so a text match goes down to the innermost element that still matches.
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
    if (c.textContains  != null && c.textContains  !== '') { const n = norm(c.textContains);  checks.push(el => norm(el.textContent).includes(n)); }
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
