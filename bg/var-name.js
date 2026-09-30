/**
 * Variable-name helpers shared by the service worker and the popup. Pure — no
 * chrome.* — so both sides and `node --test` can import it.
 */

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
