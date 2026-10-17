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
import { markTarget, unmarkTarget } from './page-target.js';
import { strictFor } from './click-through.js';

export async function runDropdown(ctx, i, action) {
  const { tabId } = ctx;
  const cssSel = action.selectors?.css
    || (action.selectors?.id ? `#${cssEscape(action.selectors.id)}` : null)
    || action.selector || '';
  if (action.pick) return _pickItem(ctx, i, action, cssSel);
  // Like the CDP click, a trigger the page cannot find is not a failure here;
  // one a user could not reach, with "Click through" off, is.
  if (cssSel) {
    const blocked = await _open(ctx, action, cssSel,
      () => tabMsg(tabId, { type: 'PLAY_ACTION', action, ...strictFor(ctx, action) }, pageReplyTimeout(action), action.frameId));
    if (blocked) {
      const back = afterFailure(await ctx.fail(i, action, blocked), i);
      if (back !== null) return back;
    }
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}

/**
 * Open the dropdown with a trusted CDP click on the trigger the page found
 * (page-target.js), in the action's frame — CDP reaches the page and the frames
 * of its origin. With no page to ask, CDP on the action's own CSS selector. Where
 * CDP finds nothing (a frame of another origin, a trigger known only by XPath),
 * `pageClick`: the page's own click. A trigger the page looked for and did not
 * find is left alone. Resolves to the reason when "Click through" is off and a
 * user could not reach the trigger (nothing is clicked then), else null.
 */
async function _open(ctx, action, cssSel, pageClick) {
  const { tabId } = ctx;
  const target = await markTarget(tabId, action, strictFor(ctx, action));
  if (target.blocked) return target.blocked;
  if (target.error) return null;
  const css = target.css || (cssSel && !/^[/(]/.test(cssSel) ? cssSel : null);
  let opened = false;
  if (css) {
    try {
      opened = await openDropdownViaCdp(tabId, css);
    } finally {
      if (target.css) await unmarkTarget(tabId, action.frameId);
    }
  }
  if (opened) return null;
  const res = await pageClick();
  return res?.blocked ? res.error : null;
}

/**
 * Choose item #: the page sets a native <select> itself (pickStage 'select');
 * any other dropdown answers needsOpen, is opened, and the page then clicks the
 * item once the list shows it (pickStage 'items').
 */
async function _pickItem(ctx, i, action, cssSel) {
  const { tabId, fail } = ctx;
  const toPage = (pickStage) => tabMsg(tabId, { type: 'PLAY_ACTION', action, pickStage, ...strictFor(ctx, action) },
    pageReplyTimeout(action), action.frameId);

  let result = await toPage('select');
  if (!result?.failed && result?.needsOpen) {
    const blocked = await _open(ctx, action, cssSel, () => toPage(undefined));
    result = blocked ? { failed: true, error: blocked } : await toPage('items');
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
