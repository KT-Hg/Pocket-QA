/**
 * var-suggest.js — the variable names offered while a field is typed in: the
 * `${…}` reference the caret is in, the names that fit it, and the text once
 * one is chosen. popup/ui/var-suggest.js shows the list.
 *
 * Pure — no chrome.*, no DOM.
 */

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
