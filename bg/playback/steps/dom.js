/**
 * playback/steps/dom.js — every other action: played by the content script.
 */

import { tabMsg, getTabUrl, waitForTabLoad } from '../../tabs.js';
import { pageReplyTimeout } from './page-reply.js';
import { afterFailure } from './flow.js';
import { strictFor } from './click-through.js';

// A click or select that navigated: how long the new page gets to load.
const NAV_LOAD_TIMEOUT_MS = 15_000;

export async function runOnPage(ctx, i, action) {
  const { tabId, fail, stickFallbacks: _stickFallbacks } = ctx;
  const _isClickLike  = action.type === 'click' || action.type === 'select';
  const preActionUrl  = _isClickLike ? await getTabUrl(tabId).catch(() => null) : null;

  const result = await tabMsg(tabId, { type: 'PLAY_ACTION', action, ...strictFor(ctx, action) }, pageReplyTimeout(action), action.frameId);

  _stickFallbacks(result);

  // If a click/select caused an immediate navigation, the content script may
  // have become unreachable before it could send a response.  Detect this by
  // comparing the URL before and after — if it changed, treat the action as
  // successful and wait for the new page to finish loading.
  if (_isClickLike && result?._noContentScript && preActionUrl !== null) {
    const postClickUrl = await getTabUrl(tabId).catch(() => null);
    if (postClickUrl !== null && postClickUrl !== preActionUrl) {
      await waitForTabLoad(tabId, NAV_LOAD_TIMEOUT_MS);
      if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
      return i;
    }
  }

  if (result?.failed) {
    const reason = result._noContentScript ? 'Content script not reachable' : (result.error || 'Action failed');
    const back = afterFailure(await fail(i, action, reason), i);
    if (back !== null) return back;
  }

  // For succeeded click/select, also check for post-action navigation
  // (e.g. form submit that navigates rather than using AJAX).
  if (preActionUrl !== null && !result?.failed) {
    const postActionUrl = await getTabUrl(tabId).catch(() => null);
    if (postActionUrl !== null && postActionUrl !== preActionUrl) {
      await waitForTabLoad(tabId, NAV_LOAD_TIMEOUT_MS);
    }
  }

  if (action.delay && action.delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, action.delay));
  }
  return i;
}
