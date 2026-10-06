/**
 * var-suggest.js — the variable names offered while a field is typed in: the
 * `${…}` reference the caret is in, the names that fit it, what each one shows
 * of its value, and the text once one is chosen. popup/ui/var-suggest.js shows
 * the list.
 *
 * Pure — no chrome.*, no DOM.
 */

import { listEntries, parseListSpec } from './var-name.js';
import { variableType } from './var-order.js';
import { activeValueText, parseRandomSpec } from './var-spec.js';

// Pick options / Fallback values a row shows; the rest are counted as "+N".
const LIST_CHIPS = 3;
// How much of a Static value a row shows.
const TEXT_CHARS = 40;
// A Random spec read out. A charset a run does not know draws letters & digits.
const RANDOM_TEXT = { alpha: 'letters', numeric: 'digits', alphanumeric: 'letters & digits' };

/**
 * The `${…}` reference the caret is typing in `text`, or null. `start` is where
 * its `${` begins, `end` where it ends — after its `}` when it is closed
 * already — and `query` the part of the name before the caret. A reference
 * stops at a line break, a `$`, `{` or `}`, so text after one is not taken for
 * part of the name.
 */
export function findVarToken(text, caret) {
  const s = String(text ?? '');
  const before = s.slice(0, caret);
  const open = before.lastIndexOf('${');
  if (open < 0) return null;
  const query = before.slice(open + 2);
  if (/[{}$\n]/.test(query)) return null;
  const closing = s.slice(caret).match(/^[^{}$\n]*\}/);
  return { start: open, end: closing ? caret + closing[0].length : caret, query, closed: !!closing };
}

/** `text` with `${name}` written over `start`–`end`, and where the caret goes after it. */
export function insertVarRef(text, { start, end }, name) {
  const s = String(text ?? '');
  const ref = '${' + name + '}';
  return { text: s.slice(0, start) + ref + s.slice(end), caret: start + ref.length };
}

/** What a name-only field (Switch Variable, Read DOM variable…) holds, as a name to look up. */
export function nameQuery(value) {
  return String(value ?? '').trim().replace(/^\$\{/, '').replace(/\}$/, '').trim();
}

/**
 * The entries (`{ name, … }`) that fit `query`, best first: names that start
 * with it, then names that contain it — case aside — each group in the order
 * given. A name that comes twice is kept once, where it first comes.
 */
export function rankVarNames(query, entries, limit = 50) {
  const q = String(query ?? '').trim().toLowerCase();
  const seen = new Set();
  const starts = [];
  const contains = [];
  for (const e of entries || []) {
    if (!e?.name || seen.has(e.name)) continue;
    seen.add(e.name);
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) starts.push(e);
    else if (n.includes(q)) contains.push(e);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * What a row shows of a Data tab variable's value, read rather than spelled as
 * a spec: `{ chips, more, chain }` for the Pick options (chain false) or the
 * Fallback values in the order they are tried (chain true), Blank as '', `more`
 * the ones left out; `{ chips: ['8 digits'] }` for a Random; `{ text }` for a
 * Static value ('' when empty). `spec` is the value as stored, for a tooltip.
 */
export function varValueDetail(v) {
  const spec = activeValueText(v);
  const t = variableType(v);
  if (t === 'p' || t === 'f') {
    // A config's own list: its spec cannot tell a lone Blank (`{pick:|}`) from two.
    const vals = typeof v === 'object' ? listEntries(v[t]) : parseListSpec(t === 'p' ? 'pick' : 'fallback', spec);
    if (vals?.length) {
      return { chips: vals.slice(0, LIST_CHIPS), more: Math.max(0, vals.length - LIST_CHIPS), chain: t === 'f', spec };
    }
  }
  const r = t === 'r' ? parseRandomSpec(spec) : null;
  if (r) {
    const text = r.type === 'datetime' ? 'date-time' : `${r.length} ${RANDOM_TEXT[r.type] || RANDOM_TEXT.alphanumeric}`;
    return { chips: [text], more: 0, chain: false, spec };
  }
  return { text: spec.length > TEXT_CHARS ? `${spec.slice(0, TEXT_CHARS)}…` : spec, spec };
}
