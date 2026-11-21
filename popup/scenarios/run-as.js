/**
 * scenarios/run-as.js — 📱 Run as under Loop: the device and network the selected
 * scenario plays as (shared/run-as.js), saved on the scenario at once
 * (SET_SCENARIO_RUN_AS); said above the action list while it is not the browser's own.
 */

import { DEVICES, NETWORKS, runAsOf, runAsText } from '../../shared/run-as.js';
import { scenarioList } from '../dom.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';

const _option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });

/** The selected scenario's Run as, on the two selects and the note above the list. */
export function showRunAs() {
  const device = document.getElementById('runAsDevice');
  const network = document.getElementById('runAsNetwork');
  if (!device || !network) return;
  const runAs = runAsOf(ui.scenariosCache?.[scenarioList?.value]?.runAs) || {};
  device.value = runAs.device || '';
  network.value = runAs.network || '';
  const note = document.getElementById('scenarioRunAsNote');
  if (note) {
    const text = runAsText(runAs);
    note.hidden = !text;
    note.textContent = text ? `Plays as ${text} — Run as, under Loop` : '';
  }
}

function _save() {
  const scenarioId = scenarioList?.value;
  const scenario = ui.scenariosCache?.[scenarioId];
  if (!scenario) return;
  const runAs = runAsOf({ device: document.getElementById('runAsDevice').value, network: document.getElementById('runAsNetwork').value });
  chrome.runtime.sendMessage({ type: 'SET_SCENARIO_RUN_AS', scenarioId, runAs }, (res) => {
    if (chrome.runtime.lastError || !res?.success) { showToast('Could not change Run as', 'error'); showRunAs(); return; }
    if (res.runAs) scenario.runAs = res.runAs;
    else delete scenario.runAs;
    showRunAs();
    showToast(res.runAs ? `"${scenario.name}" plays as ${runAsText(res.runAs)}` : `"${scenario.name}" plays as the browser is`, 'success');
  });
}

export function initRunAs() {
  const device = document.getElementById('runAsDevice');
  const network = document.getElementById('runAsNetwork');
  if (!device || !network) return;
  device.replaceChildren(_option('', 'Desktop (this window)'),
    ...Object.entries(DEVICES).map(([k, d]) => _option(k, `${d.name} · ${d.width}×${d.height}`)));
  network.replaceChildren(_option('', 'Normal network'),
    ...Object.entries(NETWORKS).map(([k, n]) => _option(k, n.name)));
  device.addEventListener('change', _save);
  network.addEventListener('change', _save);
  showRunAs();
}
