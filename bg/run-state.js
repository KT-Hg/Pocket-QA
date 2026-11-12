/**
 * run-state.js — "is something running?", asked the same way everywhere.
 *
 * Two questions, kept apart on purpose: whether any playback is going (a
 * scenario, a sequence or a CSV run), and whether the worker is busy at all —
 * the same plus a recording. Both return the expression's own value, like the
 * inline checks they replace.
 */

import { state } from './state.js';
import { endRunPanel } from './run-panel.js';
import { stepDelayMs } from '../shared/wait-ms.js';

// How often a run's pause looks for ■ Stop (runPause).
const STOP_POLL_MS = 100;
// How long a new run waits for a stopped one to end before it is refused (runClaimed).
const STOP_GRACE_MS = 3_000;

// Held by runClaimed() from the moment a playback entry point is let in until it returns.
let _claimed = false;
// The run holding the claim was stopped (markStopped): it is ending, not starting.
let _stopped = false;
// Settles once the claim is let go.
let _released = Promise.resolve();

/** A scenario, sequence or CSV run is marked as playing: none of them stopped. */
function _playing() {
  return state.playback.active || state.sequencePlayback.active || state.csvPlayback.active;
}

/** A scenario, sequence or CSV run is playing, or an entry point holds the claim. */
export function isAnyPlaybackActive() {
  return _claimed || _playing();
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
 *
 * A run stopped (markStopped) still holds it while it ends its step and cleans
 * up: Play right after ■ Stop waits for that (up to STOP_GRACE_MS) rather than
 * being refused. A second Play while the first is still starting is refused.
 */
export async function runClaimed(start) {
  if (_claimed && _stopped) {
    await Promise.race([_released, new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
  }
  if (isAnyPlaybackActive()) return false;
  _claimed = true;
  _stopped = false;
  let release;
  _released = new Promise((r) => { release = r; });
  state.runVerdict = null; // the badge stops telling the last run's verdict
  try {
    await start();
  } finally {
    _claimed = false;
    endRunPanel(); // the run panel on its page goes with the run
    release();
  }
  return true;
}

/** ■ Stop, wherever it was pressed (popup, run panel, failure prompt), once the flags are cleared. */
export function markStopped() {
  _stopped = _claimed;
}

/**
 * Every pause a run takes — a Wait, a step's delay, the pause between loops,
 * sequence items or CSV rows — ending early once the run is stopped, so a
 * stopped run lets go of its claim soon after ■ Stop. `ms` as stepDelayMs
 * reads it (not a number, or not above 0: no wait).
 * ponytail: polls every STOP_POLL_MS; wake it from the stop handlers if 100 ms ever matters.
 */
export async function runPause(ms) {
  const end = Date.now() + stepDelayMs(ms);
  do await new Promise((r) => setTimeout(r, Math.min(end - Date.now(), STOP_POLL_MS)));
  while (Date.now() < end && _playing());
}
