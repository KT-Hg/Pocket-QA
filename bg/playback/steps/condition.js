/**
 * playback/steps/condition.js — Condition: if the check fails, skip the next N actions.
 */

import { conditionSkipTarget, conditionSkip } from '../../../shared/switch-blocks.js';
import { tabMsg } from '../../tabs.js';

// How long the page gets to evaluate the condition.
const CHECK_TIMEOUT_MS = 10_000;

export async function runCondition(ctx, i, action) {
  const { tabId, actions, layout: _layout } = ctx;
  const condResult = await tabMsg(tabId, {
    type: 'CHECK_CONDITION',
    conditionType: action.conditionType || 'elementExists',
    selector: action.selector || '',
    selectors: action.selectors || null,
    expectedValue: action.expectedValue || '',
  }, CHECK_TIMEOUT_MS, action.frameId);
  const passed = !!condResult?.result;
  if (!passed) {
    // At least 1 — a stored skipCount of 0 reads as 1 — or 0 for a
    // Condition emptied in the editor (`empty: true`), which skips nothing.
    const skip = conditionSkip(action);
    // A Switch counts as one action together with its block, and a skip
    // landing inside a block goes on to that block's continueAt.
    if (skip > 0) i = _layout ? conditionSkipTarget(actions, i, skip, _layout) - 1 : i + skip;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
