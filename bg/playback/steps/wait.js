/**
 * playback/steps/wait.js — Wait: a fixed pause.
 */

import { waitMs } from '../../../shared/wait-ms.js';

export async function runWait(ctx, i, action) {
  await new Promise((resolve) => setTimeout(resolve, waitMs(action)));
  return i;
}
