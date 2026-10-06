/**
 * i18n.js — panel and manager text, English by default.
 *
 * English, like the rest of the extension's interface; Vietnamese is one switch
 * away on the manager page (🌐), and a language someone picks is remembered.
 * SQL keywords and column names are never translated — they are what the person
 * has to match against the database.
 *
 * A missing key degrades to the key itself rather than throwing, and
 * `missingKeys()` lets the selftest assert that neither catalog has holes.
 */

import { VI } from './i18n/vi.js';
import { EN } from './i18n/en.js';

export const LANGUAGES = ['vi', 'en'];

export const CATALOGS = { vi: VI, en: EN };

let lang = 'en';
const missing = new Set();

export function setLang(next) {
  if (CATALOGS[next]) lang = next;
  return lang;
}

export function getLang() {
  return lang;
}

/** `t('panel.changes', { n: 3 })` → "3 thay đổi". */
export function t(key, vars) {
  const text = CATALOGS[lang][key] ?? CATALOGS.en[key];
  if (text === undefined) {
    missing.add(`${lang}:${key}`);
    return key;
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all);
}

export function missingKeys() {
  return [...missing];
}

export function clearMissingKeys() {
  missing.clear();
}
