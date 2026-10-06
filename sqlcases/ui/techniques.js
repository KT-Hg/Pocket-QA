/**
 * ui/techniques.js — the technique toggles in the rail and their counts.
 */

import { DEFAULT_OPTIONS, TECHNIQUES } from '../generate.js';
import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { run } from './run.js';
import { saveState } from './storage.js';
import { setLabel } from './text.js';

// ---- options ---------------------------------------------------------

export function readOptions() {
  const options = {
    maxFullTable: Number(el.maxFull.value) || DEFAULT_OPTIONS.maxFullTable,
    includeJoinConditions: el.joinConds.checked
  };
  TECHNIQUES.forEach(tech => {
    options[tech.key] = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.checked ?? true;
  });
  return options;
}

export function buildTechniqueList() {
  TECHNIQUES.forEach(tech => {
    const li = node('li');
    const label = node('label', 'check-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.tech = tech.key;
    input.addEventListener('change', () => { saveState(); run(); });
    const name = node('span', 'tech-name');
    setLabel(name, tech.labelKey);
    // The name is the technique's own term — "EP + BVA", "MC/DC" — which only
    // says what the cases are for to someone who already knows it. The line
    // under it says that in plain words. It carries data-i18n rather than a
    // second explicit pass in applyStaticText(): the generic sweep there
    // already retranslates anything holding that attribute.
    const desc = node('span', 'tech-desc');
    desc.dataset.i18n = `tech.desc.${tech.key}`;
    setLabel(desc, desc.dataset.i18n);
    const text = node('span', 'tech-text');
    text.append(name, desc);
    label.append(input, text, node('span', 'tech-count', ''));
    li.append(label);
    el.techList.append(li);
  });
}

export function updateTechniqueCounts(stats) {
  TECHNIQUES.forEach(tech => {
    const n = tech.codes.reduce((sum, code) => sum + (stats.byTechnique[code] || 0), 0);
    const span = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.parentElement
      ?.querySelector('.tech-count');
    if (span) span.textContent = n ? t('ui.techCases', { n }) : '';
  });

  const boxes = [...el.techList.querySelectorAll('input[data-tech]')];
  el.techSummary.textContent = t('ui.sumTechniques', {
    on: boxes.filter(b => b.checked).length,
    total: boxes.length,
    n: stats.total
  });
}
