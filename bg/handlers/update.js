/**
 * handlers/update.js — messages about Web Store update check and apply.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { isBusy } from '../run-state.js';
import { runUpdateCheck, applyUpdate } from '../update-check.js';

export const updateHandlers = {
  /* --- Web Store update check --- */
  CHECK_FOR_UPDATE(request, sender, sendResponse) {
    runUpdateCheck().then(() => chrome.storage.local.get(["updateStatus"], (res) => {
      sendResponse({ updateStatus: res?.updateStatus || null });
    }));
    return true;
  },

  APPLY_UPDATE(request, sender, sendResponse) {
    const busy = isBusy();
    applyUpdate({ busy }).then(sendResponse);
    return true;
  },
};
