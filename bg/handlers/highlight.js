/**
 * handlers/highlight.js — loading the highlight engine into a page, and saving
 * a page's text highlights.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { HIGHLIGHTS_KEY } from '../../shared/storage-keys.js';
import { runExclusive } from '../storage.js';

export const highlightHandlers = {
  /**
   * The highlight engine into the frame that asks for it: content.js does while
   * highlighting is on. It is not in the manifest, so a page with highlighting
   * off never loads it.
   */
  HL_LOAD(request, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return;
    chrome.scripting.executeScript({ target: { tabId, frameIds: [sender.frameId ?? 0] }, files: ['content-highlight.js'] })
      .catch(() => { /* the frame navigated away or closed: nothing to load into */ });
  },

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
