/**
 * playback/steps/dropdown.js — Dropdown: open it with a trusted CDP click (the
 * page's own click where CDP cannot reach the trigger), and with "Choose item #"
 * (action.pick, shared/dropdown-pick.js) choose an item.
 */

import { cssEscape } from '../../../shared/css-escape.js';
import { openDropdownViaCdp } from '../../cdp/dropdown.js';
import { tabMsg } from '../../tabs.js';
import { afterFailure } from './flow.js';
import { pageReplyTimeout } from './page-reply.js';

export async function runDropdown(ctx, i, action) {
  const { tabId } = ctx;
  const cssSel = action.selectors?.css
    || (action.selectors?.id ? `#${cssEscape(action.selectors.id)}` : null)
    || action.selector || '';
  if (action.pick) return _pickItem(ctx, i, action, cssSel);
  if (_cdpCanOpen(action, cssSel)) await openDropdownViaCdp(tabId, cssSel);
  // Like the CDP click, a trigger the page cannot find is not a failure here.
  else if (cssSel) await tabMsg(tabId, { type: 'PLAY_ACTION', action }, pageReplyTimeout(action), action.frameId);
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}

/**
 * CDP evaluates a CSS selector in the top frame only, so a trigger inside a
 * frame, or known only by XPath, is clicked by the page instead.
 */
function _cdpCanOpen(action, cssSel) {
  const inFrame = action.frameId != null && action.frameId !== 0;
  const isXPath = /^[/(]/.test(cssSel);
  return !!cssSel && !isXPath && !inFrame;
}

/**
 * Choose item #: the page sets a native <select> itself (pickStage 'select');
 * any other dropdown answers needsOpen, is opened, and the page then clicks the
 * item once the list shows it (pickStage 'items').
 */
async function _pickItem(ctx, i, action, cssSel) {
  const { tabId, fail } = ctx;
  const toPage = (pickStage) => tabMsg(tabId, { type: 'PLAY_ACTION', action, pickStage }, pageReplyTimeout(action), action.frameId);

  let result = await toPage('select');
  if (!result?.failed && result?.needsOpen) {
    if (_cdpCanOpen(action, cssSel)) await openDropdownViaCdp(tabId, cssSel);
    else await toPage(undefined);
    result = await toPage('items');
  }
  // A page whose content script predates this action answers without choosing.
  if (!result?.failed && !result?.picked) {
    result = { failed: true, error: 'Dropdown: the page did not choose an item — reload the page and try again' };
  }
  if (result.failed) {
    const reason = result._noContentScript ? 'Content script not reachable' : (result.error || 'Dropdown: no item chosen');
    const back = afterFailure(await fail(i, action, reason), i);
    if (back !== null) return back;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
