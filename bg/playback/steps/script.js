/**
 * playback/steps/script.js — Script: run JavaScript through CDP (bypasses the page CSP).
 */

import { runScriptViaCdp } from '../../cdp/script.js';
import { afterFailure } from './flow.js';

export async function runScript(ctx, i, action) {
  const { tabId, fail } = ctx;
  const { error } = await runScriptViaCdp(tabId, action.code || '');
  if (error) {
    const back = afterFailure(await fail(i, action, `Script error: ${error}`), i);
    if (back !== null) return back;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
