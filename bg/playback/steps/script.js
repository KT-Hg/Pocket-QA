/**
 * playback/steps/script.js — Script: run JavaScript through CDP (bypasses the page CSP).
 */

import { runScriptViaCdp } from '../../cdp/script.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

export async function runScript(ctx, i, action) {
  const { tabId, fail } = ctx;
  const { error } = await runScriptViaCdp(tabId, action.code || '');
  if (error) {
    const next = await fail(i, action, `Script error: ${error}`);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
