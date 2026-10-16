/**
 * handlers/highlight.js — loading the highlight engine into a page, and editing
 * a page's text highlights.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { HIGHLIGHTS_KEY, HIGHLIGHT_PATTERNS_KEY } from '../../shared/storage-keys.js';
import { hlCanonicalUrl, validHighlightOps, applyHighlightOps } from '../../shared/highlight-store.js';
import { runExclusive } from '../storage.js';
import { fromExtensionPage } from '../sender.js';

export const highlightHandlers = {
  /**
   * The highlight engine into the frame that asks for it: content.js does while
   * highlighting is on. It is not in the manifest, so a page with highlighting
   * off never loads it.
   */
  HL_LOAD(request, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return;
    // The document that asked (Chrome 106+), not whatever its frame shows by the
    // time the script lands; content-highlight.js skips a document without
    // content.js anyway, but this way it is never offered one.
    const target = sender.documentId
      ? { tabId, documentIds: [sender.documentId] }
      : { tabId, frameIds: [sender.frameId ?? 0] };
    chrome.scripting.executeScript({ target, files: ['content-highlight.js'] })
      .catch(() => { /* the frame navigated away or closed: nothing to load into */ });
  },

  /**
   * Edits to one page's highlights (shared/highlight-store.js), applied to the
   * store as it is now and one at a time. Pages and the popup used to send the
   * whole list they had read; two tabs on one page, or a page saving while the
   * popup had the store open, each wrote back their own copy and one lost.
   */
  HL_EDIT(request, sender, sendResponse) {
    const { url, ops } = request;
    if (typeof url !== 'string' || !url || !validHighlightOps(ops)) {
      sendResponse({ ok: false });
      return;
    }
    runExclusive(async () => {
      // From a web page, only its own highlights: its own URL, or a pattern the
      // user grouped pages under (content-highlight.js _hlNormalizeUrl). A
      // compromised renderer could otherwise change any page's.
      if (!fromExtensionPage(sender) && url !== hlCanonicalUrl(sender?.url)) {
        const patterns = (await chrome.storage.local.get(HIGHLIGHT_PATTERNS_KEY))[HIGHLIGHT_PATTERNS_KEY] || [];
        if (!patterns.includes(url)) { sendResponse({ ok: false }); return; }
      }
      const all = (await chrome.storage.local.get(HIGHLIGHTS_KEY))[HIGHLIGHTS_KEY] || {};
      await chrome.storage.local.set({ [HIGHLIGHTS_KEY]: applyHighlightOps(all, url, ops) });
      sendResponse({ ok: true });
    });
    return true;
  },
};
