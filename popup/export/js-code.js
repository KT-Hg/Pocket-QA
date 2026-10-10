/**
 * js-code.js — variable names and values written as JavaScript, for the exports
 * whose code is JavaScript (the bookmarklet, the Playwright test). Each export
 * names the identifiers its own code declares; the rest is shared.
 */

import { CHILD_COND_KEYS } from '../../shared/child-cond.js';

/**
 * Words no variable may be named in JavaScript, and the globals the generated code
 * calls by name: a variable `location` hid the page's own from the bookmarklet's
 * first Navigate, `alert` its error report.
 */
export const JS_RESERVED = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await',
  'document', 'window', 'undefined', 'NaN', 'Infinity',
  'location', 'alert', 'console', 'setTimeout', 'getComputedStyle', 'Promise', 'MutationObserver',
  'XPathResult', 'NodeFilter', 'Event', 'MouseEvent', 'DragEvent', 'DataTransfer', 'URL',
  'JSON', 'Math', 'Date', 'Error', 'RegExp', 'Array', 'String', 'Number', 'Object',
];

/**
 * (name) → a JS identifier for a variable name. Variable names are free-form in
 * the Variables modal: other characters become _, a leading digit too, and a name
 * in `reserved` (JS_RESERVED and what the export declares itself — `sleep` would
 * shadow a helper, `class` is a SyntaxError) or matching `own` (the names the
 * export gives its steps' elements, el2 and the like) gets a `_v` suffix.
 *
 * Every site that emits *or references* a variable name has to go through it.
 * The declaration used to be sanitized while valueToJS() passed `${mã đơn}`
 * through verbatim — a SyntaxError that takes the whole script down.
 */
export function jsIdentifier(reserved, own = null) {
  return (name) => {
    const safe = String(name == null ? 'var' : name)
      .replace(/[^a-zA-Z0-9_$]/g, '_')
      .replace(/^\d/, '_') || 'var';
    return reserved.has(safe) || own?.test(safe) ? safe + '_v' : safe;
  };
}

/**
 * (value) → a JS expression for it: a JSON string, or a template literal whose
 * ${name} references interpolate the declared variables (named by `ident`) at
 * run time.
 */
export function jsValue(ident) {
  return (val) => {
    if (val == null) return "''";
    const s = String(val);
    if (!/\$\{[^}]+\}/.test(s)) return JSON.stringify(s);
    // Each ${name} becomes a substitution, sanitized exactly like the declaration:
    // `${user-name}` otherwise reads as subtraction and `${mã đơn}` is a SyntaxError.
    // The text between keeps its backslashes, backticks and any other `${` (unclosed,
    // or `${}`) as characters, as a run keeps them: left as they were, the template
    // literal did not parse and took the whole script down.
    const body = s.split(/(\$\{[^}]+\})/g).map((part) => {
      const m = part.match(/^\$\{([^}]+)\}$/);
      return m ? '${' + ident(m[1].trim()) + '}' : part.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }).join('');
    return '`' + body + '`';
  };
}

/** The source of a function that makes a Random variable's value. */
export function randomFnJS(type, length) {
  // Must mirror resolveRandomVars() in bg/interpolate.js. The Variables modal offers a
  // "datetime" type that used to fall through to the alphanumeric branch here, so
  // an exported ${stamp} produced random junk instead of the run's timestamp.
  if (type === 'datetime')
    return "() => { const d = new Date(), p = n => String(n).padStart(2, '0'); "
         + "return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '_' "
         + "+ p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); }";
  if (type === 'alpha')
    return `() => Array.from({length:${length}},()=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random()*52)]).join('')`;
  if (type === 'numeric')
    return `() => Array.from({length:${length}},()=>String(Math.floor(Math.random()*10))).join('')`;
  return `() => Array.from({length:${length}},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*62)]).join('')`;
}

/**
 * A Child Condition as a JS object literal, its values through `value` (jsValue)
 * so ${name}s interpolate. A {fallback:A|B|C} spec stays a plain string: the
 * page's _findChild tries its values.
 */
export function jsConditions(cond, value) {
  if (!cond) return '{}';
  const parts = [];
  if (cond.matchMode) parts.push(`matchMode: ${JSON.stringify(cond.matchMode)}`);
  const FALLBACK_RE = /^\{fallback:(.+)\}$/;
  for (const f of CHILD_COND_KEYS) {
    if (cond[f] != null && cond[f] !== '') {
      const v = String(cond[f]);
      parts.push(`${f}: ${FALLBACK_RE.test(v) ? JSON.stringify(v) : value(v)}`);
    }
  }
  return `{${parts.join(', ')}}`;
}
