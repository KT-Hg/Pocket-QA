/**
 * playback/steps/flow.js — what a step returns when the run must end, and where
 * it goes after its failure prompt.
 */

import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';

/** Returned by a step to end the run, as `break` did in the playback loop. */
export const STOP = Symbol('stop');

/**
 * Where a step goes once the user answered its failure prompt (`next`, from
 * ctx.fail): back to the same action on Retry, STOP on Stop, or null on Skip,
 * when the step carries on with the action's usual tail.
 */
export function afterFailure(next, i) {
  if (next === FAIL_RETRY) return i - 1;
  if (next === FAIL_STOP) return STOP;
  return null;
}
