/**
 * notices.js — toasts for capture results, failed actions, Switch branches and
 * storage warnings sent by the service worker.
 */

import { showToast } from './utils.js';
import { copyRecentToClipboard } from './capture/recent.js';

/** What became of the clipboard copy every capture makes, as the end of the toast. */
function copyNote(r) {
  if (r?.copied) return ' · copied to clipboard';
  if (r?.copyError) return ` — not copied: ${r.copyError}. 📋 Copy it under Recent captures`;
  return '';
}

export function initNotices() {
  /* === Message Listeners === */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SCREENSHOT_RESULT") return;
    const { result } = msg;
    // A dismissed Save As is the user's own choice, not a failure.
    if (result?.cancelled) {
      showToast('Capture cancelled', 'info');
    } else if (result?.error) {
      showToast(result.error, 'error');
    } else if (result?.cropping) {
      // Nothing is saved yet: the editor saves, and says so itself.
      showToast('Opening editor…', 'info');
    } else if (result?.success) {
      const saved = (result.partial ? 'Saved partial capture: ' : 'Saved: ') + (result.filename || 'screenshot');
      // The popup is open, so it is the focused page that can write the clipboard
      // (bg/screenshot/after-capture.js): it copies the capture from Recent.
      if (result.copyBy === 'popup' && result.recentId != null) {
        copyRecentToClipboard(result.recentId).then(
          () => showToast(`${saved} · copied to clipboard`, 'success'),
          (e) => showToast(`${saved} — not copied: ${e.message}`, 'warn'),
        );
      } else {
        showToast(saved + copyNote(result), result.copyError ? 'warn' : 'success');
      }
    }
  });
  // Show an inline error toast whenever a playback action fails so the user knows
  // which step and why it failed without having to open DevTools.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "ACTION_FAILED") return;
    const label = msg.action?.type ? `[${msg.action.type}]` : "";
    const reason = msg.reason || "element not found";
    // A step of another scenario a Switch played: its number is that one's.
    const where = msg.scenarioName ? ` in "${msg.scenarioName}"` : "";
    showToast(`Action ${msg.index + 1}${where} failed ${label} — ${reason}`, "error");
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
