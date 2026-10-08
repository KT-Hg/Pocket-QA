/**
 * playback/steps/page-target.js — the element an action means, found by the page
 * for a step that acts on it through CDP (Upload File, opening a Dropdown).
 *
 * CDP selects with one CSS selector in the top document. Those steps used to
 * guess it from the action — selectors.css, else #id, else the plain selector —
 * so an XPath or a Name typed in the form found nothing, or another element. The
 * content script finds the element the way every other action does (the chosen
 * selector type first, waiting for it to appear), tags it, and answers with a
 * selector for the tag (content.js MARK_ELEMENT).
 */

import { tabMsg } from '../../tabs.js';
import { pageReplyTimeout } from './page-reply.js';

// Taking the tag off: a short answer, not worth waiting long for.
const UNMARK_TIMEOUT_MS = 2_000;

/**
 * { css } for the element `action` means, { error } when the page found none,
 * or { noPage: true } when no content script answered — the caller then falls
 * back on its own selector. The top frame only: that is where CDP selects.
 */
export async function markTarget(tabId, action) {
  const res = await tabMsg(tabId, {
    type: 'MARK_ELEMENT', selectors: action.selectors, selector: action.selector, timeout: action.timeout,
    ...(action.selectorType ? { selectorType: action.selectorType } : {}),
  }, pageReplyTimeout(action), 0);
  if (res?.css) return { css: res.css };
  if (res?._noContentScript) return { noPage: true };
  return { error: res?.error || 'Element not found' };
}

/** Take the tag markTarget put on the element off again. */
export function unmarkTarget(tabId) {
  return tabMsg(tabId, { type: 'UNMARK_ELEMENT' }, UNMARK_TIMEOUT_MS, 0);
}
