/**
 * handlers/picker.js — messages about the element picker and the tab activation
 * check.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state } from '../state.js';
import { updateBadge } from '../badge.js';
import { sendCaptureNotification } from '../notify.js';
import { takeElementScreenshot } from '../screenshot.js';
import { readCaptureSettings } from '../screenshot/settings.js';

/* --- Element picker passthrough --- */
function pickMode(request, sender, sendResponse) {
  const { type } = request;
  state.pickMode = (type === "START_PICK_MODE");
  updateBadge();
  const tabId = request.tabId || sender.tab?.id;
  if (tabId) chrome.tabs.sendMessage(tabId, request);
  sendResponse({ sent: true });
  return;
}

export const pickerHandlers = {
  /* --- Activation check (for content.js hotkey guard) --- */
  IS_TAB_ACTIVATED(request, sender, sendResponse) {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["activatedTabs"], (res) => {
      const activated = tabId != null && (res.activatedTabs || []).includes(tabId);
      sendResponse({ activated });
    });
    return true;
  },

  START_PICK_MODE: pickMode,
  STOP_PICK_MODE: pickMode,

  /* --- Element picked → reopen popup or trigger element screenshot --- */
  ELEMENT_PICKED(request, sender, sendResponse) {
    state.pickMode = false;
    updateBadge();
    // Routed through sendCaptureNotification rather than chrome.notifications
    // directly: this path used to build its own notification with a 1×1
    // transparent icon and no category, so it was the one capture notification
    // that ignored the Settings toggles entirely. One id for both helpers means a
    // retry replaces the previous notice instead of stacking beside it.
    const _elemShotErr = (msg) => sendCaptureNotification("Element Screenshot", msg, "elemshot");
    chrome.storage.local.get(["elemShotPickPending", "elemShotPickCrop"], (flags) => {
      // The "could not get a selector" case is checked here, before the branch.
      // It used to sit *inside* a branch already guarded by `request.selector`,
      // so it could never run — a pick that yielded no selector fell through to
      // the else and reopened the popup, giving no clue why nothing was captured.
      if (flags.elemShotPickPending && !request.selector && !request.selectors) {
        chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);
        _elemShotErr("Could not get a selector for that element — try picking a different one");
        sendResponse({ received: true });
        return;
      }
      if (flags.elemShotPickPending && request.selector) {
        chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop", "lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId"]);
        const crop = !!flags.elemShotPickCrop;
        const tabId = request.tabId || sender.tab?.id;
        if (!tabId) { _elemShotErr("Lost track of the tab — try the capture again"); return; }
        {
          readCaptureSettings(({ saveMode, prefix }) => {
            // Use takeElementScreenshot so zoom normalization and coordinate re-query run inside CDP session
            takeElementScreenshot(tabId, {
              selector: request.selector, saveMode, prefix, crop, returnBase64: false,
              skipDownload: false, selectors: request.selectors,
            })
              .then((result) => {
                chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
                const _notif = (msg) => sendCaptureNotification("Element Screenshot", msg, "elemshot");
                if (result.error) _notif("Error: " + result.error);
                else if (!crop)   _notif("Saved: " + (result.filename || "screenshot"));
              })
              .catch((e) => _elemShotErr("Error: " + e.message));
          });
        }
      } else {
        chrome.action.openPopup().catch(() => {
          // openPopup() requires a user gesture in MV3 — it fails silently when
          // triggered programmatically (e.g. after an async flow).  Fall back to
          // a badge so the user knows to click the extension icon manually.
          chrome.action.setBadgeText({ text: "✓" });
          chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
        });
      }
    });
    sendResponse({ received: true });
    return;
  },
};
