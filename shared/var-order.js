// Order of the Variables table. Pure — imported by the service worker
// (bg/storage.js, which builds GET_VARIABLES in this order so exports follow
// it) and by the popup (popup/variables.js).

import { parseListSpec } from './var-name.js';

/** Sort modes of the Variables table; `custom` is the order rows were dragged into. */
export const VARIABLE_SORTS = ['custom', 'createdDesc', 'createdAsc', 'updatedDesc', 'nameAsc', 'nameDesc', 'type'];

export function normalizeVariableSort(mode) {
  return VARIABLE_SORTS.includes(mode) ? mode : 'custom';
}

/** `names` in the saved order, then any name it does not list yet, in the order given. */
export function orderNames(names, order) {
  const known = new Set(names);
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(order) ? order : []) {
    if (known.has(k) && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  for (const k of names) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/**
 * Variable names in the custom order: the saved one, then any name it does
 * not list yet (saved by an older build, or by a writer that sent no order).
 */
export function orderVariableNames(variables, order) {
  return orderNames(Object.keys(variables || {}), order);
}

// S · R · P · F — the order of the type tabs in the Add Variable dialog.
const TYPE_RANK = { s: 0, r: 1, p: 2, f: 3 };

/** Type letter of a stored variable; one saved before configs existed is a bare string spec. */
export function variableType(v) {
  if (v && typeof v === 'object') return v.activeType in TYPE_RANK ? v.activeType : 's';
  if (typeof v !== 'string') return 's';
  if (parseListSpec('fallback', v)) return 'f';
  if (parseListSpec('pick', v))     return 'p';
  if (/^\{random:\w+:\d+\}$/.test(v)) return 'r';
  return 's';
}

// Variables saved before the dates were kept have none: 0, so they count as
// the oldest — which they are.
const _time   = (v, field) => (v && typeof v === 'object' && Number(v[field])) || 0;
const _edited = (v) => _time(v, 'updatedAt') || _time(v, 'createdAt');
const _byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const _COMPARE = {
  createdDesc: (a, b) => _time(b.value, 'createdAt') - _time(a.value, 'createdAt'),
  createdAsc:  (a, b) => _time(a.value, 'createdAt') - _time(b.value, 'createdAt'),
  updatedDesc: (a, b) => _edited(b.value) - _edited(a.value),
  nameAsc:     _byName,
  nameDesc:    (a, b) => _byName(b, a),
  type:        (a, b) => TYPE_RANK[variableType(a.value)] - TYPE_RANK[variableType(b.value)] || _byName(a, b),
};

/**
 * Comparator over { name, value, index } entries, `index` being the place in
 * the custom order. Ties fall back to it, so variables with equal keys (e.g.
 * no dates) stay in the order they were dragged into.
 */
export function variableComparator(mode) {
  const by = _COMPARE[mode];
  return (a, b) => (by ? by(a, b) : 0) || a.index - b.index;
}

/** Names in the order a sort mode shows them, over the custom order. */
export function sortVariableNames(variables, order, mode) {
  const names = orderVariableNames(variables, order);
  if (normalizeVariableSort(mode) === 'custom') return names;
  return names
    .map((name, index) => ({ name, value: variables[name], index }))
    .sort(variableComparator(mode))
    .map(e => e.name);
}
