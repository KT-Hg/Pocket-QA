/**
 * handlers/highlight.js — saving a page's text highlights.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { HIGHLIGHTS_KEY } from '../../shared/storage-keys.js';
import { runExclusive } from '../storage.js';

export const highlightHandlers = {
  /**
   * One page's highlights into the store every page shares. The content script
   * used to read the whole store, change its page and write it all back; two
   * tabs doing that at once each wrote their own copy, and one tab's highlights
   * were lost. Here every save waits for the one before it.
   */
  HL_SAVE_PAGE(request, sender, sendResponse) {
    const { url, list } = request;
    if (typeof url !== 'string' || !url || !Array.isArray(list)) {
      sendResponse({ ok: false });
      return;
    }
    runExclusive(async () => {
      const all = (await chrome.storage.local.get(HIGHLIGHTS_KEY))[HIGHLIGHTS_KEY] || {};
      all[url] = list;
      await chrome.storage.local.set({ [HIGHLIGHTS_KEY]: all });
      sendResponse({ ok: true });
    });
    return true;
  },
};
