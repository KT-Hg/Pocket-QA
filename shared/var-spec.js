/**
 * var-spec.js — the value a variable holds right now, and the specs inside it.
 *
 * A variable is stored either as a plain string (older data, CSV columns) or as a
 * config object that keeps all four kinds at once — `{ activeType, s, r, p, f }`
 * for Static / Random / Pick / Fallback — so switching kind never loses data.
 * The active kind is spelled as a string spec: `{random:alpha:8}` (or a test-data
 * kind, shared/test-data.js: `{random:date:+1:dd/MM/yyyy}`),
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
import { DATA_KINDS, DATE_FORMATS, dataSpecString, dataValue, parseDataSpec } from './test-data.js';

/** Characters each Random kind draws from. `datetime` uses formatStamp instead. */
export const RANDOM_CHARSETS = Object.freeze({
  alpha:        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeric:      '0123456789',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
});

/** The active kind of a config object as its string spec. */
export function configValue(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r' && cfg.r) return randomSpecString(cfg.r);
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
  const s = activeValue(val);
  const m = s.match(/^\{random:(\w+):(\d+)\}$/);
  if (m && !DATA_KINDS.includes(m[1])) return { type: m[1], length: Math.min(parseInt(m[2]), MAX_RANDOM_LENGTH) };
  // A test-data kind: {random:<kind>[:<arg>…]} (shared/test-data.js).
  const d = s.match(/^\{random:([a-z]+)((?::[^:{}]*)*)\}$/);
  return d && DATA_KINDS.includes(d[1]) ? parseDataSpec(d[1], d[2] ? d[2].slice(1).split(':') : []) : null;
}

/** Whether `val` is a Random spec of any kind. */
export const isRandomSpec = (val) => parseRandomSpec(val) !== null;

/**
 * A Random config (`cfg.r`, the Variables tab's fields, kept as typed) as its spec
 * string. A test-data kind's fields: domain, lang, min, max, days, format.
 */
export function randomSpecString(r) {
  if (!DATA_KINDS.includes(r?.type)) return `{random:${r?.type}:${r?.length}}`;
  const int = (v, d) => (/^[+-]?\d+$/.test(String(v ?? '').trim()) ? Number(v) : d);
  return dataSpecString({
    type: r.type,
    domain: String(r.domain || 'example.test').trim(),
    lang: r.lang === 'en' ? 'en' : 'vi',
    min: int(r.min, 1), max: int(r.max, 100),
    days: int(r.days, 1), format: DATE_FORMATS.includes(r.format) ? r.format : DATE_FORMATS[0],
  });
}

/**
 * A value of a Random spec (parseRandomSpec), as a run draws it: `now` the clock,
 * `rnd` the random numbers in [0, 1) — a test passes its own.
 */
export function randomValue(spec, { now = new Date(), rnd = Math.random } = {}) {
  if (!spec) return '';
  if (DATA_KINDS.includes(spec.type)) return dataValue(spec, { now, rnd });
  if (spec.type === 'datetime') return formatStamp(now);
  const ch = RANDOM_CHARSETS[spec.type] || RANDOM_CHARSETS.alphanumeric;
  const len = Math.min(Number(spec.length) || 0, MAX_RANDOM_LENGTH);
  return Array.from({ length: len }, () => ch[Math.floor(rnd() * ch.length)]).join('');
}

/** The Pick values when the active value is a Pick spec, else null. */
export function parsePickSpec(val) {
  return parseListSpec('pick', activeValue(val));
}

/** A sample value for a Random spec, as shown in the export dialogs. */
export function previewRandom(type, length) {
  return randomValue({ type, length });
}
