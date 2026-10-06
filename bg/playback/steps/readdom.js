/**
 * playback/steps/readdom.js — Read DOM: a value from the page into a variable.
 */

import { normalizeVarName, writtenVarNames } from '../../../shared/var-name.js';
import { extractWithPattern, patternMismatch } from '../../../shared/text-pattern.js';
import { tabMsg } from '../../tabs.js';
import { pageReplyTimeout } from './page-reply.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

export async function runReadDom(ctx, i, action) {
  const { tabId, fail, resolvedVars, stickFallbacks: _stickFallbacks } = ctx;
  // `${abc}` saved by older versions of the form is read as `abc`.
  const rdVar    = normalizeVarName(action.varName);
  const rdResult = await tabMsg(tabId, { type: 'PLAY_ACTION', action }, pageReplyTimeout(action), action.frameId);
  _stickFallbacks(rdResult);
  let rdFailed = !!rdResult?.failed;
  let rdError  = rdResult?.error || null;
  if (rdResult?.value !== undefined && !rdFailed) {
    // Extract pattern: each ${name} takes its part of the text (shared/text-pattern.js).
    const parts = action.pattern
      ? extractWithPattern(rdResult.value, action.pattern, { matchCase: !!action.matchCase })
      : {};
    if (parts) {
      if (rdVar) resolvedVars[rdVar] = rdResult.value;
      Object.assign(resolvedVars, parts);
    } else {
      rdFailed = true;
      rdError  = patternMismatch(rdResult.value, action.pattern);
    }
  }
  if (rdFailed) {
    const next = await fail(i, action, rdError);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
    // Skipped: in a looped run the variables would otherwise still hold the
    // previous iteration's values and later steps would use them silently.
    for (const n of writtenVarNames(action)) resolvedVars[n] = '';
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
