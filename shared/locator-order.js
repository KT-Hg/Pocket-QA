/**
 * locator-order.js — the ways playback finds an element, in the order it tries
 * them, for the code exports to try the same ones in the same order.
 *
 * A copy of _locators in content.js (a classic script, which cannot import it):
 * fullXpath first (absolute position, most precise for a recorded action), then
 * id, xpath, css, testId, dataId, name, text; the type chosen in the form
 * (action.selectorType) before all of them. A CSS selector that finds nothing in
 * the page is also looked for inside open shadow roots, by content.js and by the
 * exports alike (popup/export/page-js.js QUERY_DEEP_JS).
 */

const ORDER = ['fullXpath', 'id', 'xpath', 'css', 'testId', 'dataId', 'name', 'text'];

/**
 * The locators of an element: [{ type, value }], plus `tag` for a Text locator
 * picked on the page (selectors.textTag). `selectors` is the action's map; a bare
 * `selector` string is a CSS one, used when the map gives nothing. `prefer` is
 * the selector type chosen in the form.
 */
export function locatorsOf(selectors, selector, prefer) {
  const map = selectors && typeof selectors === 'object' ? selectors : {};
  const out = ORDER.filter((type) => typeof map[type] === 'string' && map[type])
    .map((type) => (type === 'text' && map.textTag
      ? { type, value: map[type], tag: map.textTag }
      : { type, value: map[type] }));
  if (!out.length && typeof selector === 'string' && selector) out.push({ type: 'css', value: selector });
  const chosen = prefer ? out.findIndex((l) => l.type === prefer) : -1;
  if (chosen > 0) out.unshift(...out.splice(chosen, 1));
  return out;
}
