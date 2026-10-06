/**
 * var-spec.js — the value a variable holds right now, and the specs inside it.
 *
 * A variable is stored either as a plain string (older data, CSV columns) or as a
 * config object that keeps all four kinds at once — `{ activeType, s, r, p, f }`
 * for Static / Random / Pick / Fallback — so switching kind never loses data.
 * The active kind is spelled as a string spec: `{random:alpha:8}`,
 * `{pick:a|b}`, `{fallback:a|b}`, or the static text itself.
 *
 * Two readers differ on purpose for values that are neither a string nor a config
 * (a number, null): the exporters treat them as empty (activeValue), the service
 * worker stringifies them (activeValueText) — kept as two functions rather than
 * merged into one behaviour. The Variables tab keeps its own parser for the
 * Random length, which it stores as text (popup/variables.js).
 *
 * Pure — no chrome.*.
 */

import { listSpec, parseListSpec } from './var-name.js';
import { formatStamp } from './time-format.js';

/** Characters each Random kind draws from. `datetime` uses formatStamp instead. */
export const RANDOM_CHARSETS = Object.freeze({
  alpha:        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeric:      '0123456789',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
});

/** The active kind of a config object as its string spec. */
export function configValue(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r' && cfg.r) return `{random:${cfg.r.type}:${cfg.r.length}}`;
  if (t === 'p') return listSpec('pick', cfg.p);
  if (t === 'f') return listSpec('fallback', cfg.f);
  return cfg.s || '';
}

const isConfig = (v) => v && typeof v === 'object' && 'activeType' in v;

/** Exporters: a string as is, a config as its spec, anything else as ''. */
export function activeValue(v) {
  if (typeof v === 'string') return v;
  if (isConfig(v)) return configValue(v);
  return '';
}

/** Service worker: like activeValue, but anything else is stringified (`String(v || '')`). */
export function activeValueText(v) {
  if (typeof v === 'string') return v;
  if (isConfig(v)) return configValue(v);
  return String(v || '');
}

// {random:<charset>:<length>} makes at most this many characters: in a run
// (resolveRandomVars, bg/interpolate.js) and in exported code alike.
export const MAX_RANDOM_LENGTH = 512;

/**
 * `{ type, length }` when the active value is a Random spec, else null. `length` is
 * a number, capped at MAX_RANDOM_LENGTH as a run caps it.
 */
export function parseRandomSpec(val) {
  const m = activeValue(val).match(/^\{random:(\w+):(\d+)\}$/);
  return m ? { type: m[1], length: Math.min(parseInt(m[2]), MAX_RANDOM_LENGTH) } : null;
}

/** The Pick values when the active value is a Pick spec, else null. */
export function parsePickSpec(val) {
  return parseListSpec('pick', activeValue(val));
}

/** A sample value for a Random spec, as shown in the export dialogs. */
export function previewRandom(type, length) {
  if (type === 'datetime') return formatStamp(new Date());
  const ch = RANDOM_CHARSETS[type] || RANDOM_CHARSETS.alphanumeric;
  return Array.from({ length }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
}
