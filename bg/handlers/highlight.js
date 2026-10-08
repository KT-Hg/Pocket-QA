/**
 * handlers/highlight.js — loading the highlight engine into a page, and saving
 * a page's text highlights.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { HIGHLIGHTS_KEY, HIGHLIGHT_PATTERNS_KEY } from '../../shared/storage-keys.js';
import { runExclusive } from '../storage.js';
import { fromExtensionPage } from '../sender.js';

/**
 * The key a page's highlights go under, as content-highlight.js works it out
 * (_hlCanonicalUrl): the URL without its fragment, unless the fragment is a route
 * (#/… or #!…). A copy — that file is a classic script and cannot import it.
 */
function _canonicalPageUrl(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  if (i === -1) return s;
  const first = s[i + 1];
  return (first === '/' || first === '!') ? s : s.slice(0, i);
}

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
      // From a web page, only its own highlights: its own URL, or a pattern the
      // user grouped pages under (content-highlight.js _hlNormalizeUrl). A
      // compromised renderer could otherwise overwrite any page's.
      if (!fromExtensionPage(sender) && url !== _canonicalPageUrl(sender?.url)) {
        const patterns = (await chrome.storage.local.get(HIGHLIGHT_PATTERNS_KEY))[HIGHLIGHT_PATTERNS_KEY] || [];
        if (!patterns.includes(url)) { sendResponse({ ok: false }); return; }
      }
      const all = (await chrome.storage.local.get(HIGHLIGHTS_KEY))[HIGHLIGHTS_KEY] || {};
      all[url] = list;
      await chrome.storage.local.set({ [HIGHLIGHTS_KEY]: all });
      sendResponse({ ok: true });
    });
    return true;
  },
};
