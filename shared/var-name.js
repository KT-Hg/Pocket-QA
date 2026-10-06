/**
 * Variable-name helpers shared by the service worker and the popup. Pure — no
 * chrome.* — so both sides and `node --test` can import it.
 */

import { patternVarNames } from './text-pattern.js';

/**
 * The name a Read DOM / Screenshot → Variable step writes to.
 *
 * The form's placeholder used to read `${varName}`, so plenty of saved actions
 * hold `${abc}` rather than `abc` — the value then landed in `vars["${abc}"]`
 * and every later `${abc}` read an empty string. Normalising at save time and
 * again at run time fixes both new and already-saved actions without a
 * migration.
 *
 * Returns the clean name, or null when nothing usable is left (empty, or a
 * name containing `}` that no `${…}` reference could ever match).
 */
export function normalizeVarName(name) {
  if (name == null) return null;
  let s = String(name).trim();
  if (s.startsWith('${')) s = s.slice(2);
  if (s.endsWith('}')) s = s.slice(0, -1);
  s = s.trim();
  if (!s || s.includes('}')) return null;
  return s;
}

/**
 * The `${…}` reference a Switch reads its value from.
 *
 * The field is labelled as a variable name, so a bare `role` is a natural thing
 * to type — but only `${role}` gets substituted, and a bare name was compared as
 * the literal string "role", so every run fell through to the default case. A
 * bare name is wrapped; anything already holding a `${…}` reference (including
 * `${a}-${b}`) is left as written. Applied at save time and again at run time,
 * like normalizeVarName, so already-saved Switches are fixed without a migration.
 */
export function normalizeVarRef(ref) {
  if (ref == null) return '';
  const s = String(ref).trim();
  if (!s || s.includes('${')) return s;
  const name = normalizeVarName(s);
  return name ? '${' + name + '}' : s;
}

/** Keys of `selectors` / `targetSelectors` that hold a selector string. */
export const SELECTOR_KEYS = ['css', 'xpath', 'fullXpath', 'id', 'name', 'testId', 'dataId', 'text'];

/** Every selector string of an action: `selector`, `selectors.*`, `targetSelector`, `targetSelectors.*`. */
export function selectorStrings(action) {
  const out = [];
  if (!action) return out;
  for (const f of ['selector', 'targetSelector']) if (typeof action[f] === 'string') out.push(action[f]);
  for (const f of ['selectors', 'targetSelectors']) {
    const o = action[f];
    if (!o || typeof o !== 'object') continue;
    for (const k of SELECTOR_KEYS) if (typeof o[k] === 'string') out.push(o[k]);
  }
  return out;
}

/* ── Pick / Fallback lists ─────────────────────────────────────────────────
 * A variable's config keeps its Pick / Fallback values as an array. `null` is
 * an explicit Blank entry (the empty string); '' is a row nobody filled in and
 * is dropped. In the `{pick:a||c}` / `{fallback:a||c}` spec a Blank is an
 * empty segment — specs saved before Blank existed never have one, because
 * their values were filtered on save.
 */

/** The list entries that count, with Blank as ''. */
export function listEntries(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(v => v === null || (typeof v === 'string' && v.trim() !== ''))
    .map(v => (v === null ? '' : v));
}

/** `{pick:…}` / `{fallback:…}` for a config list, or '' when it has no entries. */
export function listSpec(kind, arr) {
  const vals = listEntries(arr);
  // A lone Blank would give `{pick:}`, which no parser matches; `{pick:|}` reads the same.
  return vals.length ? `{${kind}:${vals.join('|') || '|'}}` : '';
}

/**
 * Variables a step writes: a Read DOM / Screenshot → Variable target, and each
 * ${name} of a Read DOM Extract pattern (shared/text-pattern.js).
 */
export function writtenVarNames(action) {
  const out = [];
  if (action?.type !== 'readdom' && action?.type !== 'screenshot_tovar') return out;
  const vn = normalizeVarName(action.varName);
  if (vn) out.push(vn);
  if (action.type === 'readdom' && action.pattern) {
    for (const n of patternVarNames(action.pattern)) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Values of a `{pick:…}` / `{fallback:…}` spec (Blank as ''), or null for anything else. */
export function parseListSpec(kind, str) {
  if (typeof str !== 'string') return null;
  const m = str.match(kind === 'pick' ? /^\{pick:(.+)\}$/ : /^\{fallback:(.+)\}$/);
  return m ? m[1].split('|').map(s => s.trim()) : null;
}
