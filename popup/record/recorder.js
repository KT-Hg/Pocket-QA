/**
 * record/recorder.js — starting and stopping a recording.
 */

import { scenarioList, startRecord, stopRecord } from '../dom.js';
import { activateCurrentTab } from '../tab-activation.js';
import { showToast } from '../utils.js';
import { previewActions } from './preview.js';

export function initRecorder() {
  /* === RECORD === */

  startRecord.addEventListener('click', async () => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab) { showToast("No active tab found", "error"); return; }

      const tabId = tab.id;
      await activateCurrentTab();

      const scenarioId = scenarioList?.value || null;
      chrome.runtime.sendMessage({ type: "START_RECORD", tabId, scenarioId });
      window.close();
    });
  });
  stopRecord.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "STOP_RECORD" }, (res) => {
      if (chrome.runtime.lastError) {
        showToast("Could not stop recording: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (res?.scenarioId && scenarioList) {
        scenarioList.value = res.scenarioId;
      }
      previewActions();
    });
  });
}
