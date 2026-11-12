/**
 * playback/steps/wait.js — Wait: a fixed pause, ended early by ■ Stop.
 */

import { waitMs } from '../../../shared/wait-ms.js';
import { runPause } from '../../run-state.js';

export async function runWait(ctx, i, action) {
  await runPause(waitMs(action));
  return i;
}
