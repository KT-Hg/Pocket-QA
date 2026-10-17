/**
 * playback/steps/page-target.js — the element an action means, found by the page
 * for a step that acts on it through CDP (Upload File, opening a Dropdown).
 *
 * CDP selects with one CSS selector in the top document. Those steps used to
 * guess it from the action — selectors.css, else #id, else the plain selector —
 * so an XPath or a Name typed in the form found nothing, or another element. The
 * content script finds the element the way every other action does (the chosen
 * selector type first, waiting for it to appear), tags it, and answers with a
 * selector for the tag (content.js MARK_ELEMENT). It is asked in the frame the
 * action was recorded in; CDP finds the tag there too when that frame is of the
 * page's origin (cdp/deep-find.js).
 */

import { tabMsg } from '../../tabs.js';
import { pageReplyTimeout } from './page-reply.js';

// Taking the tag off: a short answer, not worth waiting long for.
const UNMARK_TIMEOUT_MS = 2_000;

/**
 * { css } for the element `action` means, { error } when the page found none,
 * { blocked } with the reason when "Click through" is off (`check`:
 * click-through.js strictFor, plus disabledOnly for a file input) and a user
 * could not reach it, or { noPage: true } when no content script answered — the
 * caller then falls back on its own selector. Asked in the action's frame.
 */
export async function markTarget(tabId, action, check = {}) {
  const res = await tabMsg(tabId, {
    type: 'MARK_ELEMENT', selectors: action.selectors, selector: action.selector, timeout: action.timeout,
    ...(action.selectorType ? { selectorType: action.selectorType } : {}), ...check,
  }, pageReplyTimeout(action), action.frameId ?? 0);
  if (res?.css) return { css: res.css };
  if (res?.blocked) return { blocked: res.blocked };
  if (res?._noContentScript) return { noPage: true };
  return { error: res?.error || 'Element not found' };
}

/** Take the tag markTarget put on the element off again, in the frame it was put on in. */
export function unmarkTarget(tabId, frameId = 0) {
  return tabMsg(tabId, { type: 'UNMARK_ELEMENT' }, UNMARK_TIMEOUT_MS, frameId);
}

/** Recorded inside a frame: its frameId (the recording's) is not the page's, 0. */
export const inFrame = (action) => action.frameId != null && action.frameId !== 0;

/** The error of a CDP step that could not find the element the page tagged: a frame of another origin. */
export const OTHER_ORIGIN_FRAME = 'the element is inside a frame of another origin, which this step cannot reach'
  + ' (it works through the page and the frames of its own origin)';
