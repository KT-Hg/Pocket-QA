/**
 * dropdown-pick.js — "Choose item #" of a Dropdown action: what the field may
 * hold and which item it means.
 *
 * The number counts every item as the list shows it, from 1 — a placeholder
 * line such as "-- Select --" included. -1 is the last item, -2 the one before
 * it. `random` is any item that is neither disabled nor empty. A `${var}` is
 * replaced before any of this runs.
 *
 * The action keeps `pick: { by: "index", index, itemSelector? }`.
 *
 * content.js is a classic script and carries its own copy of parsePickIndex and
 * pickItemIndex (the <dropdown-pick-core> block); the bookmarklet export writes
 * one into its output. tests/dropdown-pick.test.mjs runs each copy against this one.
 *
 * Pure — no chrome.*.
 */

/** `{ random: true }`, `{ n }` (a non-zero whole number), or `{ error }`. */
export function parsePickIndex(raw) {
  const s = String(raw ?? '').trim();
  if (/^random$/i.test(s)) return { random: true };
  if (/^-?\d+$/.test(s) && Number(s) !== 0) return { n: Number(s) };
  if (!s) return { error: 'no item number — 1 is the first item, -1 the last, or random' };
  return { error: `"${s}" is not an item number — use 1, 2, … (-1 = last) or random` };
}

/**
 * The 0-based item `raw` stands for among `count` items: `{ index }`, or
 * `{ error }`. `eligible(k)` says whether item k may be chosen at random;
 * `rand` is Math.random unless a test fixes it.
 */
export function pickItemIndex(raw, count, eligible = () => true, rand = Math.random) {
  const p = parsePickIndex(raw);
  if (p.error) return p;
  if (p.random) {
    const pool = [];
    for (let k = 0; k < count; k++) if (eligible(k)) pool.push(k);
    if (!pool.length) return { error: `no item to choose at random (${count} found)` };
    return { index: pool[Math.floor(rand() * pool.length)] };
  }
  const index = p.n > 0 ? p.n - 1 : count + p.n;
  if (index < 0 || index >= count) return { error: `there is no item #${p.n} (${count} found)` };
  return { index };
}

/** Why the form's Item # cannot be saved, or null. A value with `${…}` is checked when it plays. */
export function pickIndexError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'Item # is required — 1 is the first item, -1 the last, or random';
  if (s.includes('${')) return null;
  return parsePickIndex(s).error || null;
}

/** The strings of `action.pick` that may hold `${…}` references. */
export function pickStrings(action) {
  const p = action?.pick;
  if (!p || typeof p !== 'object') return [];
  return [p.index, p.itemSelector].filter((v) => typeof v === 'string');
}
