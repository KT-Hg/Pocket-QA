/**
 * run-state.js — "is something running?", asked the same way everywhere.
 *
 * Two questions, kept apart on purpose: whether any playback is going (a
 * scenario, a sequence or a CSV run), and whether the worker is busy at all —
 * the same plus a recording. Both return the expression's own value, like the
 * inline checks they replace.
 */

import { state } from './state.js';

// Held by runClaimed() from the moment a playback entry point is let in until it returns.
let _claimed = false;

/** A scenario, sequence or CSV run is playing, or an entry point holds the claim. */
export function isAnyPlaybackActive() {
  return _claimed || state.playback.active || state.sequencePlayback.active || state.csvPlayback.active;
}

/** Recording, or any playback. */
export function isBusy() {
  return state.recording || isAnyPlaybackActive();
}

/**
 * Run a playback entry point unless a run is going; false when refused.
 *
 * The claim is taken in the same tick as the check and held until `start`
 * returns. An entry point awaits storage, the tab and the DB guard (over a
 * second) before it marks its run active, and a second Play in that window
 * started a second run. Held to the end, it also keeps a new run from starting
 * while a stopped one is still finishing its current action.
 */
export async function runClaimed(start) {
  if (isAnyPlaybackActive()) return false;
  _claimed = true;
  try {
    await start();
  } finally {
    _claimed = false;
  }
  return true;
}
