/**
 * Read DOM "Extract" patterns: the element's text as it reads on the page,
 * with each part to keep written as ${name}.
 *
 *   text "abc154 155"   abc${value}      → value = "154 155"
 *                       abc${value} 155  → value = "154"
 *                       ${value} 155     → value = "abc154"
 *                       abc${a} ${b}     → a = "154", b = "155"
 *
 * The literal text around a ${name} marks where it starts and ends, and the
 * pattern may sit anywhere in the text. A ${name} that opens the pattern takes
 * the text from its start; one that closes it runs to its end. A space matches
 * any run of whitespace (newlines, &nbsp;), values are trimmed, and letters
 * match in either case unless matchCase is set.
 *
 * Pure — no chrome.*: playback (bg/playback.js) extracts with it, the popup
 * checks and previews patterns, and the exports embed patternRegexSource().
 */

const SLOT_RE = /\$\{([^}]*)\}/g;

/** [{ text } | { name }] in pattern order, the pattern trimmed first. */
export function parsePattern(pattern) {
  const src = String(pattern ?? '').trim();
  const parts = [];
  let last = 0;
  for (const m of src.matchAll(SLOT_RE)) {
    if (m.index > last) parts.push({ text: src.slice(last, m.index) });
    parts.push({ name: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ text: src.slice(last) });
  return parts;
}

const _isSlot = (p) => 'name' in p;

/** The variables a pattern writes, in order. */
export function patternVarNames(pattern) {
  const names = [];
  for (const p of parsePattern(pattern)) {
    if (_isSlot(p) && p.name && !names.includes(p.name)) names.push(p.name);
  }
  return names;
}

/** Why a pattern cannot be used, or '' when it can. */
export function patternError(pattern) {
  const parts = parsePattern(pattern);
  const slots = parts.filter(_isSlot);
  if (!slots.length) return 'Write ${name} where the part to keep is, e.g. abc${value} 155';
  if (slots.some(p => !p.name)) return '${} needs a variable name, e.g. ${value}';
  const seen = new Set();
  for (const p of slots) {
    if (seen.has(p.name)) return `\${${p.name}} is used twice`;
    seen.add(p.name);
  }
  for (let i = 1; i < parts.length; i++) {
    if (_isSlot(parts[i]) && _isSlot(parts[i - 1])) {
      return `Put some text between \${${parts[i - 1].name}} and \${${parts[i].name}} — nothing marks where one ends`;
    }
  }
  return '';
}

// Escapes only regex syntax characters, so the source reads the same to
// Python's re (the Selenium export) as to JS.
const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source of a pattern: one group per ${name}, in order. Valid in JS and Python. */
export function patternRegexSource(pattern) {
  const parts = parsePattern(pattern);
  return parts.map((p, i) => {
    if (!_isSlot(p)) return p.text.split(/\s+/).map(_esc).join('\\s+');
    const first = i === 0;
    const last  = i === parts.length - 1;
    // `[\s\S]` rather than `.`: textContent keeps the page's line breaks.
    return (first ? '^' : '') + (last ? '([\\s\\S]*)$' : '([\\s\\S]*?)');
  }).join('');
}

/** { name: value } for each ${name}, or null when the text does not match. */
export function extractWithPattern(text, pattern, { matchCase = false } = {}) {
  const names = parsePattern(pattern).filter(_isSlot).map(p => p.name);
  const m = new RegExp(patternRegexSource(pattern), matchCase ? '' : 'i').exec(String(text ?? ''));
  if (!m) return null;
  const out = {};
  names.forEach((n, k) => { if (n) out[n] = (m[k + 1] ?? '').trim(); });
  return out;
}

/** The error a step fails with when its text does not match, the text cut short. */
export function patternMismatch(text, pattern) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const shown = t.length > 80 ? t.slice(0, 79) + '…' : t;
  return `Read DOM: "${shown}" does not match the Extract pattern ${String(pattern ?? '').trim()}`;
}
