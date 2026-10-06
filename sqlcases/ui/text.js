/**
 * ui/text.js — static text in the chosen language, labels that keep their
 * width across languages, and the theme.
 */

import { TECHNIQUES } from '../generate.js';
import { LANGUAGES, getLang, setLang, t, tAlt } from '../i18n.js';
import { el, node } from './dom.js';
import { EXAMPLES } from './examples.js';
import { run } from './run.js';
import { view } from './state.js';

/**
 * The controls the page's geometry hangs off.
 *
 * A Vietnamese label runs up to half again as long as its English one, so a
 * control sized to the text currently on screen changes width at every
 * language switch and drags everything beside it along — a right-anchored row
 * of export buttons slid 48px, the mode pills 49px the other way. Each of
 * these reserves the width of its longest translation instead (the ghost on
 * `[data-i18n-alt]` in sqlcases.css does the measuring), so a switch re-letters
 * the chrome without moving it.
 *
 * Most entries name a `> [data-i18n]` child rather than the control: a ghost is
 * an ::after box, and on a flex container it would become a flex item and take
 * real space. The labels that are already their own span are measured directly.
 *
 * Deliberately not every label on the page: prose that wraps — the subtitle,
 * the hints, the help modal, the triage descriptions — has no fixed width to
 * hold, and reserving one for it would only waste the row it sits in.
 */
const WIDTH_STABLE = [
  '.topbar-title [data-i18n]',        // the subtitle starts where this one ends
  '.topbar-actions button > [data-i18n]',
  '.rtab > [data-i18n]',              // the rail tabs sit in one non-wrapping row
  '.itab > [data-i18n]',
  '.pane-head .pill > [data-i18n]',   // mode pills; the examples select takes what they leave
  '.pane-head button > [data-i18n]',
  '.vb-head button > [data-i18n]',
  '.rail-foot button',
  '.metric-l',                        // every metric after it shifts by the difference
  '.main-head-actions button > [data-i18n]',
  '.cmd-actions button > [data-i18n]',
  '.seg button',
  '.cmd-lbl',
  '.check-row-inline span'
].join(', ');

/**
 * Write a translated label, and on the controls listed in `WIDTH_STABLE` also
 * reserve the width of the same label in the other language.
 */
export function setLabel(target, key, params) {
  target.textContent = t(key, params);
  if (target.matches(WIDTH_STABLE)) target.dataset.i18nAlt = tAlt(key, params);
}

/**
 * A filter pill's label, in a box of its own so the reservation covers the
 * label and nothing else — the count beside it is the same width in every
 * language and must not be measured with it.
 */
export function pillLabel(key) {
  const span = node('span', null, t(key));
  span.dataset.i18nAlt = tAlt(key);
  return span;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.theme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

/**
 * Fill in every element carrying a data-i18n attribute.
 *
 * Called on load and again on each language switch, so the same code path
 * produces the initial render and every later one — there is no separate
 * "translate what is already on screen" pass that could fall out of step.
 */
export function applyStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(n => { setLabel(n, n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(n => { n.placeholder = t(n.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(n => { n.title = t(n.dataset.i18nTitle); });

  // Option elements that carry no key: the decision-table sizes are computed,
  // and the examples dropdown is keyed by position.
  [...el.maxFull.options].forEach(opt => {
    const n = Number(opt.value);
    opt.textContent = t('ui.condRules', { n, rules: Math.pow(2, n) });
  });
  [...el.sample.options].forEach((opt, i) => {
    opt.textContent = i === 0 ? t('ui.examples') : t(EXAMPLES[i - 1].labelKey);
  });

  // Technique checkbox labels.
  TECHNIQUES.forEach(tech => {
    const name = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.parentElement
      ?.querySelector('.tech-name');
    if (name) setLabel(name, tech.labelKey);
  });

  document.querySelectorAll('.help-lang').forEach(n => {
    n.hidden = n.dataset.helpLang !== getLang();
  });
  document.documentElement.lang = getLang();

  // The toggle is the one button certain to be under the cursor when the
  // language changes, so it holds the widest code rather than its own: EN is
  // 5px wider than VI, and the two buttons after it would jump by that much
  // under the pointer that had just been clicked.
  const active = LANGUAGES.find(l => l.code === getLang()) || LANGUAGES[0];
  el.langLabel.textContent = active.short;
  el.langLabel.dataset.i18nAlt = LANGUAGES
    .filter(l => l.code !== active.code)
    .reduce((widest, l) => (l.short.length > widest.length ? l.short : widest), '');

  // #sqlLabel and the rail's first tab carry fixed data-i18n keys for single
  // mode; compare mode overrides both, so redo those overrides after the
  // generic pass above would otherwise put the single-mode labels back.
  setLabel(el.sqlLabel, view.mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
  setLabel(el.railTabSqlLabel, view.mode === 'compare' ? 'ui.railSqlCompare' : 'ui.railSql');
}

/** Switch language, retranslate the chrome, then regenerate so cases follow. */
export function applyLanguage(code) {
  setLang(code);
  applyStaticText();
  run();
}
