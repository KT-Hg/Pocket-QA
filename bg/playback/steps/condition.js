/**
 * playback/steps/condition.js — Condition: if the check fails, skip the next N actions.
 */

import { conditionSkipTarget, conditionSkip } from '../../../shared/switch-blocks.js';
import { tabMsg } from '../../tabs.js';
import { afterFailure } from './flow.js';

// How long the page gets to evaluate the condition.
const CHECK_TIMEOUT_MS = 10_000;

export async function runCondition(ctx, i, action) {
  const { tabId, actions, fail, layout: _layout } = ctx;
  const condResult = await tabMsg(tabId, {
    type: 'CHECK_CONDITION',
    conditionType: action.conditionType || 'elementExists',
    selector: action.selector || '',
    selectors: action.selectors || null,
    expectedValue: action.expectedValue || '',
    // Tried first, as an action tries it (content.js locateNow).
    ...(action.selectorType ? { selectorType: action.selectorType } : {}),
  }, CHECK_TIMEOUT_MS, action.frameId);
  let passed = !!condResult?.result;
  // The page could not evaluate it (an unknown type, an exception): neither true
  // nor false. Skip leaves the guarded actions to run, as they always did then.
  if (condResult?.error) {
    const back = afterFailure(await fail(i, action, `Condition: ${condResult.error}`), i);
    if (back !== null) return back;
    passed = true;
  }
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
