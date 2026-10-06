/**
 * playback/steps/dropdown.js — Dropdown: open it with a trusted CDP click, and
 * with "Choose item #" (action.pick, shared/dropdown-pick.js) choose an item.
 */

import { openDropdownViaCdp } from '../../cdp/dropdown.js';
import { tabMsg } from '../../tabs.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';
import { pageReplyTimeout } from './page-reply.js';

export async function runDropdown(ctx, i, action) {
  const { tabId } = ctx;
  const cssSel = action.selectors?.css
    || (action.selectors?.id ? `#${CSS.escape(action.selectors.id)}` : null)
    || action.selector || '';
  if (action.pick) return _pickItem(ctx, i, action, cssSel);
  if (cssSel) await openDropdownViaCdp(tabId, cssSel);
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
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
    // CDP evaluates a CSS selector in the top frame only, so a trigger inside a
    // frame, or known only by XPath, is clicked by the page instead.
    const inFrame = action.frameId != null && action.frameId !== 0;
    const isXPath = /^[/(]/.test(cssSel);
    if (cssSel && !isXPath && !inFrame) await openDropdownViaCdp(tabId, cssSel);
    else await toPage(undefined);
    result = await toPage('items');
  }
  // A page whose content script predates this action answers without choosing.
  if (!result?.failed && !result?.picked) {
    result = { failed: true, error: 'Dropdown: the page did not choose an item — reload the page and try again' };
  }
  if (result.failed) {
    const reason = result._noContentScript ? 'Content script not reachable' : (result.error || 'Dropdown: no item chosen');
    const next = await fail(i, action, reason);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
