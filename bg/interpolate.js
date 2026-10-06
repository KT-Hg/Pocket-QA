/**
 * interpolate.js — variables applied to an action before it is played: random and
 * pick values resolved once per run, ${name} substituted into every field that
 * takes one, script code escaped.
 */

import { formatStamp } from '../shared/time-format.js';
import { SELECTOR_KEYS, normalizeVarRef, parseListSpec } from '../shared/var-name.js';
import { MAX_RANDOM_LENGTH, RANDOM_CHARSETS, activeValueText } from '../shared/var-spec.js';

/* ── Variable Interpolation ─────────────────────────────────────────────────── */

export function resolveRandomVars(vars) {
  const result = {};
  for (const [k, rawV] of Object.entries(vars)) {
    const v = activeValueText(rawV);
    const m = typeof v === 'string' && v.match(/^\{random:(\w+):(\d+)\}$/);
    if (m) {
      if (m[1] === 'datetime') {
        result[k] = formatStamp(new Date());
      } else {
        const charset = RANDOM_CHARSETS[m[1]] || RANDOM_CHARSETS.alphanumeric;
        const len = Math.min(parseInt(m[2], 10), MAX_RANDOM_LENGTH);
        result[k] = Array.from({ length: len }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
      }
    } else {
      // {pick:val1|val2|val3} — randomly pick one value from the pipe-separated list.
      // In CSV runs, CSV column values override baseVars before resolveRandomVars is called,
      // so this branch only fires when the CSV file has no column matching this variable name.
      // A Blank entry is an empty segment and can be picked like any other value.
      const vals = parseListSpec('pick', v);
      if (vals) {
        result[k] = vals.length ? vals[Math.floor(Math.random() * vals.length)] : '';
      } else {
        result[k] = v;
      }
    }
  }
  return result;
}

export function applyVars(str, vars) {
  if (typeof str !== 'string' || !vars) return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

/**
 * Interpolate variables into a `script` action's source.
 *
 * Script code is handed to Runtime.evaluate (CDP) or `new Function` (content-script
 * fallback), so a raw substitution lets any quote in a variable value terminate the
 * surrounding string literal — at best a SyntaxError the CDP path swallows silently,
 * at worst arbitrary code from a CSV cell running with the extension's privileges.
 * Escaping here keeps the value a value. Backslash goes first so the escapes this
 * function adds are not themselves re-escaped.
 *
 * Values that are not inside a string literal (numbers, bare identifiers) contain
 * none of these characters, so they pass through unchanged.
 */
function _applyVarsToCode(code, vars) {
  if (typeof code !== 'string' || !vars) return code;
  return code.replace(/\$\{([^}]+)\}/g, (match, k) => {
    if (!(k in vars)) return match;
    return String(vars[k])
      .replace(/\\/g,  '\\\\')
      .replace(/"/g,   '\\"')
      .replace(/'/g,   "\\'")
      .replace(/`/g,   '\\`')
      .replace(/\$\{/g, '\\${')
      .replace(/\n/g,  '\\n')
      .replace(/\r/g,  '\\r');
  });
}

/** Copy of a `selectors` / `targetSelectors` map with variables applied to every string. */
function _applyVarsToSelectors(sels, vars) {
  if (!sels || typeof sels !== 'object') return sels;
  const out = { ...sels };
  for (const k of SELECTOR_KEYS) {
    if (typeof out[k] === 'string') out[k] = applyVars(out[k], vars);
  }
  return out;
}

export function interpolateAction(action, vars) {
  if (!vars || !Object.keys(vars).length) {
    // Still normalised, so a bare Switch name behaves exactly like `${name}` would.
    return action.switchVar ? { ...action, switchVar: normalizeVarRef(action.switchVar) } : action;
  }
  const a = { ...action };
  if (a.selector)      a.selector      = applyVars(a.selector, vars);
  // content.js prefers `selectors` over `selector`, and the form always sets it,
  // so substituting only `selector` left `#row-${id}` unresolved in practice.
  if (a.selectors)       a.selectors       = _applyVarsToSelectors(a.selectors, vars);
  if (a.targetSelector)  a.targetSelector  = applyVars(a.targetSelector, vars);
  if (a.targetSelectors) a.targetSelectors = _applyVarsToSelectors(a.targetSelectors, vars);
  if (a.attrName)        a.attrName        = applyVars(a.attrName, vars);
  if (a.value)         a.value         = applyVars(a.value, vars);
  if (a.url)           a.url           = applyVars(a.url, vars);
  // Code is escaped, not plain-substituted — see _applyVarsToCode.
  if (a.code)          a.code          = _applyVarsToCode(a.code, vars);
  if (a.expectedValue) a.expectedValue = applyVars(a.expectedValue, vars);
  // A bare `role` is read as `${role}` — see normalizeVarRef.
  if (a.switchVar)     a.switchVar     = applyVars(normalizeVarRef(a.switchVar), vars);
  if (a.fileName)               a.fileName   = applyVars(a.fileName,   vars);
  if (a.folderPath)             a.folderPath = applyVars(a.folderPath, vars);
  if (Array.isArray(a.fileNames)) a.fileNames = a.fileNames.map(n => applyVars(n, vars));
  if (a.conditions && typeof a.conditions === 'object') {
    a.conditions = { ...a.conditions };
    if (a.conditions.valueEquals   != null) a.conditions.valueEquals   = applyVars(String(a.conditions.valueEquals),   vars);
    if (a.conditions.textContains  != null) a.conditions.textContains  = applyVars(String(a.conditions.textContains),  vars);
    if (a.conditions.idContains    != null) a.conditions.idContains    = applyVars(String(a.conditions.idContains),    vars);
    if (a.conditions.classContains != null) a.conditions.classContains = applyVars(String(a.conditions.classContains), vars);
    if (a.conditions.typeEquals    != null) a.conditions.typeEquals    = applyVars(String(a.conditions.typeEquals),    vars);
  }
  // Dropdown "Choose item #": the item number and the items' selector.
  if (a.pick && typeof a.pick === 'object') {
    a.pick = { ...a.pick };
    if (typeof a.pick.index === 'string')        a.pick.index        = applyVars(a.pick.index, vars);
    if (typeof a.pick.itemSelector === 'string') a.pick.itemSelector = applyVars(a.pick.itemSelector, vars);
  }
  return a;
}
