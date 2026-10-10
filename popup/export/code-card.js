/**
 * export/code-card.js — the Export Code card of the Data tab: the scenario its
 * format buttons export, listed by folder, and the buttons, off until there is
 * one. With none picked yet, the card takes the one Manage Scenarios has.
 */

import { ui } from '../ui-state.js';

const NO_SCENARIO_TITLE = 'Select a scenario first';

const formatButtons = () => document.querySelectorAll('.export-code-grid > .export-code-btn');

// The format buttons are on only with a scenario chosen; each says what it makes (data-desc) or why it is off.
function syncButtons() {
  const none = !document.getElementById('exportCodeSelect')?.value;
  for (const btn of formatButtons()) {
    btn.disabled = none;
    btn.title = none ? NO_SCENARIO_TITLE : btn.dataset.desc;
  }
}

export function renderExportCodeSelect() {
  const sel = document.getElementById("exportCodeSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  // The scenarios in no folder first, then a group per folder; by name in each.
  const option = ([id, s]) => Object.assign(document.createElement('option'), { value: id, textContent: s.name });
  const scenarios = Object.entries(ui.scenariosCache).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  sel.append(...scenarios.filter(([, s]) => !ui.foldersCache[s.folderId]).map(option));
  const folders = Object.entries(ui.foldersCache).sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''));
  for (const [folderId, folder] of folders) {
    const inFolder = scenarios.filter(([, s]) => s.folderId === folderId);
    if (!inFolder.length) continue;
    const group = document.createElement('optgroup');
    group.label = folder.name;
    group.append(...inFolder.map(option));
    sel.append(group);
  }
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  syncButtons();
  if (sel.value) return;
  // Nothing picked here yet: the scenario Manage Scenarios has selected.
  chrome.storage.local.get('lastSelectedScenario', (res) => {
    const id = res?.lastSelectedScenario;
    if (sel.value || !id || !ui.scenariosCache[id]) return;
    sel.value = id;
    syncButtons();
  });
}

export function initExportCodeCard() {
  document.getElementById('exportCodeSelect')?.addEventListener('change', syncButtons);
  syncButtons();
}
