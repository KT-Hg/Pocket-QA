/**
 * record/recorder.js — starting and stopping a recording.
 */

import { scenarioList, startRecord, stopRecord } from '../dom.js';
import { activatedTabs } from '../tab-activation.js';
import { CONTENT_SCRIPT_FILES, showToast } from '../utils.js';
import { previewActions } from './preview.js';

export function initRecorder() {
  /* === RECORD === */

  startRecord.addEventListener('click', async () => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab) { showToast("No active tab found", "error"); return; }

      const tabId = tab.id;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: CONTENT_SCRIPT_FILES
        });
      } catch (_) {
        // Content script already injected — expected
      }

      if (!activatedTabs.has(tabId)) {
        activatedTabs.add(tabId);
        chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
      }

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
