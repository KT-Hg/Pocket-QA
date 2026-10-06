/**
 * notices.js — toasts for capture results, failed actions, Switch branches and
 * storage warnings sent by the service worker.
 */

import { showToast } from './utils.js';

export function initNotices() {
  /* === Message Listeners === */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SCREENSHOT_RESULT") return;
    const { result } = msg;
    if (result?.cancelled) {
      showToast('Capture cancelled', 'error');
    } else if (result?.error) {
      showToast(result.error, 'error');
    } else if (result?.partial) {
      showToast('Saved partial capture: ' + (result.filename || 'screenshot'), 'success');
    } else if (result?.success) {
      showToast('Saved: ' + (result.filename || 'screenshot'), 'success');
    }
  });
  // Show an inline error toast whenever a playback action fails so the user knows
  // which step and why it failed without having to open DevTools.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "ACTION_FAILED") return;
    const label = msg.action?.type ? `[${msg.action.type}]` : "";
    const reason = msg.reason || "element not found";
    showToast(`Action ${msg.index + 1} failed ${label} — ${reason}`, "error");
  });
  // Notify user when a Switch action branches to another scenario
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SWITCH_SCENARIO") return;
    showToast(`🔀 Switch [${msg.caseLabel}] → "${msg.scenarioName}"`, "success");
  });
  // Surface storage quota warnings/errors as toasts so users know to export old
  // scenarios before the extension starts failing silently on writes.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STORAGE_WARNING") {
      const pct = Math.round((msg.bytes / msg.limit) * 100);
      showToast(`Storage ${pct}% full — consider exporting old scenarios`, "warn");
    } else if (msg.type === "STORAGE_ERROR") {
      showToast(`Storage error: ${msg.msg}`, "error");
    }
  });
}
