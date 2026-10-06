/**
 * record/var-suggestions.js — variable suggestions in the Add Manual Action
 * card: which fields offer them, and the names they offer.
 *
 * Names come from the Data tab (in its order, with the type and current value),
 * from the steps of the scenario before the one being added or edited (Read
 * DOM, Screenshot → Variable), and from the columns of the loaded CSV.
 * popup/ui/var-suggest.js shows the list.
 */

import { getSwitchLayout } from '../../shared/switch-blocks.js';
import { writtenVarNames } from '../../shared/var-name.js';
import { variableType } from '../../shared/var-order.js';
import { varValueDetail } from '../../shared/var-suggest.js';
import { scenarioList } from '../dom.js';
import { ui } from '../ui-state.js';
import { attachVarSuggest } from '../ui/var-suggest.js';

// Fields whose text may hold `${name}` references (substituted when it plays).
const REF_FIELDS = [
  'manualSelector', 'manualValue', 'conditionExpectedValue', 'dragdropTarget',
  'readdomAttrName', 'readdomPattern', 'uploadFolderPath', 'uploadFileNames',
  'condChildValueEquals', 'condChildTextContains', 'condChildIdContains', 'condChildClassContains',
  'dropdownPickIndex', 'dropdownItemSelector',
];
// Fields that take a variable name only.
const NAME_FIELDS = ['switchVar', 'readdomVarName', 'screenshotTovarVarName'];

const _send = (msg) => new Promise((resolve) => {
  chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res); });
});

/** Every name the card can offer now: Data tab, then earlier steps, then CSV columns. */
export async function varEntries() {
  const scenarioId = ui.editing ? ui.editing.scenarioId : (scenarioList?.value || null);
  const [table, preview] = await Promise.all([
    _send({ type: 'GET_VARIABLES' }),
    _send({ type: 'GET_PREVIEW_ACTIONS', scenarioId }),
  ]);
  const out = [];
  for (const [name, v] of Object.entries(table?.variables || {})) {
    out.push({ name, kind: variableType(v), detail: varValueDetail(v) });
  }
  // A new action goes last, so every step comes before it; an edited one has
  // only the steps above it.
  const actions = preview?.actions || [];
  const upto = ui.editing ? Math.min(ui.editing.index, actions.length) : actions.length;
  const layout = getSwitchLayout(actions);
  for (let k = 0; k < upto; k++) {
    const a = actions[k];
    if (!a || a.disabled) continue;
    for (const name of writtenVarNames(a)) {
      out.push({ name, kind: 'w', detail: { text: `set by step ${layout[k]?.displayNo ?? k + 1}` } });
    }
  }
  for (const name of ui.csvParsed?.headers || []) out.push({ name, kind: 'c', detail: { text: 'CSV column' } });
  return out;
}

export function initVarSuggestions() {
  for (const id of REF_FIELDS) attachVarSuggest(document.getElementById(id), { mode: 'ref', getEntries: varEntries });
  for (const id of NAME_FIELDS) attachVarSuggest(document.getElementById(id), { mode: 'name', getEntries: varEntries });
}
