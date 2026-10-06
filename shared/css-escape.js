/**
 * css-escape.js — CSS.escape for code that has no `CSS` global (the service worker).
 *
 * Follows "serialize an identifier" in CSSOM, so `#${cssEscape(id)}` is the same
 * selector a page builds with `#${CSS.escape(id)}`.
 *
 * Pure — no chrome.*.
 */

const HYPHEN = 0x2d;
const UNDERSCORE = 0x5f;
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isControl = (c) => (c >= 0x01 && c <= 0x1f) || c === 0x7f;
// Kept as they are: non-ASCII, "-", "_", digits and ASCII letters.
const isPlain = (c) => c >= 0x80 || c === HYPHEN || c === UNDERSCORE || isDigit(c)
  || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** The code unit at `i` of `s`, serialized. */
function _escapeAt(s, i) {
  const c = s.charCodeAt(i);
  if (c === 0) return '\uFFFD';
  const leadingDigit = isDigit(c) && (i === 0 || (i === 1 && s.charCodeAt(0) === HYPHEN));
  if (isControl(c) || leadingDigit) return `\\${c.toString(16)} `;
  if (i === 0 && c === HYPHEN && s.length === 1) return '\\-';
  return isPlain(c) ? s[i] : `\\${s[i]}`;
}

/** `CSS.escape(value)`: the identifier `value`, escaped for use in a selector. */
export function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) out += _escapeAt(s, i);
  return out;
}
