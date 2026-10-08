/**
 * sender.js — who sent a runtime message.
 *
 * The extension's own pages (the popup, the editor, the dbtools manager…) are
 * trusted with any message. A content script runs in its page's renderer, which
 * a hostile page could compromise, so what it sends is data to check rather than
 * a request to carry out as it stands — Chrome's advice for content-script
 * messages. bg/router.js takes only the types a content script sends from a page;
 * the handlers check what those carry.
 */

/** Sent by one of the extension's own pages, not by a content script in a web page. */
export function fromExtensionPage(sender) {
  return String(sender?.url || '').startsWith(chrome.runtime.getURL(''));
}
