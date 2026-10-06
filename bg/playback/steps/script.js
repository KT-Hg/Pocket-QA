/**
 * playback/steps/script.js — Script: run JavaScript through CDP (bypasses the page CSP).
 */

import { runScriptViaCdp } from '../../cdp/script.js';

export async function runScript(ctx, i, action) {
  const { tabId } = ctx;
  await runScriptViaCdp(tabId, action.code || '');
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
