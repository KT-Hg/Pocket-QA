/**
 * export/code-card.js — the Export Code card of the Data tab: the scenario its
 * format buttons export.
 */

import { ui } from '../ui-state.js';

export function renderExportCodeSelect() {
  const sel = document.getElementById("exportCodeSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(ui.scenariosCache)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, s]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}
