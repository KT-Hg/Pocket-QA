/**
 * ui/values-panel.js — the Values pane: the value book's parameters and columns,
 * and overriding them.
 */

import { valueSlots } from '../datagen.js';
import { t } from '../i18n.js';
import * as valuebook from '../valuebook.js';
import { el, node } from './dom.js';
import { renderRail } from './layout.js';
import { run } from './run.js';
import { view } from './state.js';
import { VALUES_KEY, storageSet } from './storage.js';

// ---- rendering: the value book ---------------------------------------

/** Set by a reset, so focus lands back on the field the button belonged to. */
let pendingValueFocus = null;

/** How many editable values the current run produced — the rail tab's badge. */
export let valueCount = 0;

/**
 * The one place sample values are managed.
 *
 * Every value in the results is either read from the query or invented by the
 * tool, and this panel lists the invented ones: the bind parameters it cannot
 * see the value of, and the filler used for columns no predicate constrains.
 * Editing one writes it into the value book and re-runs generation, so the
 * cases and the fixture rows that use it change together — which is the whole
 * point of managing them in one place rather than per case.
 */
export function renderValues() {
  // Focus is captured before the rebuild and handed back afterwards: a commit
  // regenerates everything, and losing the caret mid-edit would make the panel
  // unusable for typing more than one value. A reset names its own field,
  // because the button it was clicked on no longer exists afterwards.
  const active = document.activeElement;
  const editing = active && active.classList?.contains('vb-input');
  const focusKey = pendingValueFocus || (editing ? active.dataset.key : null);
  const caret = editing && !pendingValueFocus ? active.selectionStart : null;
  pendingValueFocus = null;

  el.valuesBody.replaceChildren();
  el.valuesSummary.textContent = '';
  valueCount = 0;

  if (!view.current?.model) { renderRail(); return; }

  const book = valueSlots(view.current.model, view.data?.schema, view.data?.fixtures);
  if (!book.total) { renderRail(); return; }

  if (book.params.length) {
    el.valuesBody.append(node('div', 'vb-section', t('vb.params')));
    el.valuesBody.append(node('div', 'vb-group-hint', t('vb.paramsHint')));
    el.valuesBody.append(valueGroup('', null, book.params));
  }
  if (book.tables.length) {
    el.valuesBody.append(node('div', 'vb-section', t('vb.columns')));
    el.valuesBody.append(node('div', 'vb-group-hint', t('vb.columnsHint')));
    book.tables.forEach(tbl => {
      const name = tbl.alias && tbl.alias !== tbl.name ? `${tbl.name} (${tbl.alias})` : tbl.name;
      el.valuesBody.append(valueGroup(name, null, tbl.slots));
    });
  }

  valueCount = book.total;
  el.valuesSummary.textContent = t('vb.sum', { overridden: book.overridden, total: book.total });
  el.resetValues.disabled = book.overridden === 0;
  renderRail();

  if (focusKey) {
    const back = el.valuesBody.querySelector(`.vb-input[data-key="${CSS.escape(focusKey)}"]`);
    if (back) {
      back.focus();
      const at = caret ?? back.value.length;
      try { back.setSelectionRange(at, at); } catch { /* not a text input */ }
    }
  }
}

/** One labelled block of value rows. */
function valueGroup(title, hint, slots) {
  const box = node('div', 'vb-group');
  if (title) box.append(node('div', 'vb-group-name', title));
  if (hint) box.append(node('div', 'vb-group-hint', hint));
  slots.forEach(slot => box.append(valueRow(slot)));
  return box;
}

/** One editable value: what it is called, what it holds, and where it is used. */
function valueRow(slot) {
  const row = node('div', `vb-row${slot.overridden ? ' vb-set' : ''}`);

  const head = node('div', 'vb-row-head');
  head.append(node('span', 'vb-name', slot.label));
  if (slot.type && slot.type !== 'unknown') head.append(node('span', 'vb-type', slot.type));
  let usesText;
  if (!slot.uses) usesText = t('vb.usesNone');
  else if (slot.kind === 'param') usesText = t('vb.usesParam', { n: slot.uses });
  else usesText = t('vb.usesCells', { n: slot.uses });
  head.append(node('span', 'vb-uses', usesText));
  row.append(head);

  const line = node('div', 'vb-line');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = `vb-input${slot.overridden && !slot.valid ? ' vb-invalid' : ''}`;
  input.value = slot.raw;
  input.dataset.key = slot.key;
  input.placeholder = slot.kind === 'param'
    ? t('vb.unbound')
    : `${slot.autoPlain} (${t('vb.auto')})`;
  input.setAttribute('aria-label', slot.label);
  input.addEventListener('change', () => commitValue(slot, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = slot.raw; input.blur(); }
  });
  line.append(input);

  if (slot.overridden) {
    const reset = node('button', 't-btn t-btn-sm vb-reset', '↺');
    reset.title = t('vb.resetOne');
    reset.addEventListener('click', () => {
      pendingValueFocus = slot.key;
      commitValue(slot, '');
    });
    line.append(reset);
  }
  row.append(line);

  if (slot.overridden && !slot.valid) {
    row.append(node('div', 'vb-warn', t('vb.badType', { type: slot.type })));
  }
  return row;
}

/**
 * Store one edited value and rebuild everything that depends on it.
 *
 * Deferred by a tick so the browser can finish moving focus first: `change`
 * fires during the blur, and regenerating before focus lands would drop the
 * user out of the field they tabbed into.
 */
function commitValue(slot, raw) {
  if (!valuebook.setOverride(slot.key, raw)) return;
  setTimeout(() => { saveValues(); run(); }, 0);
}

export function saveValues() {
  storageSet({ [VALUES_KEY]: valuebook.toJSON() });
}
